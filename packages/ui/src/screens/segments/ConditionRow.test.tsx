import { AST_VERSION, FilterNode as FilterNodeSchema } from '@lyraflow/core/segments/ast.js'
import type {
  Comparison,
  Context,
  FilterNode,
  Lifecycle,
  Trait,
} from '@lyraflow/core/segments/ast.js'
import { MAX_BEHAVIOR_NODES, costWarnings } from '@lyraflow/core/segments/validate.js'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { ConditionRow } from './ConditionRow.js'
import { summarise } from './summarise.js'

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

/**
 * Every leaf kind the AST defines, each paired with a field only its own
 * form renders. One list, used by every per-kind table below, so a kind
 * added to the AST later is added HERE once and every property those tables
 * assert (the real form renders; the `Not` badge tracks negation) starts
 * being required of it.
 *
 * The reason this is a shared list rather than a fixture per test: the badge
 * tests below used to assert presence and absence on the same `trait` node,
 * which is a coincidence point -- suppressing the badge for every kind
 * EXCEPT trait left the whole suite green while a negated behaviour
 * condition, the one whose misreading changes which population you email,
 * rendered pixel-identical to a non-negated one.
 *
 * The fifth column is the label the KIND SWITCHER offers that kind under --
 * the operator's vocabulary, not the AST's -- so the switcher's own tables
 * below drive off exactly the same list as everything else here, and a kind
 * added to the AST is still added in one place.
 */
const LEAF_KINDS = [
  // Trait is a "combobox" for the same reason `behavior` is, below: its
  // field is now an `<input list=...>` backed by the schema, not the bare
  // text box it shipped as. That change is the point -- a free text box
  // labelled "Key" asked the operator to guess both what the field meant
  // and which names their project actually records.
  ['trait', traitNode, 'combobox', /^trait$/i, 'who they are'],
  ['context', contextNode, 'combobox', /field/i, 'where they came from'],
  ['lifecycle', lifecycleNode, 'combobox', /^field$/i, 'lifecycle'],
  // `EventCombobox`'s own `<input list=...>` computes an ARIA role of
  // "combobox", not "textbox" -- the `list` attribute is itself what flips
  // the accessible role, same as `ContextForm`'s native `<select>`.
  ['behavior', behaviorNode, 'combobox', /event/i, 'what they did'],
] as const

/**
 * Which fields of a fresh node of each kind are allowed to be blank, as
 * DOTTED PATHS into the node -- the convention being that an empty field
 * means "not filled in yet" and only the one thing the operator alone can
 * supply is left for them (`ConditionRow`'s own `defaultLeaf` doc comment).
 *
 * Stated as an exact list rather than "at most one issue" so it is
 * two-sided: seeding `key` with an invented example fails it from one
 * direction, and breaking `window`/`aggregate`/`field` fails it from the
 * other.
 */
const PLACEHOLDER_FIELDS: Record<string, string[]> = {
  trait: ['key'],
  behavior: ['event'],
  context: [],
  lifecycle: [],
}

/** The dotted paths of every field of `node` the REAL AST schema refuses --
 * empty for a node that parses. Never a hand-written notion of "filled in":
 * a second definition of validity is what drifts from the server's. */
function unfilledFields(node: FilterNode): string[] {
  const parsed = FilterNodeSchema.safeParse(node)
  return parsed.success ? [] : parsed.error.issues.map((i) => i.path.join('.'))
}

describe('ConditionRow', () => {
  it('keeps the condition-<path> testid the recursion addresses nodes through', () => {
    // The ConditionRow
    // testid contract the recursion tests depend on at arbitrary
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

  it.each(LEAF_KINDS)(
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
    // `behavior` got its own form (`BehaviourForm`), the last of
    // the four leaf kinds still on the placeholder. Pinned by asserting
    // BehaviourForm's own distinguishing field (Aggregate, which no other
    // form renders) is present, rather than the one-line `summarise` text the
    // placeholder used to show for this exact fixture.
    //
    // The absence is asserted against `summarise(behaviorNode)` itself rather
    // than against a frozen literal of what it used to return: the summary's
    // wording has since changed (the operator words and the window phrasing
    // moved to `vocabulary.ts`), and a literal from the old wording is an
    // assertion that can no longer fail even if the fallback DOES render.
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
    expect(row).not.toHaveTextContent(summarise(behaviorNode))
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
    expect(within(row).getByRole('combobox', { name: /^trait$/i })).toHaveValue('plan')
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

  // A negated leaf used to render pixel-identical to
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
    expect(within(row).getByRole('combobox', { name: /^trait$/i })).toHaveValue('status')
    expect(within(row).getByRole('combobox', { name: /^value$/i })).toHaveValue('churned')
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
    expect(within(row).getByRole('combobox', { name: /^trait$/i })).toHaveValue('status')
  })

  // The two tests above use the same `trait` fixture for both the presence
  // and the absence assertion, which is a coincidence point: the badge can be
  // rendered for `trait` alone and suppressed for `context`, `lifecycle` and
  // `behavior` with both of them -- and every other test that existed --
  // still passing. The pair below drives the SAME two assertions from
  // `LEAF_KINDS`, so the badge's presence is required to be a function of
  // `negated` alone: not of the leaf kind, and not of anything else the
  // dispatch below it happens to know.

  it.each(LEAF_KINDS)(
    'renders the "Not" badge on a negated %s leaf, whatever the leaf kind',
    (_kind, node, role, fieldLabel) => {
      render(
        <ConditionRow
          node={{ kind: 'not', child: node }}
          path={[1, 2]}
          onChange={vi.fn()}
          onRemove={vi.fn()}
          onNegate={vi.fn()}
          client={fakeClient()}
          projectId={1}
        />,
      )
      const row = screen.getByTestId('condition-1-2')
      const badge = within(row).getByText('Not', { selector: ':not(button)' })
      expect(badge.closest('button')).toBeNull()
      // Additive, not a replacement: this kind's own real form still renders
      // beside the badge rather than being swapped for it.
      expect(within(row).getByRole(role, { name: fieldLabel })).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: /negate/i })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    },
  )

  it.each(LEAF_KINDS)(
    'renders no "Not" badge on the same %s leaf un-negated',
    (_kind, node, role, fieldLabel) => {
      render(
        <ConditionRow
          node={node}
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
      expect(within(row).getByRole(role, { name: fieldLabel })).toBeInTheDocument()
      expect(within(row).getByRole('button', { name: /negate/i })).toHaveAttribute(
        'aria-pressed',
        'false',
      )
    },
  )

  it('gives the Negate button pressed STYLING, not `aria-pressed` alone', () => {
    // `aria-pressed` on its own is invisible here: the vendored `Button` has
    // no pressed styling of any variant, so the `aria-pressed:` utility
    // classes on this one button are the only thing that makes a pressed
    // Negate look different from an unpressed one. Nothing else asserts
    // them, so deleting the `className` prop is a silent regression to
    // "a negated leaf looks exactly like a non-negated one" -- half of the
    // defect the badge above fixes. Asserted on the class attribute because
    // jsdom computes no styles for utility classes; this is the only signal
    // available at this level.
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
    const negate = within(screen.getByTestId('condition-0')).getByRole('button', {
      name: /negate/i,
    })
    expect(negate.className).toMatch(/aria-pressed:/)
  })

  /** `ConditionRow` is fully controlled, same as every form it renders --
   * a static `onChange` mock that never feeds back into `node` leaves the
   * DOM glued to the ORIGINAL value between keystrokes, which is what
   * makes multi-key `userEvent.type` come out garbled for reasons that
   * have nothing to do with the negation logic under test here. */
  function Harness(props: {
    initial: FilterNode
    /** Every node the row hands back, in order -- the switcher's tests
     * assert against the NODE, not only against what re-renders from it. */
    onNode?: (next: FilterNode) => void
    behaviorCap?: { blocked: boolean; message: string }
  }) {
    const [node, setNode] = useState<FilterNode>(props.initial)
    return (
      <ConditionRow
        node={node}
        path={[0]}
        onChange={(next) => {
          props.onNode?.(next)
          setNode(next)
        }}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
        behaviorCap={props.behaviorCap}
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
    const key = screen.getByRole('combobox', { name: /^trait$/i })
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
    const key = screen.getByRole('combobox', { name: /^trait$/i })
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

  // Every SegmentBuilder/SegmentDetail
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

  // --- "Not finished yet" is said on the row, never in a page banner. ------
  // Same arrangement as the cost warnings above, and pinned the same way:
  // the whole tree's list is handed to every row unfiltered, and each row
  // picks out only what names its own path. The coincidence this avoids is
  // the one the warning tests already caught once -- a fixture with exactly
  // one condition cannot tell "renders on its own row" apart from "renders
  // on every row".

  it('renders its own incompleteness message, and not one addressed to a different path', () => {
    const incomplete = [[1]]
    const { rerender } = render(
      <ConditionRow
        node={traitNode}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
        incomplete={incomplete}
      />,
    )
    expect(within(screen.getByTestId('condition-0')).queryByText(/not finished/i)).toBeNull()

    rerender(
      <ConditionRow
        node={traitNode}
        path={[1]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
        incomplete={incomplete}
      />,
    )
    expect(within(screen.getByTestId('condition-1')).getByText(/not finished/i)).toBeInTheDocument()
  })

  it('says nothing at all when no path is incomplete', () => {
    render(
      <ConditionRow
        node={traitNode}
        path={[0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
        incomplete={[]}
      />,
    )
    expect(screen.queryByText(/not finished/i)).toBeNull()
  })

  it('renders the message at a nested path, not only at a one-segment one', () => {
    // A row two levels down is addressed by a two-segment path, and a
    // filter that compared only the first segment -- or only the last --
    // would put the message on the wrong row without ever going red at
    // depth zero.
    render(
      <ConditionRow
        node={traitNode}
        path={[2, 0]}
        onChange={vi.fn()}
        onRemove={vi.fn()}
        onNegate={vi.fn()}
        client={fakeClient()}
        projectId={1}
        incomplete={[[2, 0]]}
      />,
    )
    expect(
      within(screen.getByTestId('condition-2-0')).getByText(/not finished/i),
    ).toBeInTheDocument()
  })

  // --- The kind switcher. --------------------------------------------------
  // Until it existed, `GroupCard`'s `newCondition()` hardcoded a `trait` and
  // NOTHING anywhere could change a condition's kind, so three of the four
  // leaf forms -- including the behaviour form, the most valuable thing this
  // screen can express -- rendered only for nodes authored through the CLI or
  // the API.

  const kindSelect = () =>
    within(screen.getByTestId('condition-0')).getByRole('combobox', { name: 'Match on' })

  /** The message `GroupCard` computes from `capBlock` and hands down. Built
   * from `MAX_BEHAVIOR_NODES` rather than typed out, so the assertions below
   * are about the cap the server actually enforces. */
  const CAP_MESSAGE = `Adding here would bring this segment to ${MAX_BEHAVIOR_NODES + 1} behavioural conditions; the maximum is ${MAX_BEHAVIOR_NODES}.`
  const atCap = { blocked: true, message: CAP_MESSAGE }

  it('offers every leaf kind under the operator-facing label, as the first control of the row', () => {
    render(<Harness initial={traitNode} />)
    const select = kindSelect()
    expect(select).toHaveValue('trait')
    // The full option list, in order, by LABEL -- so renaming one to the
    // AST's own noun ("behavior") is a failure here rather than a silent
    // vocabulary change on the one screen an operator reads.
    expect(
      Array.from(select.querySelectorAll('option')).map((o) => [o.value, o.textContent]),
    ).toEqual([
      ['trait', 'who they are'],
      ['behavior', 'what they did'],
      ['context', 'where they came from'],
      ['lifecycle', 'lifecycle'],
    ])
  })

  /**
   * The chain of ancestors of `el`, innermost first, so two of them can be
   * compared for where they diverge.
   */
  function ancestors(el: Element): Element[] {
    const out: Element[] = []
    for (let n: Element | null = el; n != null; n = n.parentElement) out.push(n)
    return out
  }

  /** The innermost element containing both -- i.e. the box they share. */
  function sharedBox(a: Element, b: Element): Element {
    const chain = new Set(ancestors(a))
    for (const n of ancestors(b)) if (chain.has(n)) return n
    throw new Error('the two elements share no ancestor at all')
  }

  it.each(LEAF_KINDS)(
    'keeps the kind selector in a box of its own, above a %s condition rather than inside its fields',
    (_kind, node, role, fieldLabel) => {
      // The one thing jsdom CAN check about this, and the thing that actually
      // went wrong. The selector was already first in DOM order and still
      // rendered 302px BELOW the top of a behaviour condition, level with its
      // `Where` block: it shared a wrapping flex row with the body form, and
      // that form's `flex-1` basis of zero meant the row never broke, so
      // `items-center` parked the selector at the form's vertical middle.
      //
      // So what is pinned is the STRUCTURE that made it possible -- the
      // innermost box holding both the selector and the body's own first field
      // must be the condition itself, never some row inside it. Put them back
      // in one flex container and this fails for every kind, at every width,
      // without needing a stylesheet jsdom does not load.
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
      const kind = within(row).getByRole('combobox', { name: 'Match on' })
      const field = within(row).getByRole(role, { name: fieldLabel })
      expect(sharedBox(kind, field)).toBe(row)
      // ...and it still READS first, which is the other half of the claim.
      expect(kind.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    },
  )

  it.each(LEAF_KINDS)(
    'switching to %s leaves exactly the not-filled-in-yet fields blank, and every other field a real choice',
    async (kind, _node, role, fieldLabel, label) => {
      // The starting node is always of a DIFFERENT kind, so every row of
      // this table is a real switch rather than a no-op.
      const onNode = vi.fn()
      render(<Harness initial={kind === 'trait' ? behaviorNode : traitNode} onNode={onNode} />)
      await userEvent.selectOptions(kindSelect(), label)

      const next = onNode.mock.calls.at(-1)?.[0] as FilterNode
      expect(next.kind).toBe(kind)
      // Measured against the REAL schema from core, never a shape written
      // out here: a test that asserts what the code produces cannot catch
      // the code producing something the AST refuses.
      //
      // Two-sided, which is the whole point. An empty field means "not
      // filled in yet" (`defaultLeaf`'s own doc comment) and only the one
      // field the operator alone can supply may be blank -- so this pins
      // BOTH that a fresh trait does not arrive with an invented `key` and
      // that nothing ELSE about the fresh node is broken. `ast.ts`'s
      // refines are the second half: `count` must carry no property, a
      // lifecycle value must parse as a datetime, a `last` window's `n`
      // must be a positive integer within 3650.
      expect(unfilledFields(next)).toEqual(PLACEHOLDER_FIELDS[kind])
      // ...and the row now renders that kind's own first field, so the
      // switch is visible to the operator and not merely to the tree.
      expect(
        within(screen.getByTestId('condition-0')).getByRole(role, { name: fieldLabel }),
      ).toBeInTheDocument()
    },
  )

  it('seeds a fresh lifecycle bound as an instant that names its zone', async () => {
    // A bound WRITTEN by this screen has to say which instant it means. The
    // wall-clock reading this used to seed does not: `predicates.ts` resolves
    // a zone-less value with `new Date()` in the SERVER's zone, so the same
    // saved segment means different things depending on where it is counted.
    // Reading such a value back is still supported, and deliberately
    // unshifted -- see `datetime.ts`. Writing one is what stops here.
    const onNode = vi.fn()
    render(<Harness initial={traitNode} onNode={onNode} />)
    await userEvent.selectOptions(kindSelect(), 'lifecycle')

    const next = onNode.mock.calls.at(-1)?.[0] as Lifecycle
    expect(next.kind).toBe('lifecycle')
    expect(String(next.value)).toMatch(/T.*(?:Z|[+-]\d{2}:?\d{2})$/)
    // And it is still a value the schema accepts, measured against the schema.
    expect(unfilledFields(next)).toEqual(PLACEHOLDER_FIELDS.lifecycle)
  })

  it('a fresh behaviour carries no cost warning of its own', async () => {
    // Why `event` starts EMPTY rather than at `'*'`, which is legal and
    // would parse. `'*'` MEANS "any event": it raises a cost warning the
    // instant the condition appears, and suppresses `SegmentBuilder`'s
    // automatic preview with it. A brand-new condition the operator has not
    // finished writing must not arrive carrying a warning about scanning
    // everything. Measured through `costWarnings` itself, so re-seeding the
    // field with any value that trips it -- `'*'`, or an `ever` window --
    // fails here.
    const onNode = vi.fn()
    render(<Harness initial={traitNode} onNode={onNode} />)
    await userEvent.selectOptions(kindSelect(), 'what they did')

    const next = onNode.mock.calls.at(-1)?.[0] as FilterNode
    expect(costWarnings({ ast_version: AST_VERSION, filter: next })).toEqual([])
  })

  it('a fresh behaviour keeps the real choices around the blank field', async () => {
    // The other half of "revert the invented defaults": only the event is a
    // placeholder. A bounded window rather than `ever` (which would scan all
    // history), and `count`, the one aggregate that must carry no property.
    const onNode = vi.fn()
    render(<Harness initial={traitNode} onNode={onNode} />)
    await userEvent.selectOptions(kindSelect(), 'what they did')

    const next = onNode.mock.calls.at(-1)?.[0] as FilterNode
    if (next.kind !== 'behavior') throw new Error('unreachable')
    expect(next.event).toBe('')
    expect(next.aggregate).toBe('count')
    expect(next).not.toHaveProperty('property')
    expect(next.window).toEqual({ kind: 'last', n: 30, unit: 'days' })
  })

  it("switching away from a kind and back does not resurrect the old node's fields", async () => {
    // `WindowPicker`'s own rule, one level up: a switch REPLACES the node
    // wholesale. A spread would leave `field`/`scope` from the context node
    // sitting on the trait it became -- a shape the AST's union refuses to
    // parse back, produced by this UI rather than by a hand-built request.
    const onNode = vi.fn()
    render(
      <Harness
        initial={{ kind: 'trait', key: 'status', operator: '!=', value: 'churned' }}
        onNode={onNode}
      />,
    )
    await userEvent.selectOptions(kindSelect(), 'where they came from')
    await userEvent.selectOptions(kindSelect(), 'who they are')

    const next = onNode.mock.calls.at(-1)?.[0] as Comparison<Trait>
    expect(next.kind).toBe('trait')
    // None of the original trait survived the round trip...
    expect(next.value).toBe('')
    expect(next.operator).toBe('=')
    expect(next.key).not.toBe('status')
    // ...and nothing of the context node it passed through did either.
    expect(next).not.toHaveProperty('field')
    expect(next).not.toHaveProperty('scope')
    // A blank `key` and nothing else -- the round trip leaves a fresh
    // DRAFT, not a node carrying a plausible key nobody chose.
    expect(next.key).toBe('')
    expect(unfilledFields(next)).toEqual(PLACEHOLDER_FIELDS.trait)
  })

  it('keeps a negated condition negated across a kind switch', async () => {
    // A `not` WRAPS a node rather than belonging to it (`wrapLike`), so
    // changing what is negated must never change whether it is. Dropping
    // the wrap here would silently widen the segment to the exact people it
    // was written to exclude.
    const onNode = vi.fn()
    render(<Harness initial={{ kind: 'not', child: traitNode }} onNode={onNode} />)
    await userEvent.selectOptions(kindSelect(), 'what they did')

    const next = onNode.mock.calls.at(-1)?.[0] as FilterNode
    expect(next.kind).toBe('not')
    if (next.kind !== 'not') throw new Error('unreachable')
    expect(next.child.kind).toBe('behavior')
    // The `not` is carried across, and the node inside it is the same fresh
    // draft a bare switch produces -- the blank `event` reached through the
    // wrapper, nothing else.
    expect(unfilledFields(next)).toEqual(['child.event'])
    // And the row still SAYS so, both ways it says it.
    const row = screen.getByTestId('condition-0')
    expect(within(row).getByText('Not', { selector: ':not(button)' })).toBeInTheDocument()
    expect(within(row).getByRole('button', { name: /negate/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('refuses a switch to "what they did" at the behaviour cap even when the change event arrives anyway', () => {
    // The refusal has to live where the node would be REPLACED, not only in
    // the `disabled` attribute below: an attribute is a hint to a pointer,
    // and a `change` event can arrive without one.
    const onNode = vi.fn()
    render(<Harness initial={traitNode} onNode={onNode} behaviorCap={atCap} />)
    fireEvent.change(kindSelect(), { target: { value: 'behavior' } })
    expect(onNode).not.toHaveBeenCalled()
    expect(kindSelect()).toHaveValue('trait')
  })

  it('disables the "what they did" option at the behaviour cap', () => {
    render(<Harness initial={traitNode} behaviorCap={atCap} />)
    const row = screen.getByTestId('condition-0')
    expect(within(row).getByRole('option', { name: 'what they did' })).toBeDisabled()
  })

  it('says WHICH cap refused the switch, rather than merely refusing', () => {
    // Same treatment "Add condition" gives a cap it is blocked by: a
    // disabled control with no sentence beside it is indistinguishable from
    // a broken one.
    render(<Harness initial={traitNode} behaviorCap={atCap} />)
    expect(
      within(screen.getByTestId('condition-0')).getByText(new RegExp(String(MAX_BEHAVIOR_NODES))),
    ).toHaveTextContent(CAP_MESSAGE)
  })

  it('still allows a behaviour condition to be switched to "who they are" at the cap', async () => {
    // The direction that matters. A gate that reads the tree's behaviour
    // count in isolation refuses this too -- and then the operator cannot
    // edit the tree towards being legal at all, which is the inverted cap
    // this screen has already shipped once, for the two "Add" controls.
    const onNode = vi.fn()
    render(<Harness initial={behaviorNode} onNode={onNode} behaviorCap={atCap} />)
    await userEvent.selectOptions(kindSelect(), 'who they are')

    const next = onNode.mock.calls.at(-1)?.[0] as FilterNode
    expect(next.kind).toBe('trait')
    expect(unfilledFields(next)).toEqual(PLACEHOLDER_FIELDS.trait)
  })

  it('still allows a trait condition to be switched to a NON-behaviour kind at the cap', async () => {
    // The cap is about `behavior` nodes only. Consulting it for every
    // switch would freeze a capped tree's rows into whatever kind they
    // happen to hold.
    const onNode = vi.fn()
    render(<Harness initial={traitNode} onNode={onNode} behaviorCap={atCap} />)
    await userEvent.selectOptions(kindSelect(), 'lifecycle')

    const next = onNode.mock.calls.at(-1)?.[0] as FilterNode
    expect(next.kind).toBe('lifecycle')
    expect(unfilledFields(next)).toEqual(PLACEHOLDER_FIELDS.lifecycle)
  })

  it("does not disable a behaviour row's OWN option at the cap, nor tell it about a cap it is not blocked by", () => {
    // Switching a behaviour to a behaviour adds nothing, so the cap has
    // nothing to say here -- and an option rendered disabled on the value
    // the control currently holds tells the operator their current state is
    // forbidden.
    render(<Harness initial={behaviorNode} behaviorCap={atCap} />)
    const row = screen.getByTestId('condition-0')
    expect(within(row).getByRole('option', { name: 'what they did' })).toBeEnabled()
    expect(within(row).queryByText(new RegExp(String(MAX_BEHAVIOR_NODES)))).toBeNull()
  })
})
