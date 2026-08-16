import type { FilterNode, Group } from '@lyraflow/core/segments/ast.js'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { TreeEditor } from './TreeEditor.js'

const trait = (key: string): FilterNode => ({ kind: 'trait', key, operator: '=', value: 'x' })
const group = (...children: FilterNode[]): Group => ({ kind: 'group', op: 'and', children })

/** The root `onChange` was last called with -- `mock.calls[0][0]` alone is
 * `possibly undefined` to `tsc -b` (an empty-array read), so every test
 * below goes through this instead of repeating a guard. Throws with a
 * clear message rather than letting a later assertion fail on `undefined`
 * for a genuinely different reason (onChange never firing at all). */
function lastRoot(onChange: Mock): Group {
  const call = onChange.mock.calls.at(-1)
  if (!call) throw new Error('onChange was not called')
  return call[0] as Group
}

describe('TreeEditor', () => {
  it('renders a group as a card whose header carries one operator', () => {
    render(<TreeEditor value={group(trait('a'), trait('b'))} onChange={vi.fn()} />)
    const card = screen.getByTestId('group-')
    expect(within(card).getByRole('combobox', { name: /match/i })).toHaveValue('and')
  })

  it('nests a child group inside its parent card', () => {
    render(<TreeEditor value={group(trait('a'), group(trait('b')))} onChange={vi.fn()} />)
    const outer = screen.getByTestId('group-')
    expect(within(outer).getByTestId('group-1')).toBeInTheDocument()
  })

  it('removing a condition leaves its siblings in order', async () => {
    const onChange = vi.fn()
    render(<TreeEditor value={group(trait('a'), trait('b'), trait('c'))} onChange={onChange} />)
    await userEvent.click(
      within(screen.getByTestId('condition-1')).getByRole('button', { name: /remove/i }),
    )
    const next = lastRoot(onChange)
    expect(next.children.map((c) => (c as { key: string }).key)).toEqual(['a', 'c'])
  })

  it('editing one condition does not touch its sibling', async () => {
    // The defect class for a recursive editor. A shared handler that closes
    // over the wrong index edits the neighbour, and a test with one child
    // cannot see it.
    const onChange = vi.fn()
    render(<TreeEditor value={group(trait('a'), trait('b'))} onChange={onChange} />)
    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
    )
    const next = lastRoot(onChange)
    expect(next.children[0]?.kind).toBe('not')
    expect(next.children[1]).toEqual(trait('b'))
  })

  it('negating a nested condition applies at its own level, not its parent', async () => {
    const onChange = vi.fn()
    render(<TreeEditor value={group(group(trait('a')))} onChange={onChange} />)
    await userEvent.click(
      within(screen.getByTestId('condition-0-0')).getByRole('button', { name: /negate/i }),
    )
    const next = lastRoot(onChange)
    expect(next.kind).toBe('group')
    expect(next.children[0]?.kind).toBe('group')
    expect((next.children[0] as Group).children[0]?.kind).toBe('not')
  })

  // --- Controller correction 1: the root is not necessarily a group -------

  describe('normalising a non-group root', () => {
    it('wraps a bare condition root in a one-child group rather than crashing', () => {
      // A segment authored by the CLI can legally have a bare trait (or
      // context/lifecycle/behavior/not) at its root -- SegmentQuery.filter
      // is the whole FilterNode union, not just Group. The plan's own Step
      // 3 text ("renders the root through GroupCard") assumed a group;
      // this is the fix, at the one place a tree enters the editor.
      // `trait('z')`, not `trait('a')` -- a distinct key from every other
      // fixture in this file, so this can't coincidentally pass against a
      // stub that happens to hardcode 'a'/'b' as its own placeholder text.
      render(<TreeEditor value={trait('z')} onChange={vi.fn()} />)
      expect(screen.getByTestId('group-')).toBeInTheDocument()
      // Task 5 replaced the placeholder leaf (a `summarise` text span) with
      // a real `TraitForm`, whose fields don't concatenate into "z = x" as
      // DOM text content -- an `<input>`'s `value` is never a text node.
      // Reading each field back through its own control pins the same
      // fact this test always meant to pin: a bare-trait root normalises
      // and reaches the leaf with its data intact.
      const condition = within(screen.getByTestId('condition-0'))
      expect(condition.getByRole('textbox', { name: /key/i })).toHaveValue('z')
      expect(condition.getByRole('combobox', { name: /operator/i })).toHaveValue('=')
      expect(condition.getByRole('textbox', { name: /^value$/i })).toHaveValue('x')
    })

    it('edits inside a normalised root reach the server root wrapped, not bare', async () => {
      const onChange = vi.fn()
      render(<TreeEditor value={trait('a')} onChange={onChange} />)
      await userEvent.click(
        within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
      )
      const next = lastRoot(onChange)
      expect(next).toEqual({
        kind: 'group',
        op: 'and',
        children: [{ kind: 'not', child: trait('a') }],
      })
    })

    it('removing the only condition of a normalised root leaves the legal empty-root shape', async () => {
      // Controller correction 2: removeAt returns an empty root GROUP for
      // the root case, not null or a collapse -- and that must hold even
      // when the root only became a group via this screen's own
      // normalisation, not because the operator authored one.
      const onChange = vi.fn()
      render(<TreeEditor value={trait('a')} onChange={onChange} />)
      await userEvent.click(
        within(screen.getByTestId('condition-0')).getByRole('button', { name: /remove/i }),
      )
      const next = lastRoot(onChange)
      expect(next).toEqual({ kind: 'group', op: 'and', children: [] })
    })

    it('renders an empty root without crashing, still offering Add condition', () => {
      render(<TreeEditor value={{ kind: 'group', op: 'and', children: [] }} onChange={vi.fn()} />)
      expect(screen.getByTestId('group-')).toBeInTheDocument()
      expect(screen.queryByTestId(/^condition-/)).toBeNull()
      expect(screen.getByRole('button', { name: /add condition/i })).toBeEnabled()
    })
  })

  // --- Group-level controls: the brief's given tests only exercise leaf
  // negate/remove through ConditionRow. GroupCard owns its own Remove and
  // Negate for a nested group, addressed at the group's own path -- these
  // pin that those don't leak into a sibling either, the same defect class
  // one level up. ---------------------------------------------------------

  describe('group-level remove and negate', () => {
    it('removing a nested group removes only that subtree, leaving its outer sibling untouched', async () => {
      const onChange = vi.fn()
      render(
        <TreeEditor value={group(trait('a'), group(trait('b'), trait('c')))} onChange={onChange} />,
      )
      // Scoped to the group's OWN controls testid, not the whole card --
      // the card also contains descendant leaves with their own
      // Remove/Negate, which would otherwise make this query ambiguous.
      const controls = screen.getByTestId('group-1-controls')
      await userEvent.click(within(controls).getByRole('button', { name: /remove/i }))
      const next = lastRoot(onChange)
      expect(next.children.map((c) => (c as { key: string }).key)).toEqual(['a'])
    })

    it('negating a nested group wraps only that group, leaving a sibling group untouched', async () => {
      const onChange = vi.fn()
      render(<TreeEditor value={group(group(trait('a')), group(trait('b')))} onChange={onChange} />)
      const controls = screen.getByTestId('group-0-controls')
      await userEvent.click(within(controls).getByRole('button', { name: /negate/i }))
      const next = lastRoot(onChange)
      expect(next.children[0]?.kind).toBe('not')
      // The untouched sibling group is unchanged, including its own child.
      expect(next.children[1]).toEqual(group(trait('b')))
    })

    it('disables Add condition and Add group while a group is negated, since insertAt cannot target a not wrapper', () => {
      const negatedRoot: FilterNode = {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'not', child: group(trait('a')) }],
      }
      render(<TreeEditor value={negatedRoot} onChange={vi.fn()} />)
      const nested = screen.getByTestId('group-0')
      expect(within(nested).getByRole('button', { name: /add condition/i })).toBeDisabled()
      expect(within(nested).getByRole('button', { name: /add group/i })).toBeDisabled()
    })
  })

  // --- Same local index, different depth: the sharpest form of "shape the
  // brief's tests have in common" -- every given fixture has at most ONE
  // leaf at any given local child index, so a testid (or key) computed from
  // the LOCAL index alone, rather than the full path, would still pass all
  // five. This fixture puts a leaf at local index 0 in the ROOT'S OWN
  // children and a second leaf at local index 0 in a NESTED group's
  // children -- colliding under local-index-only addressing, disambiguated
  // by path. -------------------------------------------------------------

  it('addresses leaves at the same local index but different depth independently', async () => {
    const onChange = vi.fn()
    render(<TreeEditor value={group(trait('a'), group(trait('b')))} onChange={onChange} />)
    // Both exist, distinctly -- a local-index-only scheme would collide
    // these into one ambiguous "condition-0".
    const outer = screen.getByTestId('condition-0')
    const inner = screen.getByTestId('condition-1-0')
    expect(outer).not.toBe(inner)
    await userEvent.click(within(inner).getByRole('button', { name: /negate/i }))
    const next = lastRoot(onChange)
    // The OUTER leaf (root's own local index 0) is untouched...
    expect(next.children[0]).toEqual(trait('a'))
    // ...and the INNER leaf (nested group's local index 0) is the one negated.
    expect((next.children[1] as Group).children[0]?.kind).toBe('not')
  })

  // --- Add condition / Add group wire insertAt end to end, not just as a
  // tree.ts unit. --------------------------------------------------------

  it('Add condition appends a new leaf to the addressed group, at the end', async () => {
    const onChange = vi.fn()
    render(<TreeEditor value={group(trait('a'))} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    const next = lastRoot(onChange)
    expect(next.children).toHaveLength(2)
    expect(next.children[0]).toEqual(trait('a'))
    expect(next.children[1]?.kind).toBe('trait')
  })

  it('Add group appends a new nested group seeded with one condition, never empty', async () => {
    // Controller ruling (fix round 1): a group with zero children is not a
    // state this editor should be able to produce -- it violates the AST's
    // `children.min(1)` the instant it exists, before the operator has done
    // anything wrong. Seeded with the SAME default condition "Add
    // condition" itself inserts, so the two controls agree.
    const onChange = vi.fn()
    render(<TreeEditor value={group(trait('a'))} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /add group/i }))
    const next = lastRoot(onChange)
    expect(next.children).toHaveLength(2)
    expect(next.children[1]).toEqual({
      kind: 'group',
      op: 'and',
      children: [{ kind: 'trait', key: '', operator: '=', value: '' }],
    })
  })

  it('the group Add group inserts never has an empty children array, matching the AST', async () => {
    // A second, independent pin on the same rule -- phrased as a direct
    // shape check rather than an exact-equality snapshot, so it still
    // catches a future change to the default condition's own shape that
    // `toEqual` above would otherwise also flag as a failure for the wrong
    // reason.
    const onChange = vi.fn()
    render(<TreeEditor value={group(trait('a'))} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: /add group/i }))
    const next = lastRoot(onChange)
    const nested = next.children[1] as Group
    expect(nested.kind).toBe('group')
    expect(nested.children.length).toBeGreaterThan(0)
  })

  it('changing the Match operator replaces op without touching children', async () => {
    const onChange = vi.fn()
    render(<TreeEditor value={group(trait('a'), trait('b'))} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /match/i }), 'or')
    const next = lastRoot(onChange)
    expect(next.op).toBe('or')
    expect(next.children).toEqual([trait('a'), trait('b')])
  })
})
