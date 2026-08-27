import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ClauseValueField } from './ClauseValueField.js'

describe('ClauseValueField', () => {
  it('renders no input at all for an operator that takes no value', () => {
    render(<ClauseValueField id="c" operator="is_set" value={undefined} onChange={vi.fn()} />)
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByRole('spinbutton')).toBeNull()
    // ...and SAYS so. An empty gap where a value box was reads as a row the
    // operator has not finished.
    expect(screen.getByTestId('c-no-value')).toHaveTextContent(/no value needed/i)
  })

  it('says the same for a boolean operator', () => {
    render(<ClauseValueField id="c" operator="is_true" value={undefined} onChange={vi.fn()} />)
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('renders one plain text box for a substring match', async () => {
    const onChange = vi.fn()
    render(<ClauseValueField id="c" operator="contains" value="" onChange={onChange} />)
    await userEvent.type(screen.getByRole('textbox', { name: /value/i }), 'x')
    expect(onChange).toHaveBeenLastCalledWith('x')
  })

  it('keeps a substring a string, even when it looks like a number', async () => {
    // `contains 5` is a match against the text "5", not a numeric comparison.
    // Coercing here would compile to a search of the map that does not hold
    // it -- the same defect `coerceForKind` exists to fix for `=`, inverted.
    const onChange = vi.fn()
    render(<ClauseValueField id="c" operator="contains" value="" onChange={onChange} />)
    await userEvent.type(screen.getByRole('textbox', { name: /value/i }), '5')
    expect(onChange).toHaveBeenLastCalledWith('5')
    expect(onChange).not.toHaveBeenLastCalledWith(5)
  })

  it('renders an amount and a unit for a relative window', async () => {
    const onChange = vi.fn()
    render(
      <ClauseValueField
        id="c"
        operator="in_last"
        value={{ n: 7, unit: 'days' }}
        onChange={onChange}
      />,
    )
    expect(screen.getByRole('spinbutton', { name: /value amount/i })).toHaveValue(7)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /value unit/i }), 'hours')
    expect(onChange).toHaveBeenLastCalledWith({ n: 7, unit: 'hours' })
  })

  it('stays a controlled input when the tree arrives half-built', () => {
    // Reachable: this renders trees written by the API and the CLI, and a
    // controlled input handed `undefined` switches to uncontrolled mid-edit.
    render(<ClauseValueField id="c" operator="in_last" value={undefined} onChange={vi.fn()} />)
    expect(screen.getByRole('spinbutton', { name: /value amount/i })).toHaveValue(7)
  })
})
