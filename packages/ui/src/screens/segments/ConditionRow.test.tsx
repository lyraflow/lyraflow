import type { Context, FilterNode, Lifecycle, Trait } from '@lyraflow/core/segments/ast.js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
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

/** Neither field starts empty on every fixture above that carries an
 * `event` (`behaviorNode.event === 'checkout'`), so `EventCombobox`'s own
 * debounced lookup fires on mount -- these stand in so that resolves
 * quietly rather than rejecting into an unhandled promise. */
function fakeClient(): ApiClient {
  return {
    schemaEvents: vi.fn(async () => []),
    schemaProperties: vi.fn(async () => []),
  } as unknown as ApiClient
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
        client={fakeClient()}
        projectId={1}
      />,
    )
    expect(screen.getByTestId('condition-2-0')).toBeInTheDocument()
  })

  it.each([
    ['trait', traitNode, 'textbox', /key/i],
    ['context', contextNode, 'combobox', /field/i],
    ['lifecycle', lifecycleNode, 'combobox', /^field$/i],
    // `EventCombobox`'s own `<input list=...>` computes an ARIA role of
    // "combobox", not "textbox" -- the `list` attribute is itself what
    // flips the accessible role, same as `ContextForm`'s native `<select>`.
    ['behavior', behaviorNode, 'combobox', /event/i],
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
          client={fakeClient()}
          projectId={1}
        />,
      )
      const row = screen.getByTestId('condition-0')
      expect(within(row).getByRole(role, { name: fieldLabel })).toBeInTheDocument()
      // The give-away that a real form rendered: an id scoped to this
      // row's own path (`condition-0-...`), not a flat literal id a second
      // row at a different path would collide with.
    },
  )

  it('every leaf kind the AST defines now has a real form -- the fallback summary is unreachable from here', () => {
    // Task 6 gave `behavior` its own form (`BehaviourForm`), the last of
    // the four leaf kinds still on the placeholder. Pinned by asserting
    // BehaviourForm's own distinguishing field (Aggregate, which no other
    // form renders) is present, rather than the one-line `summarise` text
    // ("count of checkout in last 7 days >= 1") the placeholder used to
    // show for this exact fixture.
    render(
      <ConditionRow
        node={behaviorNode}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    const row = screen.getByTestId('condition-0')
    expect(within(row).getByRole('combobox', { name: /aggregate/i })).toHaveValue('count')
    expect(row).not.toHaveTextContent('count of checkout in last 7 days >= 1')
  })

  it('unwraps a negated leaf so the real form still renders what it negates', () => {
    render(
      <ConditionRow
        node={{ kind: 'not', child: traitNode }}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    const row = screen.getByTestId('condition-0')
    expect(within(row).getByRole('textbox', { name: /key/i })).toHaveValue('plan')
    expect(within(row).getByRole('button', { name: /negate/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('a negated behavior leaf still renders the real form, with Negate pressed', () => {
    // The behavior-specific analogue of the trait test above -- pinned on
    // the give-away field (Event) rather than on "not (...)" text, since
    // that fallback phrasing no longer applies to a kind with a real form.
    render(
      <ConditionRow
        node={{ kind: 'not', child: behaviorNode }}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    const row = screen.getByTestId('condition-0')
    expect(within(row).getByRole('combobox', { name: /event/i })).toHaveValue('checkout')
    expect(within(row).getByRole('button', { name: /negate/i })).toHaveAttribute(
      'aria-pressed',
      'true',
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
        client={fakeClient()}
        projectId={1}
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
        client={fakeClient()}
        projectId={1}
      />,
    )
    const row = screen.getByTestId('condition-0')
    await userEvent.click(within(row).getByRole('button', { name: /negate/i }))
    await userEvent.click(within(row).getByRole('button', { name: /remove/i }))
    expect(onNegate).toHaveBeenCalledTimes(1)
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it("threads client/projectId/onUnauthorized down to a behavior leaf's BehaviourForm", async () => {
    // Wiring pin: without this, BehaviourForm's own EventCombobox/
    // PropertyCombobox would silently call a client ConditionRow never
    // received, which is exactly the kind of gap that only shows up once
    // a real `ApiClient` is wired in, not against a fake that ignores its
    // arguments.
    const schemaEvents = vi.fn(async (_projectId: number, _q: string) => ['checkout_completed'])
    const client = { schemaEvents, schemaProperties: vi.fn(async () => []) } as unknown as ApiClient
    render(
      <ConditionRow
        node={behaviorNode}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={client}
        projectId={42}
      />,
    )
    const row = screen.getByTestId('condition-0')
    await userEvent.type(within(row).getByRole('combobox', { name: /event/i }), 'x')
    await waitFor(() => expect(schemaEvents).toHaveBeenCalled())
    expect(schemaEvents.mock.calls[0]?.[0]).toBe(42)
  })
})
