import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import type { FieldChoice } from './FieldCombobox.js'
import { FieldCombobox } from './FieldCombobox.js'

/** `path` is deliberately in BOTH lists: it is a real event column and a
 * perfectly legal property name, and telling them apart is the reason this
 * component reports a source rather than a string. */
function fakeClient(properties: string[] = ['path', 'plan', 'utm_test_variant']): ApiClient {
  return {
    schemaProperties: vi.fn(async (_p: number, _e: string | undefined, q: string) =>
      properties.filter((n) => n.startsWith(q)),
    ),
  } as unknown as ApiClient
}

function Harness(props: { initial?: FieldChoice; onChange?: (c: FieldChoice) => void }) {
  const [value, setValue] = useState<FieldChoice>(props.initial ?? { source: 'property', name: '' })
  return (
    <FieldCombobox
      client={fakeClient()}
      projectId={1}
      event="$page"
      value={value}
      onChange={(next) => {
        setValue(next)
        props.onChange?.(next)
      }}
    />
  )
}

const field = () => screen.getByRole('combobox', { name: 'Property or attribute' })
const options = () => screen.getAllByRole('option').map((o) => o.textContent)

describe('FieldCombobox', () => {
  // The reported symptom, in one test: "I don't see attributes. I see
  // properties only." Typing what the feed showed must surface it, without
  // knowing the word "attribute" or finding a control to flip.
  it('offers attributes above properties for what was typed', async () => {
    render(<Harness />)
    await userEvent.type(field(), 'utm')
    // Both sections: the attribute half is local and immediate, the
    // property half is a debounced request, and the order they end up in is
    // the point of the assertion.
    await waitFor(() => expect(screen.getByText('Properties')).toBeInTheDocument())
    expect(options()).toEqual([
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'utm_test_variant',
    ])
  })

  it('offers every attribute before anything is typed', async () => {
    render(<Harness />)
    await userEvent.click(field())
    await waitFor(() => expect(screen.getByText('Attributes')).toBeInTheDocument())
    expect(options()).toContain('utm_campaign')
    expect(options()).toContain('country')
  })

  it('states the source of the row that was chosen', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(field(), 'utm_c')
    await waitFor(() => expect(screen.getByText('Attributes')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('option', { name: 'utm_campaign' }))
    expect(onChange).toHaveBeenLastCalledWith({ source: 'attribute', name: 'utm_campaign' })
  })

  // Both sections offer `path`. Choosing one must not be resolved by the
  // name -- that is the inference this whole design refuses.
  it('tells apart a property and an attribute that share a name', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(field(), 'path')
    await waitFor(() => expect(screen.getByText('Properties')).toBeInTheDocument())
    const rows = screen.getAllByRole('option', { name: 'path' })
    expect(rows).toHaveLength(2)
    await userEvent.click(rows[1] as HTMLElement)
    expect(onChange).toHaveBeenLastCalledWith({ source: 'property', name: 'path' })

    // Same text, same two rows, the other one: choosing closes the popup, so
    // this reopens it rather than typing -- the point is which row was
    // clicked, not how the box got back open.
    await userEvent.click(field())
    await waitFor(() => expect(screen.getAllByRole('option', { name: 'path' })).toHaveLength(2))
    await userEvent.click(screen.getAllByRole('option', { name: 'path' })[0] as HTMLElement)
    expect(onChange).toHaveBeenLastCalledWith({ source: 'attribute', name: 'path' })
  })

  // Free text has no statement of source attached to it, and this field has
  // always meant a property. Guessing from the name would silently retarget
  // a predicate the operator was in the middle of typing.
  it('treats typed text as a property, even when it spells an attribute', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.type(field(), 'country')
    expect(onChange).toHaveBeenLastCalledWith({ source: 'property', name: 'country' })
  })

  // Editing a row that already names an attribute makes it a property row
  // again, from the first keystroke. Stated as a test because it is a
  // decision, not an accident: the alternative -- keeping the attribute
  // "while the text still spells it" -- cannot fire for an edit made one
  // character at a time, and a rule that never fires is worse than no rule.
  it('demotes an attribute row to a property row as soon as it is typed in', async () => {
    const onChange = vi.fn()
    render(<Harness initial={{ source: 'attribute', name: 'utm_campaign' }} onChange={onChange} />)
    await userEvent.type(field(), 's')
    expect(onChange).toHaveBeenLastCalledWith({ source: 'property', name: 'utm_campaigns' })
  })

  // The attribute list is a compile-time constant, so it is there whether or
  // not the property lookup answered. Saying "could not load" over fourteen
  // rows that ARE loaded would be describing the wrong half of the popup.
  it('still offers attributes when the property lookup fails', async () => {
    const client = {
      schemaProperties: vi.fn(async () => {
        throw new Error('boom')
      }),
    } as unknown as ApiClient
    render(
      <FieldCombobox
        client={client}
        projectId={1}
        event="$page"
        value={{ source: 'property', name: '' }}
        onChange={vi.fn()}
      />,
    )
    await userEvent.type(screen.getByRole('combobox', { name: 'Property or attribute' }), 'city')
    await waitFor(() => expect(screen.getByRole('option', { name: 'city' })).toBeInTheDocument())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
