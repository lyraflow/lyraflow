import type { Context, FilterNode, Lifecycle, Trait } from '@lyraflow/core/segments/ast.js'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ConditionRow } from './ConditionRow.js'

const traitNode: Trait = { kind: 'trait', key: 'plan', operator: '=', value: 'pro' }
const contextNode: Context = {
  kind: 'context',
  field: 'country',
  scope: 'latest',
  operator: '=',
  value: 'US',
}
const lifecycleNode: Lifecycle = {
  kind: 'lifecycle',
  field: 'first_seen',
  operator: '>=',
  value: '2026-01-01T00:00',
}
const behaviorNode: FilterNode = {
  kind: 'behavior',
  event: 'checkout',
  aggregate: 'count',
  window: { kind: 'last', n: 7, unit: 'days' },
  operator: '>=',
  value: 1,
}

describe('ConditionRow', () => {
  it('keeps the condition-<path> testid the recursion addresses nodes through', () => {
    // Controller correction (binding, this task's brief): the ConditionRow
    // testid contract Task 4's recursion tests depend on at arbitrary
    // depth. A leaf renderer that drops it leaves those tests passing
    // while addressing nothing.
    render(
      <ConditionRow
        node={traitNode}
        path={[2, 0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
      />,
    )
    expect(screen.getByTestId('condition-2-0')).toBeInTheDocument()
  })

  it.each([
    ['trait', traitNode, 'textbox', /key/i],
    ['context', contextNode, 'combobox', /field/i],
    ['lifecycle', lifecycleNode, 'combobox', /^field$/i],
  ] as const)(
    'renders the real %s form, not the placeholder summary',
    (_kind, node, role, fieldLabel) => {
      render(
        <ConditionRow
          node={node}
          path={[0]}
          onChange={vi.fn()}
          onRemove={vi.fn()}
          onNegate={vi.fn()}
        />,
      )
      const row = screen.getByTestId('condition-0')
      expect(within(row).getByRole(role, { name: fieldLabel })).toBeInTheDocument()
      // The give-away that a real form rendered: an id scoped to this
      // row's own path (`condition-0-...`), not a flat literal id a second
      // row at a different path would collide with.
    },
  )

  it('still falls back to the one-line summary for a kind with no real form yet (behavior)', () => {
    render(
      <ConditionRow
        node={behaviorNode}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
      />,
    )
    expect(screen.getByTestId('condition-0')).toHaveTextContent(
      'count of checkout in last 7 days >= 1',
    )
  })

  it('unwraps a negated leaf so the real form still renders what it negates', () => {
    render(
      <ConditionRow
        node={{ kind: 'not', child: traitNode }}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
      />,
    )
    const row = screen.getByTestId('condition-0')
    expect(within(row).getByRole('textbox', { name: /key/i })).toHaveValue('plan')
    expect(within(row).getByRole('button', { name: /negate/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('a negated behavior leaf still shows "not (...)", not bare "not"', () => {
    // Pinned on `node`, deliberately not `inner` -- the fallback summary
    // branch takes the ORIGINAL (possibly-`not`-wrapped) node, the same
    // way `summarise` itself handles negation, so a negated leaf without a
    // real form yet doesn't silently drop the negation from view.
    render(
      <ConditionRow
        node={{ kind: 'not', child: behaviorNode }}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
      />,
    )
    expect(screen.getByTestId('condition-0')).toHaveTextContent(
      'not (count of checkout in last 7 days >= 1)',
    )
  })

  /** `ConditionRow` is fully controlled, same as every form it renders --
   * a static `onChange` mock that never feeds back into `node` leaves the
   * DOM glued to the ORIGINAL value between keystrokes, which is what
   * makes multi-key `userEvent.type` come out garbled for reasons that
   * have nothing to do with the negation logic under test here. */
  function Harness(props: { initial: FilterNode }) {
    const [node, setNode] = useState<FilterNode>(props.initial)
    return (
      <ConditionRow
        node={node}
        path={[0]}
        onChange={setNode}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
      />
    )
  }

  it('re-wraps an edit to a negated leaf in `not` before calling onChange, rather than stripping the negation', async () => {
    // The defect this pins: a form's own onChange only ever hands back the
    // UNWRAPPED node it edited (a bare Trait, never a `not`). If
    // ConditionRow forwarded that straight to `props.onChange`, editing a
    // NEGATED leaf's key would silently un-negate it -- the tree's
    // negation would vanish on the next keystroke, not just on Negate.
    // Asserted through the Negate button's own `aria-pressed`, which
    // reflects `node.kind === 'not'` after the edit round-trips through
    // state: if the wrap were dropped, this would flip to "false" the
    // instant a character is typed.
    render(<Harness initial={{ kind: 'not', child: traitNode }} />)
    const key = screen.getByRole('textbox', { name: /key/i })
    await userEvent.clear(key)
    await userEvent.type(key, 'plan_id')
    expect(key).toHaveValue('plan_id')
    const row = screen.getByTestId('condition-0')
    expect(within(row).getByRole('button', { name: /negate/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('does not re-wrap an edit to a non-negated leaf', async () => {
    render(<Harness initial={traitNode} />)
    const key = screen.getByRole('textbox', { name: /key/i })
    await userEvent.clear(key)
    await userEvent.type(key, 'plan_id')
    expect(key).toHaveValue('plan_id')
    const row = screen.getByTestId('condition-0')
    expect(within(row).getByRole('button', { name: /negate/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })

  it('Remove and Negate still call their own props, untouched by the dispatch change', async () => {
    const onRemove = vi.fn()
    const onNegate = vi.fn()
    render(
      <ConditionRow
        node={traitNode}
        path={[0]}
        onChange={vi.fn()}
        onRemove={onRemove}
        onNegate={onNegate}
      />,
    )
    const row = screen.getByTestId('condition-0')
    await userEvent.click(within(row).getByRole('button', { name: /negate/i }))
    await userEvent.click(within(row).getByRole('button', { name: /remove/i }))
    expect(onNegate).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })
})
