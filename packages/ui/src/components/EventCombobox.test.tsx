import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
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
    // A real, painted `role="option"` -- no `{ hidden: true }` concession
    // any more. The suggestions used to live in a `<datalist>`, which every
    // browser's UA stylesheet sets to `display: none`, so the query had to
    // be told to look inside a hidden subtree. They are now in a popup the
    // operator can actually see.
    expect(await screen.findByRole('option', { name: 'signup_completed' })).toBeInTheDocument()
  })

  // THE reason this field was rebuilt. An operator who does not yet know
  // their event names is exactly who a picker is for, and the old one showed
  // nothing until they had guessed the first few letters of the answer.
  // Both halves are asserted: the catalogue is fetched with an EMPTY query
  // before anything is typed, AND focusing shows it.
  it('has the whole catalogue before a keystroke, and shows it on focus', async () => {
    const schemaEvents = vi.fn(async () => ['checkout_completed', 'page_view', 'signup_started'])
    render(
      <EventCombobox
        client={{ schemaEvents } as unknown as ApiClient}
        projectId={1}
        value=""
        onChange={() => {}}
        label="Step 1"
      />,
    )
    await waitFor(() => expect(schemaEvents).toHaveBeenCalledWith(1, ''))
    expect(screen.queryByRole('listbox')).toBeNull()

    await userEvent.click(screen.getByLabelText('Step 1'))
    await waitFor(() =>
      expect(
        within(screen.getByRole('listbox'))
          .queryAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['checkout_completed', 'page_view', 'signup_started']),
    )
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
    // (once per keystroke). The debounced one has not fired at all -- not
    // even the mount lookup, whose timer each keystroke replaced before it
    // could elapse.
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

// I6 (whole-branch review): every schemaEvents() failure -- INCLUDING 401 --
// used to be swallowed into an empty options list, which reads as "your
// events do not exist" for an expired session -- the exact failure spec
// decision 6 exists to prevent for this field's ordinary empty state.
describe('EventCombobox -- errors are never silently swallowed', () => {
  it('routes a 401 to onUnauthorized rather than a permanently empty list', async () => {
    const onUnauthorized = vi.fn()
    const schemaEvents = vi.fn(async () => {
      throw new ApiError(401, 'unauthorized')
    })
    render(
      <EventCombobox
        client={{ schemaEvents } as unknown as ApiClient}
        projectId={1}
        value=""
        onChange={() => {}}
        label="Step 1"
        onUnauthorized={onUnauthorized}
      />,
    )
    await userEvent.type(screen.getByLabelText('Step 1'), 'signup')
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces a non-401 failure instead of silently rendering no suggestions', async () => {
    const schemaEvents = vi.fn(async () => {
      throw new ApiError(503, 'unavailable')
    })
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
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load suggestions/i)
    // Free-typing must still work -- this field always accepts an unlisted name.
    expect(screen.getByLabelText('Step 1')).toBeEnabled()
  })
})
