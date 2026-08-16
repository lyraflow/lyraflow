import type { Trait } from '@lyraflow/core/segments/ast.js'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TraitForm } from './TraitForm.js'

const traitNode = (): Trait => ({ kind: 'trait', key: 'plan', operator: '>=', value: '3' })

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
  return <TraitForm id="c" node={node} onChange={setNode} />
}

describe('TraitForm', () => {
  it('renders the key, operator and value the node was given', () => {
    render(<TraitForm id="c" node={traitNode()} onChange={vi.fn()} />)
    expect(screen.getByRole('textbox', { name: /key/i })).toHaveValue('plan')
    expect(screen.getByRole('combobox', { name: /operator/i })).toHaveValue('>=')
    expect(screen.getByRole('textbox', { name: /^value$/i })).toHaveValue('3')
  })

  it('editing the key updates only key, leaving operator and value untouched', async () => {
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
    const key = screen.getByRole('textbox', { name: /key/i })
    await userEvent.clear(key)
    await userEvent.type(key, 'plan_id')
    expect(key).toHaveValue('plan_id')
    expect(screen.getByRole('combobox', { name: /operator/i })).toHaveValue('>=')
    expect(screen.getByRole('textbox', { name: /^value$/i })).toHaveValue('3')
  })

  it('changing the operator updates only operator, leaving key and value untouched', async () => {
    const onChange = vi.fn()
    render(<TraitForm id="c" node={traitNode()} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /operator/i }), '=')
    expect(onChange).toHaveBeenCalledWith({ kind: 'trait', key: 'plan', operator: '=', value: '3' })
  })

  it('editing the value through ValueInput updates only value', async () => {
    render(<Harness />)
    const value = screen.getByRole('textbox', { name: /^value$/i })
    await userEvent.clear(value)
    await userEvent.type(value, '9')
    expect(value).toHaveValue('9')
    expect(screen.getByRole('textbox', { name: /key/i })).toHaveValue('plan')
    expect(screen.getByRole('combobox', { name: /operator/i })).toHaveValue('>=')
  })

  it('offers every comparison operator, from core -- not a hand-picked subset', () => {
    render(<TraitForm id="c" node={traitNode()} onChange={vi.fn()} />)
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
