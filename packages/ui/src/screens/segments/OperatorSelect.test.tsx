import { COMPARISON_OPERATORS } from '@lyraflow/core/segments/ast.js'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { OPERATOR_OPTIONS, OperatorSelect } from './OperatorSelect.js'

describe('OPERATOR_OPTIONS', () => {
  it('covers every operator core declares, in core’s own order', () => {
    // Driven off `COMPARISON_OPERATORS`, so an operator added there and not
    // given a word cannot quietly go missing from the list either.
    expect(OPERATOR_OPTIONS.map((o) => o.value)).toEqual([...COMPARISON_OPERATORS])
  })

  it('gives every operator a word, and never falls back to the raw symbol', () => {
    // The failure this exists to catch is silent by construction: an
    // operator with no label renders as `>=` beside six that read as
    // English, which looks like a styling slip rather than a missing entry.
    // `tsc` refuses the missing key first (the labels are an exhaustive
    // `Record`), and this is the half a test can see.
    //
    // Asserted as "is made of words" rather than "differs from its symbol":
    // `between` is BOTH, legitimately, so a difference test would have to
    // carve out an exception and would then be blind to a raw `<=` too. Every
    // symbol in `COMPARISON_OPERATORS` fails this pattern; every word passes.
    for (const { label } of OPERATOR_OPTIONS) {
      expect(label).toMatch(/^[a-z ]+$/)
    }
    // ...and the pattern really does reject the symbols it is meant to.
    for (const symbol of ['=', '!=', '>', '>=', '<', '<=']) {
      expect(symbol).not.toMatch(/^[a-z ]+$/)
    }
  })

  it('leaves every option’s stored value exactly as the AST spells it', () => {
    expect(OPERATOR_OPTIONS.map((o) => o.value)).toEqual([
      '=',
      '!=',
      '>',
      '>=',
      '<',
      '<=',
      'between',
    ])
  })
})

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
