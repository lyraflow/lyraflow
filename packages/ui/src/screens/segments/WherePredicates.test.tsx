import type { WherePredicate } from '@lyraflow/core/segments/ast.js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { WherePredicates } from './WherePredicates.js'

function fakeClient(): ApiClient {
  return { schemaProperties: vi.fn(async () => []) } as unknown as ApiClient
}

describe('WherePredicates', () => {
  it('renders nothing but the Add button when there are no predicates yet', () => {
    render(
      <WherePredicates
        id="beh"
        event="checkout"
        client={fakeClient()}
        projectId={1}
        value={undefined}
        onChange={vi.fn()}
      />,
    )
    expect(screen.queryByLabelText('Property')).toBeNull()
    expect(screen.getByRole('button', { name: /add predicate/i })).toBeInTheDocument()
  })

  it('renders one row per existing predicate, with its own property/operator/value', () => {
    const value: WherePredicate[] = [
      { property: 'plan', operator: '=', value: 'pro' },
      { property: 'amount', operator: '>', value: 100 },
    ]
    render(
      <WherePredicates
        id="beh"
        event="checkout"
        client={fakeClient()}
        projectId={1}
        value={value}
        onChange={vi.fn()}
      />,
    )
    const row0 = within(screen.getByTestId('beh-where-0'))
    expect(row0.getByLabelText('Property')).toHaveValue('plan')
    expect(row0.getByRole('combobox', { name: /operator/i })).toHaveValue('=')
    expect(row0.getByRole('textbox', { name: /^value$/i })).toHaveValue('pro')

    const row1 = within(screen.getByTestId('beh-where-1'))
    expect(row1.getByLabelText('Property')).toHaveValue('amount')
    expect(row1.getByRole('combobox', { name: /operator/i })).toHaveValue('>')
    expect(row1.getByRole('textbox', { name: /^value$/i })).toHaveValue('100')
  })

  it('Add predicate appends a fresh, empty predicate to the end', async () => {
    const onChange = vi.fn()
    render(
      <WherePredicates
        id="beh"
        event="checkout"
        client={fakeClient()}
        projectId={1}
        value={[{ property: 'plan', operator: '=', value: 'pro' }]}
        onChange={onChange}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /add predicate/i }))
    expect(onChange).toHaveBeenCalledWith([
      { property: 'plan', operator: '=', value: 'pro' },
      { property: '', operator: '=', value: '' },
    ])
  })

  it('removing the only predicate reports `undefined`, never an empty array', async () => {
    // `Behavior.where` is `.optional()`, not defaulted to `[]` -- an empty
    // array and "unset" are different wire shapes, and this preserves the
    // distinction on the way OUT, matching how `value` accepts `undefined`
    // on the way in.
    const onChange = vi.fn()
    render(
      <WherePredicates
        id="beh"
        event="checkout"
        client={fakeClient()}
        projectId={1}
        value={[{ property: 'plan', operator: '=', value: 'pro' }]}
        onChange={onChange}
      />,
    )
    await userEvent.click(
      within(screen.getByTestId('beh-where-0')).getByRole('button', { name: /remove/i }),
    )
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('removing one predicate of several leaves the others, and does not touch their own values', async () => {
    const onChange = vi.fn()
    const value: WherePredicate[] = [
      { property: 'plan', operator: '=', value: 'pro' },
      { property: 'amount', operator: '>', value: 100 },
      { property: 'country', operator: '=', value: 'US' },
    ]
    render(
      <WherePredicates
        id="beh"
        event="checkout"
        client={fakeClient()}
        projectId={1}
        value={value}
        onChange={onChange}
      />,
    )
    await userEvent.click(
      within(screen.getByTestId('beh-where-1')).getByRole('button', { name: /remove/i }),
    )
    expect(onChange).toHaveBeenCalledWith([
      { property: 'plan', operator: '=', value: 'pro' },
      { property: 'country', operator: '=', value: 'US' },
    ])
  })

  it('editing one predicate does not touch its sibling', async () => {
    const onChange = vi.fn()
    const value: WherePredicate[] = [
      { property: 'plan', operator: '=', value: 'pro' },
      { property: 'amount', operator: '>', value: 100 },
    ]
    render(
      <WherePredicates
        id="beh"
        event="checkout"
        client={fakeClient()}
        projectId={1}
        value={value}
        onChange={onChange}
      />,
    )
    await userEvent.selectOptions(
      within(screen.getByTestId('beh-where-0')).getByRole('combobox', { name: /operator/i }),
      '!=',
    )
    expect(onChange).toHaveBeenLastCalledWith([
      { property: 'plan', operator: '!=', value: 'pro' },
      { property: 'amount', operator: '>', value: 100 },
    ])
  })

  it('scopes property suggestions to the given event, and forwards `undefined` when told to', async () => {
    const schemaProperties = vi.fn(async () => [])
    render(
      <WherePredicates
        id="beh"
        event={undefined}
        client={{ schemaProperties } as unknown as ApiClient}
        projectId={7}
        value={[{ property: '', operator: '=', value: '' }]}
        onChange={vi.fn()}
      />,
    )
    await userEvent.type(
      within(screen.getByTestId('beh-where-0')).getByLabelText('Property'),
      'amt',
    )
    await waitFor(() => expect(schemaProperties).toHaveBeenCalledWith(7, undefined, 'amt'))
  })

  it('switching to `between` gives two value inputs, reusing ValueInput rather than reimplementing it', () => {
    const value: WherePredicate[] = [{ property: 'amount', operator: 'between', value: [1, 100] }]
    render(
      <WherePredicates
        id="beh"
        event="checkout"
        client={fakeClient()}
        projectId={1}
        value={value}
        onChange={vi.fn()}
      />,
    )
    const row = within(screen.getByTestId('beh-where-0'))
    expect(
      row
        .getAllByRole('textbox')
        .filter((el) => el.getAttribute('aria-label')?.startsWith('Value')),
    ).toHaveLength(2)
  })
})
