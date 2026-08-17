import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { OperatorSelect } from './OperatorSelect.js'
import { OPERATOR_OPTIONS } from './vocabulary.js'

// The `OPERATOR_OPTIONS` pins moved to `vocabulary.test.ts` with the list
// itself -- `summarise` reads the same words now, so they are no longer this
// component's own. What stays here is what only the CONTROL can be wrong
// about: that the words reach the DOM, in order, still carrying the AST's
// values.

describe('OperatorSelect', () => {
  it('renders the words, not the symbols', () => {
    render(<OperatorSelect id="op" value=">=" onChange={vi.fn()} />)
    const options = Array.from(
      screen.getByLabelText('Operator').querySelectorAll('option'),
    ) as HTMLOptionElement[]
    expect(options.map((o) => o.textContent)).toEqual([
      'is',
      'is not',
      'more than',
      'at least',
      'less than',
      'at most',
      'between',
    ])
    // ...and they are the SHARED words, not a second list this component
    // happens to agree with today: the same record `summarise` reads.
    expect(options.map((o) => o.textContent)).toEqual(OPERATOR_OPTIONS.map((o) => o.label))
  })

  it('keeps the accessible name `Operator`, which several suites address it by', () => {
    render(<OperatorSelect id="op" value="=" onChange={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: /operator/i })).toHaveValue('=')
  })

  it('reports the AST’s own symbol when a word is chosen', async () => {
    const onChange = vi.fn()
    render(<OperatorSelect id="op" value="=" onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText('Operator'), '!=')
    expect(onChange).toHaveBeenLastCalledWith('!=')
  })

  it('can be driven by the visible word as well as by the value', async () => {
    // What an operator actually sees. Selecting by display text pins that
    // the word on screen really is attached to the option carrying `>=`,
    // which selecting by value cannot tell apart from a mislabelled list.
    const onChange = vi.fn()
    render(<OperatorSelect id="op" value="=" onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText('Operator'), screen.getByText('at least'))
    expect(onChange).toHaveBeenLastCalledWith('>=')
  })
})
