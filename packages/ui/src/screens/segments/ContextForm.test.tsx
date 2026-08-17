import { CONTEXT_FIELDS } from '@lyraflow/core/segments/ast.js'
import type { Context } from '@lyraflow/core/segments/ast.js'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ContextForm } from './ContextForm.js'

const ctx = (field: Context['field']): Context => ({
  kind: 'context',
  field,
  scope: 'first_touch',
  operator: '!=',
  value: 'US',
})

describe('ContextForm', () => {
  it('offers only the allowlisted context fields, from core', () => {
    render(<ContextForm id="c" node={ctx('country')} onChange={vi.fn()} />)
    const select = screen.getByRole('combobox', { name: /field/i })
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual([...CONTEXT_FIELDS])
  })

  it('starts on the field the node was given', () => {
    render(<ContextForm id="c" node={ctx('utm_source')} onChange={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: /field/i })).toHaveValue('utm_source')
  })

  // --- Mutations invented beyond the tests above --------------------------

  it('changing the field updates only field, leaving scope/operator/value untouched', async () => {
    // The fixture deliberately gives scope, operator and value distinct,
    // recognisable values ('first_touch', '!=', 'US') -- none of them equal
    // to any CONTEXT_FIELDS entry or to each other, so a handler that
    // accidentally wrote the new field into the wrong property (or
    // clobbered scope/operator/value) is visible rather than coincidentally
    // matching.
    const onChange = vi.fn()
    render(<ContextForm id="c" node={ctx('country')} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /field/i }), 'browser')
    expect(onChange).toHaveBeenCalledWith({
      kind: 'context',
      field: 'browser',
      scope: 'first_touch',
      operator: '!=',
      value: 'US',
    })
  })

  it('changing scope updates only scope, leaving field untouched', async () => {
    const onChange = vi.fn()
    render(<ContextForm id="c" node={ctx('country')} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /scope/i }), 'latest')
    expect(onChange).toHaveBeenCalledWith({
      kind: 'context',
      field: 'country',
      scope: 'latest',
      operator: '!=',
      value: 'US',
    })
  })

  it('changing the operator updates only operator, leaving field and scope untouched', async () => {
    const onChange = vi.fn()
    render(<ContextForm id="c" node={ctx('country')} onChange={onChange} />)
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /^operator$/i }), '=')
    expect(onChange).toHaveBeenCalledWith({
      kind: 'context',
      field: 'country',
      scope: 'first_touch',
      operator: '=',
      value: 'US',
    })
  })

  it('scopes every control id to the given id, so two rows never collide', () => {
    // TraitForm/ContextForm/LifecycleForm all take an `id` prop for exactly
    // this reason -- ConditionRow passes the row's own testid. A hard-coded
    // id would make every row's <Label htmlFor> resolve to whichever row
    // rendered last.
    render(<ContextForm id="condition-0" node={ctx('country')} onChange={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: /field/i })).toHaveAttribute(
      'id',
      'condition-0-field',
    )
  })
})
