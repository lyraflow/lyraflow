import type { Trait } from '@lyraflow/core/segments/ast.js'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { TraitForm } from './TraitForm.js'

const traitNode = (): Trait => ({ kind: 'trait', key: 'plan', operator: '>=', value: '3' })

/** Same shape `WherePredicates.test.tsx` uses: only the one method this
 * form's combobox reaches, cast rather than stubbed whole. */
function fakeClient(properties: string[] = []): ApiClient {
  return { schemaProperties: vi.fn(async () => properties) } as unknown as ApiClient
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
    expect(screen.getByRole('textbox', { name: /^value$/i })).toHaveValue('3')
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
    expect(screen.getByRole('textbox', { name: /^value$/i })).toHaveValue('3')
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
    const value = screen.getByRole('textbox', { name: /^value$/i })
    await userEvent.clear(value)
    await userEvent.type(value, '9')
    expect(value).toHaveValue('9')
    expect(screen.getByRole('combobox', { name: /^trait$/i })).toHaveValue('plan')
    expect(screen.getByRole('combobox', { name: /operator/i })).toHaveValue('>=')
  })

  it('offers every comparison operator, from core -- not a hand-picked subset', () => {
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
    expect(select.querySelectorAll('option')).toHaveLength(7)
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
    expect(screen.getByRole('textbox', { name: 'Value 1' })).toHaveValue('3')
    expect(screen.getByRole('textbox', { name: 'Value 2' })).toHaveValue('')
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
    await waitFor(() => expect(document.querySelectorAll('datalist option')).toHaveLength(3))
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
