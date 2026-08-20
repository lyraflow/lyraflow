import type { Behavior } from '@lyraflow/core/segments/ast.js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { BehaviourForm } from './BehaviourForm.js'

/** A minimal legal `Behavior`, overridable per test. */
function beh(over: Partial<Behavior> = {}): Behavior {
  return {
    kind: 'behavior',
    event: 'checkout_completed',
    aggregate: 'count',
    window: { kind: 'last', n: 7, unit: 'days' },
    operator: '>=',
    value: 1,
    ...over,
  } as Behavior
}

function fakeClient(): ApiClient {
  return {
    schemaEvents: vi.fn(async () => []),
    schemaProperties: vi.fn(async () => []),
  } as unknown as ApiClient
}

describe('BehaviourForm', () => {
  // --- The property-field rule -----------------------------------------

  it('hides the property field for count and requires it for the others', async () => {
    const { rerender } = render(
      <BehaviourForm
        id="beh"
        node={beh({ aggregate: 'count' })}
        onChange={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    expect(screen.queryByLabelText(/property/i)).toBeNull()
    rerender(
      <BehaviourForm
        id="beh"
        node={beh({ aggregate: 'sum', property: 'amount' })}
        onChange={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    expect(screen.getByLabelText(/property/i)).toBeInTheDocument()
  })

  it('drops the property when switching to count, rather than sending an invalid node', async () => {
    const onChange = vi.fn()
    render(
      <BehaviourForm
        id="beh"
        node={beh({ aggregate: 'sum', property: 'amount' })}
        onChange={onChange}
        client={fakeClient()}
        projectId={1}
      />,
    )
    await userEvent.selectOptions(screen.getByLabelText(/aggregate/i), 'count')
    // Stub check: `onChange.mock.calls.at(-1)?.[0].property`
    // evaluates to `undefined` -- and so passes `.toBeUndefined()` -- when
    // `onChange` was NEVER CALLED AT ALL, because the `?.` short-circuits
    // the whole chain including `.property`, not just the `[0]` index. A
    // component that dropped the wire-up entirely (calls nothing) passed
    // this exact assertion. Guarding on the call
    // actually having happened, and on WHAT changed (not just what's
    // absent), is what makes this pin the real behaviour rather than the
    // absence of one.
    expect(onChange).toHaveBeenCalled()
    const call = onChange.mock.calls.at(-1)?.[0] as Behavior
    expect(call.aggregate).toBe('count')
    expect(call.property).toBeUndefined()
  })

  it('switching away from count seeds an empty property, not a stale or undefined one', async () => {
    // The other direction of the rule above -- the AST refuses
    // sum/min/max/distinct WITHOUT a property (`.refine` in ast.ts), so
    // leaving it `undefined` here would produce a node the server rejects
    // the instant the operator picks a non-count aggregate, before they've
    // typed anything wrong.
    const onChange = vi.fn()
    render(
      <BehaviourForm
        id="beh"
        node={beh({ aggregate: 'count' })}
        onChange={onChange}
        client={fakeClient()}
        projectId={1}
      />,
    )
    await userEvent.selectOptions(screen.getByLabelText(/aggregate/i), 'sum')
    const call = onChange.mock.calls.at(-1)?.[0] as Behavior
    expect(call.aggregate).toBe('sum')
    expect(call.property).toBe('')
  })

  // --- Every field reachable, and reading FROM the right one --------

  it('renders event, aggregate, operator and value seeded from the node', () => {
    render(
      <BehaviourForm
        id="beh"
        node={beh({ event: 'trial_started', aggregate: 'count', operator: '>=', value: 3 })}
        onChange={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    expect(screen.getByLabelText(/event/i)).toHaveValue('trial_started')
    expect(screen.getByLabelText(/aggregate/i)).toHaveValue('count')
    expect(screen.getByLabelText(/operator/i)).toHaveValue('>=')
    expect(screen.getByRole('textbox', { name: /^value$/i })).toHaveValue('3')
  })

  it('editing the event does not touch aggregate/operator/value/window', async () => {
    // Fixture-coincidence guard: the event fixture ('signup') and the
    // property fixture would render identically if the code accidentally
    // read one field where it meant another -- these are deliberately
    // distinct strings/numbers from everything else in this test, and the
    // window's own `n` (30) is distinct from every other number used here.
    const onChange = vi.fn()
    render(
      <BehaviourForm
        id="beh"
        node={beh({
          event: 'old_event',
          aggregate: 'sum',
          property: 'revenue_cents',
          operator: '>',
          value: 500,
          window: { kind: 'last', n: 30, unit: 'hours' },
        })}
        onChange={onChange}
        client={fakeClient()}
        projectId={1}
      />,
    )
    await userEvent.clear(screen.getByLabelText(/event/i))
    await userEvent.type(screen.getByLabelText(/event/i), 'new_event')
    const call = onChange.mock.calls.at(-1)?.[0] as Behavior
    expect(call.event).toBe('new_event')
    expect(call.aggregate).toBe('sum')
    expect(call.property).toBe('revenue_cents')
    expect(call.operator).toBe('>')
    expect(call.value).toBe(500)
    expect(call.window).toEqual({ kind: 'last', n: 30, unit: 'hours' })
  })

  it('editing the property does not touch the event -- reading from the right field, not a coincidental match', async () => {
    const onChange = vi.fn()
    render(
      <BehaviourForm
        id="beh"
        node={beh({ event: 'checkout_completed', aggregate: 'sum', property: 'old_property' })}
        onChange={onChange}
        client={fakeClient()}
        projectId={1}
      />,
    )
    await userEvent.type(screen.getByLabelText(/property/i), 'x')
    const call = onChange.mock.calls.at(-1)?.[0] as Behavior
    expect(call.property).toBe('old_propertyx')
    expect(call.event).toBe('checkout_completed')
  })

  it('changing the operator does not touch the value, and vice versa', async () => {
    const onChange = vi.fn()
    render(
      <BehaviourForm
        id="beh"
        node={beh({ operator: '>=', value: 42 })}
        onChange={onChange}
        client={fakeClient()}
        projectId={1}
      />,
    )
    await userEvent.selectOptions(screen.getByLabelText(/operator/i), '<')
    const call = onChange.mock.calls.at(-1)?.[0] as Behavior
    expect(call.operator).toBe('<')
    expect(call.value).toBe(42)
  })

  // --- Window is embedded, not reimplemented -------------------------

  it('renders the window fields, seeded from the node, and reports a change through the same onChange', async () => {
    const onChange = vi.fn()
    render(
      <BehaviourForm
        id="beh"
        node={beh({ window: { kind: 'last', n: 14, unit: 'days' } })}
        onChange={onChange}
        client={fakeClient()}
        projectId={1}
      />,
    )
    expect(screen.getByLabelText('Window amount')).toHaveValue(14)
    await userEvent.selectOptions(screen.getByLabelText('Window'), 'ever')
    const call = onChange.mock.calls.at(-1)?.[0] as Behavior
    expect(call.window).toEqual({ kind: 'ever' })
    // Nothing else on the node moved when only the window changed.
    expect(call.event).toBe('checkout_completed')
    expect(call.aggregate).toBe('count')
  })

  // --- Where predicates are embedded, scoped to the chosen event -----

  it('renders existing where predicates and scopes property suggestions to the chosen event', async () => {
    const schemaProperties = vi.fn(async () => [])
    render(
      <BehaviourForm
        id="beh"
        node={beh({
          event: 'checkout_completed',
          where: [{ property: 'plan', operator: '=', value: 'pro' }],
        })}
        onChange={vi.fn()}
        client={{ schemaEvents: vi.fn(async () => []), schemaProperties } as unknown as ApiClient}
        projectId={9}
      />,
    )
    const whereRow = within(screen.getByTestId('beh-where-0'))
    expect(whereRow.getByLabelText('Property or attribute')).toHaveValue('plan')
    await userEvent.type(whereRow.getByLabelText('Property or attribute'), 'x')
    await waitFor(() =>
      expect(schemaProperties).toHaveBeenCalledWith(9, 'checkout_completed', 'planx'),
    )
  })

  it('scopes property suggestions to undefined, not the literal string, when event is `*`', async () => {
    const schemaProperties = vi.fn(async () => [])
    render(
      <BehaviourForm
        id="beh"
        node={beh({ event: '*', aggregate: 'sum', property: '' })}
        onChange={vi.fn()}
        client={{ schemaEvents: vi.fn(async () => []), schemaProperties } as unknown as ApiClient}
        projectId={1}
      />,
    )
    await userEvent.type(screen.getByLabelText(/property/i), 'q')
    await waitFor(() => expect(schemaProperties).toHaveBeenCalledWith(1, undefined, 'q'))
  })

  it("points at the attribute here too -- a segment's where predicates hit the same compiler", () => {
    // Not a separate fix: `BehaviourForm` and `StepRows` render the SAME
    // `WherePredicates` against the SAME `wherePredicate` compiler, so a
    // behaviour's `where` on a property named `referrer` reads the same
    // empty map slot a funnel step's does, and both offer the same
    // attribute one section up. This test exists so that stays true -- a
    // note wired into one caller only would pass every funnel test and
    // leave this screen exactly as it was.
    render(
      <BehaviourForm
        id="beh"
        node={beh({
          event: 'page_view',
          where: [
            { property: 'page', operator: '=', value: 'changelog' },
            { property: 'referrer', operator: '!=', value: '' },
          ],
        })}
        onChange={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    expect(screen.queryByTestId('beh-where-0-note')).toBeNull()
    const note = screen.getByTestId('beh-where-1-note')
    expect(note).toHaveTextContent('Attributes')
    expect(note).toHaveTextContent('referrer')
  })

  it('adding a where predicate through the form updates the node, not a detached copy', async () => {
    const onChange = vi.fn()
    render(
      <BehaviourForm
        id="beh"
        node={beh({ where: undefined })}
        onChange={onChange}
        client={fakeClient()}
        projectId={1}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /add predicate/i }))
    const call = onChange.mock.calls.at(-1)?.[0] as Behavior
    expect(call.where).toEqual([{ property: '', operator: '=', value: '' }])
    // Nothing else on the node moved.
    expect(call.event).toBe('checkout_completed')
    expect(call.aggregate).toBe('count')
  })

  // --- Reading the row as a sentence ------------------------------------
  //
  // The row is a form, but an operator reads it as a claim about people:
  // "purchase at least 3 times in the last 10 days". The symbols were the
  // part that had to be translated in the operator's head; the connective
  // is what stops the translated version reading as a word salad.

  it('reads left to right as a sentence, with no symbol left to translate', () => {
    render(
      <BehaviourForm
        id="beh"
        node={beh({
          event: 'purchase',
          aggregate: 'count',
          operator: '>=',
          value: 3,
          window: { kind: 'last', n: 10, unit: 'days' },
        })}
        onChange={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    // Every control still carries the AST's own value...
    expect(screen.getByLabelText(/operator/i)).toHaveValue('>=')
    expect(screen.getByLabelText('Window')).toHaveValue('last')
    // ...and what the operator actually reads, control by control in the
    // order they appear, spells the sentence out. The event, the count and
    // the window amount are typed into fields, so they are read off their
    // values; the rest are the words this change introduced.
    expect(screen.getByLabelText(/event/i)).toHaveValue('purchase')
    expect(
      screen.getByLabelText(/operator/i).querySelector('option[value=">="]')?.textContent,
    ).toBe('at least')
    expect(screen.getByRole('textbox', { name: /^value$/i })).toHaveValue('3')
    expect(screen.getByText('times')).toBeInTheDocument()
    expect(screen.getByLabelText('Window').querySelector('option[value="last"]')?.textContent).toBe(
      'in the last…',
    )
    expect(screen.getByLabelText('Window amount')).toHaveValue(10)
    expect(screen.getByLabelText('Window unit')).toHaveValue('days')
    // The raw comparison symbol appears nowhere a person reads.
    expect(screen.queryByText('>=')).toBeNull()
  })

  it('drops the "times" connective for an aggregate that does not count occurrences', () => {
    // "sum of amount at least 3 times" is not a sentence, so the connective
    // belongs to `count` alone rather than to every behaviour.
    render(
      <BehaviourForm
        id="beh"
        node={beh({ aggregate: 'sum', property: 'amount', operator: '>=', value: 3 })}
        onChange={vi.fn()}
        client={fakeClient()}
        projectId={1}
      />,
    )
    expect(screen.queryByText('times')).toBeNull()
  })
})
