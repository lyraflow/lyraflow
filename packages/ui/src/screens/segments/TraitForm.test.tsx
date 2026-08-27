import { ALL_OPERATORS } from '@lyraflow/core/segments/ast.js'
import type { Trait } from '@lyraflow/core/segments/ast.js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { TraitForm } from './TraitForm.js'
import { clauseValueOf } from './clause.js'

const traitNode = (): Trait => ({ kind: 'trait', key: 'plan', operator: '>=', value: '3' })

/** Same shape `WherePredicates.test.tsx` uses: only the methods this form
 * reaches, cast rather than stubbed whole. Both fields suggest now -- the
 * name from the schema catalogue, the value from the trait table -- so both
 * lookups have to exist even in the tests that never touch the value box.
 *
 * Note the queries below: the value field is a `combobox`, not a `textbox`,
 * for the same reason the trait field is. An `<input list=...>` IS a
 * combobox to the accessibility tree, and that is the honest description of
 * a field that now offers a list. */
function fakeClient(properties: string[] = [], values: string[] = []): ApiClient {
  return {
    schemaProperties: vi.fn(async () =>
      properties.map((name) => ({ name, kind: 'string' as const })),
    ),
    schemaTraitValues: vi.fn(async () => values),
  } as unknown as ApiClient
}

/** `TraitForm` is fully controlled -- it never holds its own state, so a
 * static `render` against a one-shot `onChange` mock can observe a single
 * CALL but never a follow-on render: `ValueInput`'s self-heal effect needs
 * one, and so does realistic multi-keystroke typing (`userEvent.type`
 * against an input whose `value` prop never updates leaves the DOM glued to
 * the ORIGINAL value between keystrokes, which is what makes typed text
 * come out garbled for reasons that have nothing to do with the form under
 * test). This wrapper feeds `onChange` back into `node`, the same way
 * `ConditionRow` does via `GroupCard`/`replaceAt`, so both cases render
 * realistically. */
function Harness() {
  const [node, setNode] = useState<Trait>(traitNode())
  return <TraitForm id="c" node={node} onChange={setNode} client={fakeClient()} projectId={7} />
}

describe('TraitForm', () => {
  it('renders the trait, operator and value the node was given', () => {
    render(
      <TraitForm
        id="c"
        node={traitNode()}
        onChange={vi.fn()}
        client={fakeClient()}
        projectId={7}
      />,
    )
    expect(screen.getByRole('combobox', { name: /^trait$/i })).toHaveValue('plan')
    expect(screen.getByRole('combobox', { name: /operator/i })).toHaveValue('>=')
    expect(screen.getByRole('combobox', { name: /^value$/i })).toHaveValue('3')
  })

  it('editing the trait updates only key, leaving operator and value untouched', async () => {
    // `key`, `operator` and `value` are deliberately distinct strings
    // ('plan', '>=', '3') -- none equal to each other or to the typed
    // edit -- so a handler that writes the new key into the wrong field,
    // or drops an unrelated one, is visible rather than coincidentally
    // passing. Rendered through `Harness`, not a static `onChange` mock --
    // `TraitForm` is fully controlled, so a mock that never feeds back into
    // `node` leaves the input glued to its ORIGINAL value between
    // keystrokes, and multi-key typing on a stale value is exactly what
    // produces a garbled result unrelated to the form's own correctness.
    render(<Harness />)
    const key = screen.getByRole('combobox', { name: /^trait$/i })
    await userEvent.clear(key)
    await userEvent.type(key, 'plan_id')
    expect(key).toHaveValue('plan_id')
    expect(screen.getByRole('combobox', { name: /operator/i })).toHaveValue('>=')
    expect(screen.getByRole('combobox', { name: /^value$/i })).toHaveValue('3')
  })

  it('changing the operator updates only operator, leaving key and value untouched', async () => {
    const onChange = vi.fn()
    render(
      <TraitForm
        id="c"
        node={traitNode()}
        onChange={onChange}
        client={fakeClient()}
        projectId={7}
      />,
    )
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /operator/i }), '=')
    expect(onChange).toHaveBeenCalledWith({ kind: 'trait', key: 'plan', operator: '=', value: '3' })
  })

  it('editing the value through ValueInput updates only value', async () => {
    render(<Harness />)
    const value = screen.getByRole('combobox', { name: /^value$/i })
    await userEvent.clear(value)
    await userEvent.type(value, '9')
    expect(value).toHaveValue('9')
    expect(screen.getByRole('combobox', { name: /^trait$/i })).toHaveValue('plan')
    expect(screen.getByRole('combobox', { name: /operator/i })).toHaveValue('>=')
  })

  it('offers every operator, from core -- not a hand-picked subset', () => {
    render(
      <TraitForm
        id="c"
        node={traitNode()}
        onChange={vi.fn()}
        client={fakeClient()}
        projectId={7}
      />,
    )
    const select = screen.getByRole('combobox', { name: /operator/i })
    // Driven off core's own list rather than a literal count, which is what
    // the test's name has always claimed. It was `7`, and a hard-coded count
    // is exactly the hand-picked subset it was written to prevent -- it went
    // red on a change that ADDED operators correctly.
    expect(select.querySelectorAll('option')).toHaveLength(ALL_OPERATORS.length)
  })

  it('offers all five families on a trait, because a trait can hold anything', () => {
    render(
      <TraitForm
        id="c"
        node={traitNode()}
        onChange={vi.fn()}
        client={fakeClient()}
        projectId={7}
      />,
    )
    const select = screen.getByRole('combobox', { name: /operator/i })
    const groups = [...select.querySelectorAll('optgroup')].map((g) => g.getAttribute('label'))
    expect(groups).toEqual(['Compare', 'Text', 'Presence', 'True or false', 'Relative date'])
  })

  it('switching to between round-trips through ValueInput self-heal to two populated inputs', async () => {
    // An end-to-end pin, not just ValueInput's own unit test: the operator
    // select's handler changes ONLY `operator` (`{...node, operator}`,
    // never reshaping `value` itself), and it is ValueInput's effect, on
    // the round trip back through `onChange`, that expands the stray
    // scalar into a two-slot tuple. A form that tried to pre-shape `value`
    // itself when the operator changes would duplicate that logic instead
    // of relying on it -- this is the test that would catch the two
    // disagreeing.
    render(<Harness />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /operator/i }), 'between')
    expect(screen.getByRole('combobox', { name: 'Value 1' })).toHaveValue('3')
    expect(screen.getByRole('combobox', { name: 'Value 2' })).toHaveValue('')
  })
})

describe('TraitForm -- knowing what to type', () => {
  it('suggests the traits this project has recorded, before a single keystroke', async () => {
    // The whole point of the field: an operator who does not already know
    // their trait names gets the list without having to guess a prefix
    // first. `schemaProperties` is asked with an EMPTY query -- a lookup
    // that only fires after typing would leave this field exactly as
    // unhelpful as the bare text box it replaced.
    const client = fakeClient(['country', 'plan', 'signup_source'])
    render(
      <TraitForm
        id="c"
        node={{ kind: 'trait', key: '', operator: '=', value: '' }}
        onChange={vi.fn()}
        client={client}
        projectId={7}
      />,
    )
    await waitFor(() => expect(client.schemaProperties).toHaveBeenCalledWith(7, '$identify', ''))
    // ...and focusing shows them, without a keystroke. Both halves matter:
    // the fetch alone is invisible, and a popup that opens on an empty list
    // is the field this replaced.
    await userEvent.click(screen.getByRole('combobox', { name: /^trait$/i }))
    await waitFor(() =>
      expect(
        within(screen.getByRole('listbox'))
          .queryAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['country', 'plan', 'signup_source']),
    )
  })

  it('scopes suggestions to identify traits, never every property in the project', async () => {
    // `$identify`'s property bag IS the traits bag, so the event scope is
    // what makes this a trait list rather than a list of every event
    // property ever seen. Passing `undefined` here would still populate the
    // dropdown -- with mostly names that are not traits at all -- so this
    // asserts the argument, not merely that something was fetched.
    const client = fakeClient(['plan'])
    render(<TraitForm id="c" node={traitNode()} onChange={vi.fn()} client={client} projectId={7} />)
    await waitFor(() => expect(client.schemaProperties).toHaveBeenCalled())
    for (const call of (client.schemaProperties as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toBe('$identify')
    }
  })

  it('says why the list is empty rather than showing an empty dropdown', async () => {
    // A project that has never called identify() has no traits, and an
    // empty picker is indistinguishable from a broken one. The copy has to
    // name the cause.
    render(
      <TraitForm
        id="c"
        node={{ kind: 'trait', key: '', operator: '=', value: '' }}
        onChange={vi.fn()}
        client={fakeClient([])}
        projectId={7}
      />,
    )
    // In the popup, where the operator is looking when they find it empty --
    // not in a line under a field they have already given up on.
    await userEvent.click(screen.getByRole('combobox', { name: /^trait$/i }))
    await waitFor(() => expect(screen.getByText(/no traits recorded yet/i)).toBeInTheDocument())
  })

  it('does not claim there are no traits before the first lookup answers', async () => {
    // Guards the `fetched` flag. A never-settling lookup must leave the
    // field silent, not assert an absence it has no evidence for.
    const client = {
      schemaProperties: vi.fn(() => new Promise<string[]>(() => {})),
    } as unknown as ApiClient
    render(
      <TraitForm
        id="c"
        node={{ kind: 'trait', key: '', operator: '=', value: '' }}
        onChange={vi.fn()}
        client={client}
        projectId={7}
      />,
    )
    await waitFor(() => expect(client.schemaProperties).toHaveBeenCalled())
    // Opened, so the popup is on screen and had every chance to say it: the
    // assertion would pass trivially against a closed one.
    await userEvent.click(screen.getByRole('combobox', { name: /^trait$/i }))
    expect(screen.getByRole('listbox')).toBeInTheDocument()
    expect(screen.queryByText(/no traits recorded yet/i)).not.toBeInTheDocument()
  })

  it('still accepts a trait the project has never sent', async () => {
    // Free-typed on purpose: a segment may legitimately be written ahead of
    // the instrumentation that fills it, so the suggestions must not become
    // a whitelist.
    const onChange = vi.fn()
    render(
      <TraitForm
        id="c"
        node={{ kind: 'trait', key: '', operator: '=', value: '' }}
        onChange={onChange}
        client={fakeClient(['plan'])}
        projectId={7}
      />,
    )
    await userEvent.type(screen.getByRole('combobox', { name: /^trait$/i }), 'x')
    expect(onChange).toHaveBeenCalledWith({ kind: 'trait', key: 'x', operator: '=', value: '' })
  })

  it('tells the operator where these names come from', () => {
    render(
      <TraitForm
        id="c"
        node={traitNode()}
        onChange={vi.fn()}
        client={fakeClient()}
        projectId={7}
      />,
    )
    expect(screen.getByText(/identify\(\)/i)).toBeInTheDocument()
  })
})

describe('TraitForm -- knowing what to type in the value box', () => {
  // THE wiring test, and the one place the two fields are checked against
  // each other. `TraitValueField`'s own suite proves it asks for whatever
  // trait it is handed; this proves the form hands it the trait the operator
  // actually chose. A form that passed a constant, the operator, or the
  // previous key would satisfy every test in that suite and still suggest
  // the wrong project's vocabulary here -- which is why the trait name below
  // is nothing like anything else on the form.
  it('asks for the values of the trait named in this row', async () => {
    const client = fakeClient([], ['ios', 'web'])
    render(
      <TraitForm
        id="c"
        node={{ kind: 'trait', key: 'signup_source', operator: '=', value: '' }}
        onChange={vi.fn()}
        client={client}
        projectId={7}
      />,
    )
    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await waitFor(() =>
      expect(client.schemaTraitValues).toHaveBeenCalledWith(7, 'signup_source', ''),
    )
  })

  // The asymmetry, asserted as one fact rather than two: the name field
  // reads a catalogue and may fetch before anything is typed; the value
  // field scans a fact table and may not. Both are on this form, so a change
  // that made them behave alike -- in either direction -- fails here.
  it('suggests names before a keystroke and values only on demand', async () => {
    const client = fakeClient(['plan'], ['pro'])
    render(<TraitForm id="c" node={traitNode()} onChange={vi.fn()} client={client} projectId={7} />)
    await waitFor(() => expect(client.schemaProperties).toHaveBeenCalled())
    // Long enough for the value field's own debounce to have fired, had it
    // scheduled anything on render.
    await new Promise((r) => setTimeout(r, 400))
    expect(client.schemaTraitValues).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('combobox', { name: /^value$/i }))
    await waitFor(() => expect(client.schemaTraitValues).toHaveBeenCalled())
  })

  it('offers the values that came back, and still accepts one that did not', async () => {
    render(
      <TraitForm
        id="c"
        node={traitNode()}
        onChange={vi.fn()}
        client={fakeClient([], ['free', 'pro'])}
        projectId={7}
      />,
    )
    const box = screen.getByRole('combobox', { name: /^value$/i })
    await userEvent.click(box)
    await waitFor(() =>
      expect(
        within(screen.getByRole('listbox'))
          .queryAllByRole('option')
          .map((o) => o.textContent),
      ).toContain('pro'),
    )
    // The suggestions are not a whitelist -- see TraitValueField's own test.
    // Asserted through the real form too, because this is the rule most
    // likely to be lost when someone later reaches for a `<select>`.
    expect(box).not.toBeDisabled()
    expect(box).toHaveAttribute('aria-controls', screen.getByRole('listbox').id)
    expect(box).not.toHaveAttribute('readonly')
  })
})

// The same defect `WherePredicates` had, one node type over: `traitExpr`
// picks `t_str` or `t_num` from the JavaScript type of the value, and this
// form could only ever produce a string. Verified live at the time of the
// fix -- trait `seats = "12"` found 0 people where `seats = 12` found 20.
describe("TraitForm — the value carries the trait's kind", () => {
  const numericTraits = {
    schemaProperties: vi.fn(async () => [{ name: 'seats', kind: 'number' as const }]),
    schemaTraitValues: vi.fn(async () => []),
  } as unknown as ApiClient

  function Harness(props: { client: ApiClient; node: Trait }) {
    const [node, setNode] = useState<Trait>(props.node)
    current = node
    return <TraitForm id="c" node={node} onChange={setNode} client={props.client} projectId={7} />
  }

  let current: Trait

  it('converts the value once the schema says the trait is numeric', async () => {
    render(
      <Harness
        client={numericTraits}
        node={{ kind: 'trait', key: 'seats', operator: '=', value: '12' }}
      />,
    )
    await waitFor(() => expect(clauseValueOf(current)).toBe(12))
  })

  it('leaves a text trait alone', async () => {
    const client = {
      schemaProperties: vi.fn(async () => [{ name: 'plan', kind: 'string' as const }]),
      schemaTraitValues: vi.fn(async () => []),
    } as unknown as ApiClient
    render(
      <Harness
        client={client}
        node={{ kind: 'trait', key: 'plan', operator: '=', value: 'pro' }}
      />,
    )
    await waitFor(() => expect(client.schemaProperties).toHaveBeenCalled())
    expect(clauseValueOf(current)).toBe('pro')
  })

  it('says so when the trait has never been recorded and the value looks numeric', async () => {
    render(
      <Harness
        client={fakeClient([])}
        node={{ kind: 'trait', key: 'seats', operator: '=', value: '12' }}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('c-kind-note')).toHaveTextContent('as text'))
  })
})
