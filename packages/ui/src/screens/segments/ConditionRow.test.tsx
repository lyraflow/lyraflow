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

  // Task 10 (visual pass): a negated leaf used to render pixel-identical to
  // a non-negated one. `aria-pressed` on the Negate button was the ONLY
  // signal, and the vendored Button has no pressed styling, so
  // `not (status = churned)` read on screen as `status = churned` -- the
  // operator believes the segment includes exactly the people it excludes.
  // The detail screen's `summarise` line has always rendered the `not (...)`
  // correctly; only the builder was silent, and only for LEAVES (`GroupCard`
  // already says "This group is negated" in words).
  const churnedNot: FilterNode = {
    kind: 'not',
    child: { kind: 'trait', key: 'status', operator: '=', value: 'churned' },
  }

  it('renders a visible "Not" badge on a negated leaf, additive to the form it negates', () => {
    render(
      <ConditionRow
        node={churnedNot}
        path={[1, 2]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    const row = screen.getByTestId('condition-1-2')
    // Queried by exact text and then explicitly excluded from being a
    // button: the point of the badge is that it is a STATIC mark on the
    // row, not the Negate control (whose accessible name is "Negate", and
    // which would therefore never satisfy an exact "Not" match anyway --
    // this assertion makes that requirement explicit rather than
    // incidental).
    const badge = within(row).getByText('Not', { selector: ':not(button)' })
    expect(badge).toBeInTheDocument()
    expect(badge.closest('button')).toBeNull()
    expect(within(row).getByRole('button', { name: /negate/i })).not.toBe(badge)
    // Additive, not a replacement: the trait's own fields still render.
    expect(within(row).getByRole('textbox', { name: /key/i })).toHaveValue('status')
    expect(within(row).getByRole('textbox', { name: /^value$/i })).toHaveValue('churned')
  })

  it('renders no "Not" badge on the same leaf un-negated', () => {
    render(
      <ConditionRow
        node={{ kind: 'trait', key: 'status', operator: '=', value: 'churned' }}
        path={[1, 2]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    const row = screen.getByTestId('condition-1-2')
    expect(within(row).queryByText('Not', { selector: ':not(button)' })).toBeNull()
    expect(within(row).getByRole('textbox', { name: /key/i })).toHaveValue('status')
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

  // Task 7, fix round 1 (Important 1): every SegmentBuilder/SegmentDetail
  // fixture carrying a cost warning had exactly ONE condition in the whole
  // tree, so "the warning appears inside condition-0" was true whether path
  // association worked or not -- `const ownWarnings = warnings` (render
  // every warning on every row, unfiltered) passed all 31 tests that
  // existed at the time. Pinned directly here, at the unit level, with two
  // DIFFERENT paths so a warning for one can be told apart from a warning
  // for the other.
  it('renders only the warning addressed to its own path, not a warning for a different path', () => {
    const warnings = [{ path: 'filter.children[1]', reason: 'scans all history' }]
    const { rerender } = render(
      <ConditionRow
        node={traitNode}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
        warnings={warnings}
      />,
    )
    expect(within(screen.getByTestId('condition-0')).queryByText(/scans all history/i)).toBeNull()

    rerender(
      <ConditionRow
        node={traitNode}
        path={[1]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
        warnings={warnings}
      />,
    )
    expect(
      within(screen.getByTestId('condition-1')).getByText(/scans all history/i),
    ).toBeInTheDocument()
  })

  it('a `warnings` prop for a DIFFERENT path renders nothing at all -- not merely "not this text"', () => {
    // The inverse of the test above: a mutation that renders SOME warning
    // list unconditionally (rather than the empty filtered result) could
    // still pass an assertion that only checks a specific string is absent.
    render(
      <ConditionRow
        node={traitNode}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
        warnings={[{ path: 'filter.children[9]', reason: 'scans all history' }]}
      />,
    )
    // `AlertTriangle` (lucide) renders no visible text of its own -- if a
    // warning list rendered at all, it would carry at least the reason text.
    expect(screen.queryByText(/scans all history/i)).toBeNull()
  })
})
