import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { PropertyCombobox } from './PropertyCombobox.js'

describe('PropertyCombobox', () => {
  it('queries the schema with the typed prefix, scoped to the given event, and lists what comes back', async () => {
    const schemaProperties = vi.fn(async () => ['amount_cents', 'amount_currency'])
    render(
      <PropertyCombobox
        client={{ schemaProperties } as unknown as ApiClient}
        projectId={1}
        event="checkout_completed"
        value=""
        onChange={() => {}}
        label="Property"
      />,
    )
    await userEvent.type(screen.getByLabelText('Property'), 'amount')
    await waitFor(() =>
      expect(schemaProperties).toHaveBeenCalledWith(1, 'checkout_completed', 'amount'),
    )
    expect(
      await screen.findByRole('option', { name: 'amount_currency', hidden: true }),
    ).toBeInTheDocument()
  })

  it('passes `undefined`, never the literal event string, when there is no event to scope to', async () => {
    // Controller correction 2, Task 6 brief: the CALLER decides whether an
    // event scopes suggestions -- this component only forwards whatever it
    // is given. Pinned at this level (rather than only through
    // BehaviourForm) so the two components' contract is checked
    // independently of whichever kind of node currently uses it.
    const schemaProperties = vi.fn(async () => [])
    render(
      <PropertyCombobox
        client={{ schemaProperties } as unknown as ApiClient}
        projectId={1}
        event={undefined}
        value=""
        onChange={() => {}}
        label="Property"
      />,
    )
    await userEvent.type(screen.getByLabelText('Property'), 'amount')
    await waitFor(() => expect(schemaProperties).toHaveBeenCalledWith(1, undefined, 'amount'))
  })

  it('re-scopes the very next lookup when the event changes, not the one already in flight', async () => {
    const schemaProperties = vi.fn(async () => [])
    const { rerender } = render(
      <PropertyCombobox
        client={{ schemaProperties } as unknown as ApiClient}
        projectId={1}
        event="signup"
        value="amount"
        onChange={() => {}}
        label="Property"
      />,
    )
    rerender(
      <PropertyCombobox
        client={{ schemaProperties } as unknown as ApiClient}
        projectId={1}
        event="checkout"
        value="amount"
        onChange={() => {}}
        label="Property"
      />,
    )
    await waitFor(() => expect(schemaProperties).toHaveBeenCalledWith(1, 'checkout', 'amount'))
  })

  it('describes itself as a prefix filter, because the server matches with startsWith', () => {
    render(
      <PropertyCombobox
        client={{ schemaProperties: vi.fn(async () => []) } as unknown as ApiClient}
        projectId={1}
        event={undefined}
        value=""
        onChange={() => {}}
        label="Property"
      />,
    )
    expect(screen.getByLabelText('Property')).toHaveAttribute(
      'placeholder',
      expect.stringMatching(/starts with/i),
    )
  })

  it('accepts a name absent from the schema -- a predicate may precede its first event', async () => {
    const onChange = vi.fn()
    render(
      <PropertyCombobox
        client={{ schemaProperties: vi.fn(async () => []) } as unknown as ApiClient}
        projectId={1}
        event={undefined}
        value=""
        onChange={onChange}
        label="Property"
      />,
    )
    await userEvent.type(screen.getByLabelText('Property'), 'not_yet_seen')
    expect(onChange).toHaveBeenLastCalledWith('not_yet_seen')
  })

  it('does not query on every keystroke -- only once after the debounce settles', async () => {
    const schemaProperties = vi.fn(async () => [])
    render(
      <PropertyCombobox
        client={{ schemaProperties } as unknown as ApiClient}
        projectId={1}
        event={undefined}
        value=""
        onChange={() => {}}
        label="Property"
      />,
    )
    await userEvent.type(screen.getByLabelText('Property'), 'abc')
    expect(schemaProperties).not.toHaveBeenCalled()
    await waitFor(() => expect(schemaProperties).toHaveBeenCalledTimes(1))
    expect(schemaProperties).toHaveBeenCalledWith(1, undefined, 'abc')
  })

  it('routes a 401 to onUnauthorized rather than a permanently empty list', async () => {
    const onUnauthorized = vi.fn()
    const schemaProperties = vi.fn(async () => {
      throw new ApiError(401, 'unauthorized')
    })
    render(
      <PropertyCombobox
        client={{ schemaProperties } as unknown as ApiClient}
        projectId={1}
        event={undefined}
        value=""
        onChange={() => {}}
        label="Property"
        onUnauthorized={onUnauthorized}
      />,
    )
    await userEvent.type(screen.getByLabelText('Property'), 'amount')
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('surfaces a non-401 failure instead of silently rendering no suggestions', async () => {
    const schemaProperties = vi.fn(async () => {
      throw new ApiError(503, 'unavailable')
    })
    render(
      <PropertyCombobox
        client={{ schemaProperties } as unknown as ApiClient}
        projectId={1}
        event={undefined}
        value=""
        onChange={() => {}}
        label="Property"
      />,
    )
    await userEvent.type(screen.getByLabelText('Property'), 'amount')
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load suggestions/i)
    expect(screen.getByLabelText('Property')).toBeEnabled()
  })
})
