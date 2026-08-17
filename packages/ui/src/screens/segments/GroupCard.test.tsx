import type { FilterNode, Group } from '@lyraflow/core/segments/ast.js'
import {
  MAX_BEHAVIOR_NODES,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
} from '@lyraflow/core/segments/validate.js'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { GroupCard } from './GroupCard.js'

// The behaviour-cap fixtures below render REAL `behavior` leaves, each of
// which mounts a real `BehaviourForm` -> `EventCombobox`, whose debounced
// effect calls `client.schemaEvents` even with a non-empty seeded `value`
// (an earlier `{}` stub here left this throwing
// "schemaEvents is not a function" as an uncaught async exception once
// those fixtures existed, since none of the OTHER fixtures in this file
// ever reached a behavior leaf).
const client = {
  schemaEvents: vi.fn(async () => []),
  schemaProperties: vi.fn(async () => []),
} as unknown as ApiClient
const projectId = 1

const trait = (key: string): FilterNode => ({ kind: 'trait', key, operator: '=', value: 'x' })
const behavior = (event: string): FilterNode => ({
  kind: 'behavior',
  event,
  aggregate: 'count',
  window: { kind: 'last', n: 1, unit: 'days' },
  operator: '>=',
  value: 1,
})

/** A flat root with `n` trait leaves -- `countNodes` = `n + 1` (the root
 * group itself counts too, `tree.ts`'s own doc comment on `countNodes`). */
function flatRoot(n: number): Group {
  return { kind: 'group', op: 'and', children: Array.from({ length: n }, (_, i) => trait(`k${i}`)) }
}

function flatBehaviorRoot(n: number): Group {
  return {
    kind: 'group',
    op: 'and',
    children: Array.from({ length: n }, (_, i) => behavior(`e${i}`)),
  }
}

/** A chain of single-child groups, `depth` levels deep (root at depth 0),
 * bottoming out in one trait leaf -- the deepest legal shape for a given
 * `depth`: the leaf itself sits at `depth`, which must stay `< MAX_TREE_DEPTH`
 * for the whole tree to be legal at all. */
function chain(depth: number): Group {
  let node: FilterNode = trait('leaf')
  for (let d = depth; d > 0; d--) {
    node = { kind: 'group', op: 'and', children: [node] }
  }
  return node as Group
}

function pathToDeepestGroup(root: Group): number[] {
  const path: number[] = []
  let node: FilterNode = root
  while (
    node.kind === 'group' &&
    node.children.length === 1 &&
    node.children[0]?.kind === 'group'
  ) {
    path.push(0)
    node = node.children[0]
  }
  return path
}

/** Two leaves at the root and two more inside a nested group, so every
 * assertion below has a SIBLING to be confused with and a path with more
 * than one segment in it. A flat two-child root would let "removes the right
 * child" pass on an implementation that always removed the last one. */
function nestedRoot(): Group {
  return {
    kind: 'group',
    op: 'and',
    children: [trait('k0'), { kind: 'group', op: 'and', children: [trait('k10'), trait('k11')] }],
  }
}

describe('GroupCard -- the child callbacks it builds', () => {
  // This file used to pass 9/9 against a `ConditionRow` replaced by a
  // component that renders a plausible row and calls nothing: the testid, a
  // `Not` badge, static text, and Negate/Remove buttons wired to nothing. So
  // none of it exercised the `onChange`/`onRemove`/`onNegate` closures
  // GroupCard itself builds and hands to each leaf -- that wiring was pinned
  // only in `TreeEditor.test.tsx`, one level up, by accident of where the
  // tests happened to be written. A later change to those three closures
  // could therefore go red only in a file whose name does not mention
  // GroupCard. The three tests below drive each closure through the DOM and
  // assert on the whole new root it produces.
  //
  // Each leaf is addressed through its `condition-<path>` testid rather than
  // by accessible name: the nested group's own Negate/Remove (its
  // `group-1-controls` wrapper) and both of its leaves' Negate/Remove live
  // inside the same card, so an unscoped `getByRole('button', { name:
  // /negate/i })` is ambiguous the moment a card has children.

  it("a leaf's Remove removes that leaf and nothing else, at its own nested path", async () => {
    const onChange = vi.fn()
    render(
      <GroupCard
        root={nestedRoot()}
        path={[]}
        onChange={onChange}
        client={client}
        projectId={projectId}
      />,
    )
    const row = within(screen.getByTestId('condition-1-0'))
    await userEvent.click(row.getByRole('button', { name: /^remove$/i }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as Group
    expect(next.children[0]).toEqual(trait('k0'))
    const nested = next.children[1] as Group
    expect(nested.children).toEqual([trait('k11')])
  })

  it("a leaf's Negate wraps that leaf in `not`, leaving its sibling and its parent alone", async () => {
    const onChange = vi.fn()
    render(
      <GroupCard
        root={nestedRoot()}
        path={[]}
        onChange={onChange}
        client={client}
        projectId={projectId}
      />,
    )
    const row = within(screen.getByTestId('condition-1-1'))
    await userEvent.click(row.getByRole('button', { name: /^negate$/i }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as Group
    expect(next.children[0]).toEqual(trait('k0'))
    const nested = next.children[1] as Group
    // The negation lands on the leaf that was clicked -- not on its sibling,
    // and not on the group that contains them both.
    expect(nested.kind).toBe('group')
    expect(nested.children[0]).toEqual(trait('k10'))
    expect(nested.children[1]).toEqual({ kind: 'not', child: trait('k11') })
  })

  it("a leaf's own edit replaces that leaf in place, and hands back the whole new root", async () => {
    const onChange = vi.fn()
    render(
      <GroupCard
        root={nestedRoot()}
        path={[]}
        onChange={onChange}
        client={client}
        projectId={projectId}
      />,
    )
    const row = within(screen.getByTestId('condition-1-0'))
    await userEvent.selectOptions(row.getByRole('combobox', { name: /operator/i }), '!=')

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as Group
    // A whole new root, not the edited leaf on its own -- the caller above
    // GroupCard replaces its entire tree with whatever arrives here.
    expect(next.kind).toBe('group')
    expect(next.children[0]).toEqual(trait('k0'))
    const nested = next.children[1] as Group
    expect(nested.children[0]).toEqual({ ...trait('k10'), operator: '!=' })
    expect(nested.children[1]).toEqual(trait('k11'))
  })
})

describe('GroupCard -- the three server-side caps', () => {
  // --- MAX_TREE_NODES: global, so checked identically at any depth -----

  // Rendering MAX_TREE_NODES - 1 real leaves (each a full TraitForm) is
  // slow in jsdom -- comfortably under 5s in isolation but occasionally over
  // the default 5000ms budget under this box's own documented contention. A
  // longer per-test timeout, not a smaller fixture: the fixture size IS the
  // thing under test (the exact boundary value), here and below.
  it('disables Add condition and Add group at the node cap, and says the limit', () => {
    const root = flatRoot(MAX_TREE_NODES - 1) // countNodes === MAX_TREE_NODES exactly
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    const add = screen.getByRole('button', { name: /^add condition$/i })
    const addGroup = screen.getByRole('button', { name: /^add group$/i })
    expect(add).toBeDisabled()
    expect(addGroup).toBeDisabled()
    expect(screen.getByText(new RegExp(String(MAX_TREE_NODES)))).toBeInTheDocument()
  }, 15000)

  it('one below the node cap: Add condition (costs 1 node) is enabled, Add group (costs 2) is not', () => {
    // The off-by-one this has to get right: at
    // MAX_TREE_NODES - 1 total nodes, one more leaf still fits (reaches
    // the cap exactly, which validateTree allows) but a group -- which
    // costs itself PLUS its seeded child, `newGroup`'s own doc comment --
    // would not.
    const root = flatRoot(MAX_TREE_NODES - 2) // countNodes === MAX_TREE_NODES - 1
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    expect(screen.getByRole('button', { name: /^add condition$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^add group$/i })).toBeDisabled()
  }, 15000)

  it('clicking a node-capped Add condition never calls onChange', async () => {
    const onChange = vi.fn()
    const root = flatRoot(MAX_TREE_NODES - 1)
    render(
      <GroupCard root={root} path={[]} onChange={onChange} client={client} projectId={projectId} />,
    )
    await userEvent.click(screen.getByRole('button', { name: /^add condition$/i }))
    expect(onChange).not.toHaveBeenCalled()
  }, 15000)

  // --- MAX_TREE_DEPTH: local to the group's own position ----------------

  it('disables Add condition and Add group on a group whose own depth is at the cap, and says so', () => {
    // A group at depth MAX_TREE_DEPTH - 1 (9): a new LEAF from "Add
    // condition" would sit at depth 10, which validateTree's own
    // `depth >= MAX_TREE_DEPTH` check refuses. Built directly at this
    // depth rather than reached by clicking through, since a real group
    // this deep with a legal child could never itself be constructed by
    // the builder (that child would already be illegal) -- this pins the
    // DISABLE logic against the boundary value itself, however the tree
    // came to be there (e.g. a CLI-authored segment already at the edge).
    const deepGroup: Group = { kind: 'group', op: 'and', children: [trait('leaf')] }
    const path = Array.from({ length: MAX_TREE_DEPTH - 1 }, () => 0)
    let root: FilterNode = deepGroup
    for (let i = 0; i < MAX_TREE_DEPTH - 1; i++) {
      root = { kind: 'group', op: 'and', children: [root] }
    }
    render(
      <GroupCard
        root={root}
        path={path}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
      />,
    )
    const testId = `group-${path.join('-')}`
    const card = within(screen.getByTestId(testId))
    expect(card.getByRole('button', { name: /^add condition$/i })).toBeDisabled()
    expect(card.getByRole('button', { name: /^add group$/i })).toBeDisabled()
    expect(card.getByText(new RegExp(String(MAX_TREE_DEPTH)))).toBeInTheDocument()
  })

  it('one level shallower: Add condition (adds 1 level) is enabled, Add group (adds 2) is not', () => {
    // A group at depth MAX_TREE_DEPTH - 2 (8): "Add condition" puts a leaf
    // at depth 9 -- the deepest LEGAL node overall -- so it must stay
    // enabled. "Add group" puts its own new group at depth 9 AND that
    // group's seeded child at depth 10, which is illegal, so it must not.
    const root = chain(MAX_TREE_DEPTH - 1)
    const path = pathToDeepestGroup(root)
    expect(path).toHaveLength(MAX_TREE_DEPTH - 2)
    render(
      <GroupCard
        root={root}
        path={path}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
      />,
    )
    const testId = `group-${path.join('-')}`
    const card = within(screen.getByTestId(testId))
    expect(card.getByRole('button', { name: /^add condition$/i })).toBeEnabled()
    expect(card.getByRole('button', { name: /^add group$/i })).toBeDisabled()
  })

  it("a shallow group's own Add controls are unaffected by a DIFFERENT branch being at the depth cap", () => {
    // Depth is LOCAL: a group two levels down one branch must not be
    // capped merely because some other, unrelated branch of the same tree
    // happens to run all the way to MAX_TREE_DEPTH.
    const deepBranch = chain(MAX_TREE_DEPTH - 2)
    const root: Group = { kind: 'group', op: 'and', children: [trait('shallow'), deepBranch] }
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    // Scoped to the ROOT's own `-add` testid -- the deep branch's own
    // nested groups each render their OWN "Add condition"/"Add group"
    // too, which makes an unscoped query ambiguous the moment this fixture
    // has more than one group in it.
    const rootAdd = within(screen.getByTestId('group--add'))
    expect(rootAdd.getByRole('button', { name: /^add condition$/i })).toBeEnabled()
    expect(rootAdd.getByRole('button', { name: /^add group$/i })).toBeEnabled()
  })

  // --- MAX_BEHAVIOR_NODES. -----------------------------------------------
  // Gating on the tree's EXISTING behaviour count alone blocked a control
  // that could never itself add one -- `newCondition()`/`newGroup()` both
  // hardcode a `trait`, so neither is a route to a behaviour even now that
  // a kind switcher exists on each row (its own tests are below, and in
  // `ConditionRow.test.tsx`). The server would accept a trait added to a
  // 25-behaviour tree;
  // the earlier version of this UI refused it anyway, with no route
  // around it short of the CLI -- the exact failure the caps exist to
  // prevent, inverted. `capBlock` now gates on how many behaviours THIS
  // insert would add (always 0 from these two controls today), so these
  // pin the thing that is actually true: adding a trait stays allowed.

  it('does not disable Add condition or Add group at the behaviour cap -- neither control can create a behaviour', () => {
    const root = flatBehaviorRoot(MAX_BEHAVIOR_NODES)
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    expect(screen.getByRole('button', { name: /^add condition$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^add group$/i })).toBeEnabled()
    // No behaviour-cap message renders either -- there is nothing to warn
    // about, since the control genuinely is not blocked.
    expect(screen.queryByText(new RegExp(String(MAX_BEHAVIOR_NODES)))).toBeNull()
  })

  it('clicking Add condition at the behaviour cap actually inserts the trait, proving the control is not merely enabled but functional', async () => {
    const onChange = vi.fn()
    const root = flatBehaviorRoot(MAX_BEHAVIOR_NODES)
    render(
      <GroupCard root={root} path={[]} onChange={onChange} client={client} projectId={projectId} />,
    )
    await userEvent.click(screen.getByRole('button', { name: /^add condition$/i }))
    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as Group
    expect(next.children).toHaveLength(MAX_BEHAVIOR_NODES + 1)
    expect(next.children.at(-1)?.kind).toBe('trait')
  })

  // --- The behaviour cap reaches the kind switcher on each child row. -----
  // `ConditionRow` has no tree and cannot count anything (its own doc
  // comment); this component has `root` and computes the answer. These pin
  // the WIRING -- without the prop, `ConditionRow`'s own cap tests still
  // pass while nothing on a real screen is ever capped.

  /** `MAX_BEHAVIOR_NODES` behaviours plus one trait, so the same tree holds
   * both a row the cap blocks and a row it must not. */
  function cappedRootWithTrait(): Group {
    return {
      kind: 'group',
      op: 'and',
      children: [...flatBehaviorRoot(MAX_BEHAVIOR_NODES).children, trait('t')],
    }
  }

  it('refuses a trait row a switch to "what they did" when the tree is at the behaviour cap, naming the cap', () => {
    render(
      <GroupCard
        root={cappedRootWithTrait()}
        path={[]}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
      />,
    )
    const traitRow = within(screen.getByTestId(`condition-${MAX_BEHAVIOR_NODES}`))
    expect(traitRow.getByRole('option', { name: 'what they did' })).toBeDisabled()
    expect(traitRow.getByText(new RegExp(String(MAX_BEHAVIOR_NODES)))).toBeInTheDocument()
  })

  it('still lets a behaviour row in that same capped tree be switched to "who they are"', async () => {
    // The inverted-cap failure one level down: a tree at the cap that
    // cannot be edited back under it is a tree the server would accept,
    // refused by its own editor.
    const onChange = vi.fn()
    render(
      <GroupCard
        root={cappedRootWithTrait()}
        path={[]}
        onChange={onChange}
        client={client}
        projectId={projectId}
      />,
    )
    const behaviourRow = within(screen.getByTestId('condition-0'))
    await userEvent.selectOptions(
      behaviourRow.getByRole('combobox', { name: 'Match on' }),
      'who they are',
    )
    const next = onChange.mock.calls.at(-1)?.[0] as Group
    expect(next.children[0]?.kind).toBe('trait')
    expect(next.children).toHaveLength(MAX_BEHAVIOR_NODES + 1)
  })

  // --- None of this interferes with the pre-existing negated-group disable

  it('a negated group stays disabled for its own reason even when no cap is close', () => {
    const root: Group = {
      kind: 'group',
      op: 'and',
      children: [{ kind: 'not', child: { kind: 'group', op: 'and', children: [trait('a')] } }],
    }
    render(
      <GroupCard root={root} path={[]} onChange={vi.fn()} client={client} projectId={projectId} />,
    )
    const nested = within(screen.getByTestId('group-0'))
    expect(nested.getByRole('button', { name: /^add condition$/i })).toBeDisabled()
    // No cap message renders here -- this group is small and shallow, so
    // the disable is entirely the pre-existing negation rule, not a cap.
    expect(nested.queryByText(new RegExp(String(MAX_TREE_NODES)))).toBeNull()
  })
})

// --- "Not finished yet" is threaded down, unfiltered, exactly like the
// cost warnings -- and every row of a card has to be able to disagree with
// every other about it. A fixture with exactly ONE condition cannot tell
// "renders on the incomplete row" apart from "renders on every row", and
// this codebase has produced that coincidence before: a warning that
// rendered on every row passed all 31 tests that existed at the time.
describe('GroupCard -- incompleteness lands on the row it names', () => {
  it('shows the message on the incomplete row and on none of its siblings, at depth', () => {
    // `nestedRoot()` is `[trait, [trait, trait]]`, so the addressed row
    // (`[1, 0]`) has a sibling INSIDE its own group and one at the root --
    // two different ways of getting it wrong, both observable here.
    render(
      <GroupCard
        root={nestedRoot()}
        path={[]}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
        incomplete={[[1, 0]]}
      />,
    )
    expect(
      within(screen.getByTestId('condition-1-0')).getByText(/not finished/i),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('condition-1-1')).queryByText(/not finished/i)).toBeNull()
    expect(within(screen.getByTestId('condition-0')).queryByText(/not finished/i)).toBeNull()
  })

  it('shows nothing anywhere when the list is empty', () => {
    // The inverse: a mutation that renders the sentence unconditionally
    // still passes an assertion that only checks one row lacks it.
    render(
      <GroupCard
        root={nestedRoot()}
        path={[]}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
        incomplete={[]}
      />,
    )
    expect(screen.queryByText(/not finished/i)).toBeNull()
  })

  it('reaches a row inside a nested group at all -- the recursion passes the list down', () => {
    // The threading pin. `GroupCard` renders a nested group through
    // ANOTHER `GroupCard`, and a prop dropped at that hand-off leaves every
    // top-level row correct while every nested row goes silent -- a
    // fixture that only ever addresses `[0]` would never notice.
    render(
      <GroupCard
        root={nestedRoot()}
        path={[]}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
        incomplete={[[0], [1, 1]]}
      />,
    )
    expect(within(screen.getByTestId('condition-0')).getByText(/not finished/i)).toBeInTheDocument()
    expect(
      within(screen.getByTestId('condition-1-1')).getByText(/not finished/i),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('condition-1-0')).queryByText(/not finished/i)).toBeNull()
  })
})

// --- Which group an "Add" pair belongs to, in words.
//
// At depth three the pairs stack vertically, identical in size, label and
// colour, separated by one indent step (35px) against a ~110px button. The
// other levers are unavailable: indentation was just REDUCED below `sm` to stop
// nested fields being clipped, and a tint or a heavier rule cannot carry it
// either, since every surface in this palette sits within ~1.1:1 of its
// neighbours by design. So each pair names its own group, in the same phrase
// that group's own "Match" select shows.
//
// `deepChain()` is the shape that actually failed: three nested groups whose
// Add pairs stack, with ALTERNATING join modes, so a label reading the root's
// `op` -- or any ancestor's -- renders the wrong words rather than
// coincidentally the right ones.
function deepChain(): Group {
  return {
    kind: 'group',
    op: 'and',
    children: [
      {
        kind: 'group',
        op: 'or',
        children: [{ kind: 'group', op: 'and', children: [trait('leaf')] }],
      },
    ],
  }
}

describe('GroupCard -- each Add pair says which group it adds to', () => {
  it('names the group beside its own Add controls, at every depth, with its own join mode', () => {
    render(
      <GroupCard
        root={deepChain()}
        path={[]}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
      />,
    )
    // Scoped to each group's own `-add` wrapper -- which holds that group's
    // label and buttons and nothing of any descendant's -- because the whole
    // difficulty is that three of these are on screen at once.
    const root = within(screen.getByTestId('group--add'))
    const middle = within(screen.getByTestId('group-0-add'))
    const deepest = within(screen.getByTestId('group-0-0-add'))
    expect(root.getByText('Add to the top-level group: all conditions (AND)')).toBeVisible()
    expect(middle.getByText('Add to this group: any condition (OR)')).toBeVisible()
    expect(deepest.getByText('Add to this group: all conditions (AND)')).toBeVisible()
    // No pair claims another's mode: the middle group is the only `or` here,
    // so neither of the other two labels may mention it, and the root is the
    // only group that may call itself top-level.
    expect(root.queryByText(/any condition/)).toBeNull()
    expect(deepest.queryByText(/any condition/)).toBeNull()
    expect(middle.queryByText(/top-level/)).toBeNull()
    expect(deepest.queryByText(/top-level/)).toBeNull()
  })

  it('follows the group’s own join mode when it changes, rather than the mode it was born with', async () => {
    // A label computed once, or read off the root, survives a fixture that
    // only ever renders the initial tree. This drives the select and re-reads
    // the label beside the buttons.
    function Harness() {
      const [root, setRoot] = useState<FilterNode>(deepChain())
      return (
        <GroupCard root={root} path={[]} onChange={setRoot} client={client} projectId={projectId} />
      )
    }
    render(<Harness />)
    const deepest = () => within(screen.getByTestId('group-0-0-add'))
    expect(deepest().getByText('Add to this group: all conditions (AND)')).toBeVisible()
    await userEvent.selectOptions(
      within(screen.getByTestId('group-0-0')).getByLabelText('Match'),
      'or',
    )
    expect(deepest().getByText('Add to this group: any condition (OR)')).toBeVisible()
    // ...and only that group's label moved: its parent is still `or` and its
    // grandparent still `and`.
    expect(
      within(screen.getByTestId('group-0-add')).getByText('Add to this group: any condition (OR)'),
    ).toBeVisible()
    expect(
      within(screen.getByTestId('group--add')).getByText(
        'Add to the top-level group: all conditions (AND)',
      ),
    ).toBeVisible()
  })

  it('ties the label to both buttons for a reader who cannot see the layout', () => {
    // Position alone carries this for a sighted operator; read aloud, "Add
    // condition" is exactly as ambiguous as it was. Each group's buttons point
    // at their OWN label, scoped by path -- a flat id would have every group in
    // the tree describing the root's.
    render(
      <GroupCard
        root={deepChain()}
        path={[]}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
      />,
    )
    for (const [testId, expected] of [
      ['group--add', 'Add to the top-level group: all conditions (AND)'],
      ['group-0-add', 'Add to this group: any condition (OR)'],
      ['group-0-0-add', 'Add to this group: all conditions (AND)'],
    ] as const) {
      const wrapper = screen.getByTestId(testId)
      for (const name of ['Add condition', 'Add group']) {
        const button = within(wrapper).getByRole('button', { name })
        const describedBy = button.getAttribute('aria-describedby')
        expect(describedBy).toBe(`${testId}-label`)
        expect(document.getElementById(describedBy ?? '')?.textContent).toBe(expected)
        // The accessible NAME is untouched -- several suites address these
        // buttons by it.
        expect(button).toHaveAccessibleName(name)
      }
    }
  })

  it('uses the same words the group’s own Match select offers, not a paraphrase', () => {
    // The mechanism, pinned: the operator recognises the phrase from the
    // header rather than tracing a rail upwards. A label reading "matching
    // all" or "AND group" would still identify the group and would break that
    // tie -- so the label is asserted against the option's OWN text, not
    // against a literal repeated here.
    render(
      <GroupCard
        root={{ kind: 'group', op: 'or', children: [trait('a')] }}
        path={[]}
        onChange={vi.fn()}
        client={client}
        projectId={projectId}
      />,
    )
    const option = screen.getByLabelText('Match').querySelector('option[value="or"]')?.textContent
    expect(option).toBe('any condition (OR)')
    expect(
      within(screen.getByTestId('group--add')).getByText(`Add to the top-level group: ${option}`),
    ).toBeVisible()
  })
})
