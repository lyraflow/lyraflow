import { MAX_WHERE_PREDICATES } from '@lyraflow/core/segments/ast.js'
import type { WherePredicate } from '@lyraflow/core/segments/ast.js'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { WherePredicates } from './WherePredicates.js'

function fakeClient(properties: string[] = []): ApiClient {
  return {
    schemaProperties: vi.fn(async (_p: number, _e: string | undefined, q: string) =>
      properties.filter((n) => n.startsWith(q)),
    ),
  } as unknown as ApiClient
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
    expect(screen.queryByLabelText('Property or attribute')).toBeNull()
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
    expect(row0.getByLabelText('Property or attribute')).toHaveValue('plan')
    expect(row0.getByRole('combobox', { name: /operator/i })).toHaveValue('=')
    expect(row0.getByRole('textbox', { name: /^value$/i })).toHaveValue('pro')

    const row1 = within(screen.getByTestId('beh-where-1'))
    expect(row1.getByLabelText('Property or attribute')).toHaveValue('amount')
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
      within(screen.getByTestId('beh-where-0')).getByLabelText('Property or attribute'),
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

  it('points a property row at the attribute of the same name, on the row that names it', async () => {
    // Two predicates, only ONE of them column-backed: a fixture with a
    // single row cannot tell "notes the row you are looking at" from "notes
    // the first row".
    const onChange = vi.fn()
    const value: WherePredicate[] = [
      { property: 'page', operator: '=', value: 'changelog' },
      { property: 'path', operator: '=', value: '/changelog' },
    ]
    render(
      <WherePredicates
        id="beh"
        event="page_view"
        client={fakeClient()}
        projectId={1}
        value={value}
        onChange={onChange}
      />,
    )
    expect(screen.queryByTestId('beh-where-0-note')).toBeNull()
    const note = screen.getByTestId('beh-where-1-note')
    expect(note).toHaveTextContent('Attributes')
    expect(note).toHaveTextContent('path')
    // Informing, not preventing: nothing about the value reaches the caller
    // differently, and no control is disabled.
    expect(screen.getByRole('button', { name: /add predicate/i })).toBeEnabled()
    expect(
      within(screen.getByTestId('beh-where-1')).getByLabelText('Property or attribute'),
    ).toHaveValue('path')
  })

  it('the note appears as the name is typed, before anything is saved', async () => {
    // The point of the whole thing: the operator learns that `path` names
    // an attribute WHILE writing it, not after a run answers zero. Driven
    // through
    // the real control, with the parent re-rendering from `onChange`, so
    // this fails if the note is computed from anything but the live value.
    function Harness() {
      const [value, setValue] = useState<WherePredicate[] | undefined>([
        { property: '', operator: '=', value: '' },
      ])
      return (
        <WherePredicates
          id="beh"
          event="page_view"
          client={fakeClient()}
          projectId={1}
          value={value}
          onChange={setValue}
        />
      )
    }
    render(<Harness />)
    expect(screen.queryByTestId('beh-where-0-note')).toBeNull()
    await userEvent.type(screen.getByLabelText('Property or attribute'), 'path')
    expect(screen.getByTestId('beh-where-0-note')).toHaveTextContent('Attributes')
  })

  it('says nothing at all for an ordinary property name', () => {
    render(
      <WherePredicates
        id="beh"
        event="page_view"
        client={fakeClient()}
        projectId={1}
        value={[{ property: 'page', operator: '=', value: 'changelog' }]}
        onChange={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('beh-where-0-note')).toBeNull()
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

describe('WherePredicates — attribute rows', () => {
  it('shows an attribute predicate in the field, like any other row', () => {
    render(
      <WherePredicates
        id="beh"
        event="$page"
        client={fakeClient()}
        projectId={1}
        value={[
          { source: 'attribute', attribute: 'utm_campaign', operator: '=', value: 'august-digest' },
        ]}
        onChange={vi.fn()}
      />,
    )
    const row = within(screen.getByTestId('beh-where-0'))
    expect(row.getByLabelText('Property or attribute')).toHaveValue('utm_campaign')
    expect(row.getByRole('textbox', { name: /value/i })).toHaveValue('august-digest')
    // No note: this row already reads the column, so a line telling it where
    // the value lives would be describing a problem it does not have.
    expect(screen.queryByTestId('beh-where-0-note')).toBeNull()
  })

  // Switching the field is correcting WHICH field, not starting over. Making
  // the operator retype the value because they picked the wrong half of the
  // picker would be the form charging them for its own ambiguity.
  it('keeps the operator and the value when a row changes from a property to an attribute', async () => {
    const onChange = vi.fn()
    render(
      <WherePredicates
        id="beh"
        event="$page"
        client={fakeClient(['plan'])}
        projectId={1}
        value={[{ property: 'utm_campaign', operator: '!=', value: 'august-digest' }]}
        onChange={onChange}
      />,
    )
    await userEvent.click(screen.getByLabelText('Property or attribute'))
    await waitFor(() => expect(screen.getByText('Attributes')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('option', { name: 'utm_campaign' }))
    expect(onChange).toHaveBeenLastCalledWith([
      { source: 'attribute', attribute: 'utm_campaign', operator: '!=', value: 'august-digest' },
    ])
  })

  // A property predicate must keep serialising exactly as it always did --
  // no `source` key written on save. A tree that gained one would differ
  // from the one on disk for every untouched segment, which the funnel
  // store's definition equality reads as a change.
  it('writes no source key when a row goes back to being a property', async () => {
    const onChange = vi.fn()
    render(
      <WherePredicates
        id="beh"
        event="$page"
        client={fakeClient(['path_template'])}
        projectId={1}
        value={[{ source: 'attribute', attribute: 'path', operator: '=', value: '/pricing' }]}
        onChange={onChange}
      />,
    )
    // The box holds `path`, so both sections narrow to it: the attribute
    // and a property whose name starts the same way.
    await userEvent.click(screen.getByLabelText('Property or attribute'))
    await waitFor(() => expect(screen.getByText('Properties')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('option', { name: 'path_template' }))
    expect(onChange).toHaveBeenLastCalledWith([
      { property: 'path_template', operator: '=', value: '/pricing' },
    ])
    expect(Object.keys(onChange.mock.lastCall?.[0][0] ?? {})).not.toContain('source')
  })

  // A number can only get into a predicate through the API, but it can, and
  // an attribute predicate's value is a string in the AST. Carrying the
  // number across would build a tree the server refuses while the form looks
  // complete.
  it('converts a numeric value to text when a row becomes an attribute', async () => {
    const onChange = vi.fn()
    render(
      <WherePredicates
        id="beh"
        event="$page"
        client={fakeClient([])}
        projectId={1}
        value={[{ property: 'seats', operator: '>', value: 12 }]}
        onChange={onChange}
      />,
    )
    // No attribute starts with "seats", so the box is cleared first --
    // which is what an operator changing their mind about the field does.
    await userEvent.clear(screen.getByLabelText('Property or attribute'))
    await userEvent.click(screen.getByLabelText('Property or attribute'))
    await waitFor(() => expect(screen.getByText('Attributes')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('option', { name: 'city' }))
    expect(onChange).toHaveBeenLastCalledWith([
      { source: 'attribute', attribute: 'city', operator: '>', value: '12' },
    ])
  })
})
