import type { Window } from '@lyraflow/core/segments/ast.js'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WindowPicker } from './WindowPicker.js'

describe('WindowPicker', () => {
  it('renders the last-variant fields (amount, unit) when given a `last` window', () => {
    const value: Window = { kind: 'last', n: 30, unit: 'days' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Window amount')).toHaveValue(30)
    expect(screen.getByLabelText('Window unit')).toHaveValue('days')
    expect(screen.queryByLabelText('From')).toBeNull()
  })

  it('renders the absolute-variant fields (from, to) when given an `absolute` window', () => {
    const value: Window = { kind: 'absolute', from: '2026-01-01T00:00', to: '2026-02-01T00:00' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('From')).toHaveValue('2026-01-01T00:00')
    expect(screen.getByLabelText('To')).toHaveValue('2026-02-01T00:00')
    expect(screen.queryByLabelText('Window amount')).toBeNull()
  })

  it('renders no extra fields for `ever`', () => {
    render(<WindowPicker id="beh" value={{ kind: 'ever' }} onChange={vi.fn()} />)
    expect(screen.queryByLabelText('Window amount')).toBeNull()
    expect(screen.queryByLabelText('From')).toBeNull()
  })

  it('switching from `last` to `absolute` does not leave n/unit on the node', async () => {
    const onChange = vi.fn()
    render(
      <WindowPicker id="beh" value={{ kind: 'last', n: 30, unit: 'days' }} onChange={onChange} />,
    )
    await userEvent.selectOptions(screen.getByLabelText('Window'), 'absolute')
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'absolute', from: '', to: '' })
  })

  it('switching from `absolute` to `ever` does not leave from/to on the node', async () => {
    const onChange = vi.fn()
    render(
      <WindowPicker
        id="beh"
        value={{ kind: 'absolute', from: '2026-01-01T00:00', to: '2026-02-01T00:00' }}
        onChange={onChange}
      />,
    )
    await userEvent.selectOptions(screen.getByLabelText('Window'), 'ever')
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'ever' })
  })

  it('switching from `ever` to `last` seeds a fresh positive n and unit, not stale/zero fields', async () => {
    const onChange = vi.fn()
    render(<WindowPicker id="beh" value={{ kind: 'ever' }} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByLabelText('Window'), 'last')
    const call = onChange.mock.calls.at(-1)?.[0] as Window
    expect(call.kind).toBe('last')
    expect(call).toEqual({ kind: 'last', n: 1, unit: 'days' })
  })

  it('editing the amount keeps the current unit, and editing the unit keeps the current amount', async () => {
    const onChange = vi.fn()
    render(
      <WindowPicker id="beh" value={{ kind: 'last', n: 7, unit: 'hours' }} onChange={onChange} />,
    )
    await userEvent.selectOptions(screen.getByLabelText('Window unit'), 'days')
    expect(onChange).toHaveBeenLastCalledWith({ kind: 'last', n: 7, unit: 'days' })
  })

  it('flags a non-positive amount as invalid, not merely accepting it silently', () => {
    const value: Window = { kind: 'last', n: 0, unit: 'days' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Window amount')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/enter a whole number/i)).toBeInTheDocument()
  })

  it('flags an unsafe integer amount as invalid -- Number.isSafeInteger, not Number.isInteger', () => {
    // 1e20 is `Number.isInteger`-true but not a safe integer -- the fifth
    // (now sixth) home of this exact bug class in this repository. Pinned
    // directly on the node's `n`, not by typing it through the input, so
    // this holds regardless of how a value this large could arrive (a
    // CLI-authored segment, not just this control).
    const value: Window = { kind: 'last', n: 1e20, unit: 'days' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Window amount')).toHaveAttribute('aria-invalid', 'true')
  })

  it('a valid positive safe integer amount is not flagged invalid', () => {
    const value: Window = { kind: 'last', n: 3650, unit: 'days' }
    render(<WindowPicker id="beh" value={value} onChange={vi.fn()} />)
    expect(screen.getByLabelText('Window amount')).toHaveAttribute('aria-invalid', 'false')
  })
})
