import { MAX_WHERE_PREDICATES } from '@lyraflow/core/segments/ast.js'
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

  it('refuses to add beyond the cap the AST itself enforces, and says which limit', async () => {
    // `MAX_WHERE_PREDICATES` comes from the schema that rejects an
    // eleventh, not from a number retyped here: a test asserting a literal
    // 10 would keep passing after the schema moved.
    const onChange = vi.fn()
    const value: WherePredicate[] = Array.from({ length: MAX_WHERE_PREDICATES }, (_, i) => ({
      property: `p${i}`,
      operator: '=' as const,
      value: 'x',
    }))
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
    const add = screen.getByRole('button', { name: /add predicate/i })
    expect(add).toBeDisabled()
    // Clicked anyway: a disabled native button never fires its handler, so
    // this turns "the control looks right" into "no eleventh predicate can
    // reach the caller". Removing the `disabled` prop alone fails here.
    await userEvent.click(add)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(new RegExp(`maximum is ${MAX_WHERE_PREDICATES}`))).toBeInTheDocument()
  })

  it('one below the cap still adds, so the gate is the cap and not the control', async () => {
    const onChange = vi.fn()
    const value: WherePredicate[] = Array.from({ length: MAX_WHERE_PREDICATES - 1 }, (_, i) => ({
      property: `p${i}`,
      operator: '=' as const,
      value: 'x',
    }))
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
    await userEvent.click(screen.getByRole('button', { name: /add predicate/i }))
    expect(onChange).toHaveBeenCalledWith([...value, { property: '', operator: '=', value: '' }])
    expect(screen.queryByText(/maximum is/)).toBeNull()
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
