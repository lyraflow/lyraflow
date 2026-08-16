import type { Lifecycle } from '@lyraflow/core/segments/ast.js'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { LifecycleForm } from './LifecycleForm.js'

const lifecycleNode = (): Lifecycle => ({
  kind: 'lifecycle',
  field: 'first_seen',
  operator: '>=',
  value: '2026-01-01T00:00',
})

describe('LifecycleForm', () => {
  it('offers exactly first_seen and last_seen as field options', () => {
    render(<LifecycleForm id="c" node={lifecycleNode()} onChange={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: /field/i })
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['first_seen', 'last_seen'])
  })

  it('renders the value control as a datetime picker, not a free text box', () => {
    // The single most concrete requirement in the brief: "Lifecycle values
    // must parse as datetimes; use a datetime control rather than a free
    // text box." A stub that rendered a plain text input with the right
    // value would pass every OTHER assertion in this file.
    const { container } = render(<LifecycleForm id="c" node={lifecycleNode()} onChange={vi.fn()} />)
    const input = container.querySelector('input[aria-label="Value"]')
    expect(input).toHaveAttribute('type', 'datetime-local')
    expect(input).toHaveValue('2026-01-01T00:00')
  })

  it('changing the field updates only field, leaving operator and value untouched', async () => {
    const onChange = vi.fn()
    render(<LifecycleForm id="c" node={lifecycleNode()} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /field/i }), 'last_seen')
    expect(onChange).toHaveBeenCalledWith({
      kind: 'lifecycle',
      field: 'last_seen',
      operator: '>=',
      value: '2026-01-01T00:00',
    })
  })

  it('changing the operator updates only operator, leaving field and value untouched', async () => {
    const onChange = vi.fn()
    render(<LifecycleForm id="c" node={lifecycleNode()} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^operator$/i }), '<')
    expect(onChange).toHaveBeenCalledWith({
      kind: 'lifecycle',
      field: 'first_seen',
      operator: '<',
      value: '2026-01-01T00:00',
    })
  })
})
