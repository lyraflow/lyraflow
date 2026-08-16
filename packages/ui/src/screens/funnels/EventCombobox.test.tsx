import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { EventCombobox } from './EventCombobox.js'

describe('EventCombobox', () => {
  it('queries the schema with the typed prefix and lists what comes back', async () => {
    const schemaEvents = vi.fn(async () => ['signup_started', 'signup_completed'])
    render(
      <EventCombobox
        client={{ schemaEvents } as unknown as ApiClient}
        projectId={1}
        value=""
        onChange={() => {}}
        label="Step 1"
      />,
    )
    await userEvent.type(screen.getByLabelText('Step 1'), 'signup')
    await waitFor(() => expect(schemaEvents).toHaveBeenCalledWith(1, 'signup'))
    // `hidden: true` here is a query concession, not a product one: a
    // native `<datalist>` is `display: none` in every browser (its options
    // are read structurally, not painted), so `getByRole` -- which by
    // default excludes hidden elements the same way a sighted user's
    // browser does -- needs telling to look inside it. Production markup
    // stays exactly what a real `<input list>` needs; only the query
    // adapts to how the DOM actually presents this element.
    expect(
      await screen.findByRole('option', { name: 'signup_completed', hidden: true }),
    ).toBeInTheDocument()
  })

  it('describes itself as a prefix filter, because the server matches with startsWith', async () => {
    render(
      <EventCombobox
        client={{ schemaEvents: vi.fn(async () => []) } as unknown as ApiClient}
        projectId={1}
        value=""
        onChange={() => {}}
        label="Step 1"
      />,
    )
    expect(screen.getByLabelText('Step 1')).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/starts with/i),
    )
  })

  it('accepts a name absent from the schema -- a funnel may precede its first event', async () => {
    const onChange = vi.fn()
    render(
      <EventCombobox
        client={{ schemaEvents: vi.fn(async () => []) } as unknown as ApiClient}
        projectId={1}
        value=""
        onChange={onChange}
        label="Step 1"
      />,
    )
    await userEvent.type(screen.getByLabelText('Step 1'), 'not_yet_fired')
    expect(onChange).toHaveBeenLastCalledWith('not_yet_fired')
  })
})

// Invented beyond the brief, from the stub check: a component hardcoding a
// plausible option list and never calling `schemaEvents` at all would still
// pass a naive "shows an option" assertion. These two close that gap and
// probe the debounce and the disabled path, neither covered above.
describe('EventCombobox -- invented mutations', () => {
  it('does not query on every keystroke -- only once after the debounce settles', async () => {
    const schemaEvents = vi.fn(async () => [])
    render(
      <EventCombobox
        client={{ schemaEvents } as unknown as ApiClient}
        projectId={1}
        value=""
        onChange={() => {}}
        label="Step 1"
      />,
    )
    await userEvent.type(screen.getByLabelText('Step 1'), 'abc')
    // Immediately after typing three characters, a non-debounced
    // implementation would already have called schemaEvents three times
    // (once per keystroke). The debounced one has not fired yet at all.
    expect(schemaEvents).not.toHaveBeenCalled()
    await waitFor(() => expect(schemaEvents).toHaveBeenCalledTimes(1))
    expect(schemaEvents).toHaveBeenCalledWith(1, 'abc')
  })

  it('seeds from an externally-updated value -- the edit-mode fetch resolving after mount', async () => {
    const schemaEvents = vi.fn(async () => [])
    const { rerender } = render(
      <EventCombobox
        client={{ schemaEvents } as unknown as ApiClient}
        projectId={1}
        value=""
        onChange={() => {}}
        label="Step 1"
      />,
    )
    rerender(
      <EventCombobox
        client={{ schemaEvents } as unknown as ApiClient}
        projectId={1}
        value="page_view"
        onChange={() => {}}
        label="Step 1"
      />,
    )
    expect(screen.getByLabelText('Step 1')).toHaveValue('page_view')
  })

  it('is disabled when told to be, and reports it via the disabled attribute', () => {
    render(
      <EventCombobox
        client={{ schemaEvents: vi.fn(async () => []) } as unknown as ApiClient}
        projectId={1}
        value="cli_authored_event"
        onChange={() => {}}
        label="Step 1"
        disabled
      />,
    )
    expect(screen.getByLabelText('Step 1')).toBeDisabled()
  })
})
