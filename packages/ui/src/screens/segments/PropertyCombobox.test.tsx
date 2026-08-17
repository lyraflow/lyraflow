import { render, screen, waitFor, within } from '@testing-library/react'
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
    expect(await screen.findByRole('option', { name: 'amount_currency' })).toBeInTheDocument()
  })

  // The rule this field's own doc comment used to argue AGAINST, and the
  // correction: an unfiltered list is noisy, but a picker that shows nothing
  // until the operator already knows the first letters of the answer is not
  // a picker at all. `event_schema` is a catalogue, so asking on render is
  // affordable -- and the popup opens on focus with what came back.
  it('asks with an empty query on mount, and shows the answer on focus', async () => {
    const schemaProperties = vi.fn(async () => ['amount_cents', 'currency', 'plan_id'])
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
    await waitFor(() => expect(schemaProperties).toHaveBeenCalledWith(1, 'checkout_completed', ''))
    expect(screen.queryByRole('listbox')).toBeNull()

    await userEvent.click(screen.getByLabelText('Property'))
    await waitFor(() =>
      expect(
        within(screen.getByRole('listbox'))
          .queryAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['amount_cents', 'currency', 'plan_id']),
    )
  })

  it('passes `undefined`, never the literal event string, when there is no event to scope to', async () => {
    // The CALLER decides whether an
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
    // Not even the mount lookup has fired: each keystroke replaced its
    // pending timer before the debounce could elapse.
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

  it('does not re-ask the server just because the parent re-rendered', async () => {
    // `onUnauthorized` is the kind of callback a parent re-creates inline on
    // every one of ITS renders. While it was named in the lookup effect's
    // dependency list, an unrelated render anywhere above this field issued
    // another request for a query that had not changed -- one wasted call per
    // parent render, against an endpoint whose cost is the reason the trait
    // VALUE lookup is deliberately on-demand.
    //
    // A fresh arrow on every render is the point of this test, not an
    // oversight: a stable `useCallback` would pass whether or not the bug
    // exists, which makes it the coincidence-point version of this test.
    const schemaProperties = vi.fn(async () => ['amount_cents'])
    const client = { schemaProperties } as unknown as ApiClient
    const view = render(
      <PropertyCombobox
        client={client}
        projectId={7}
        event="checkout"
        value="amount"
        onChange={vi.fn()}
        label="Property"
        onUnauthorized={() => {}}
      />,
    )
    await waitFor(() => expect(schemaProperties).toHaveBeenCalledTimes(1))

    // The debounce has to be allowed to ELAPSE between re-renders, and this
    // is the whole difficulty of pinning this. Re-rendering three times in a
    // row proves nothing: each re-run of the effect clears the pending timer
    // and sets a new one, so the lookup still fires exactly once and the
    // assertion passes whether or not the dependency is there. That version of
    // this test was written first and passed against the bug.
    //
    // Waiting past the debounce after a re-render is what separates them: with
    // `onUnauthorized` in the dependency list, the effect re-runs, its new
    // timer expires, and a second identical request goes out.
    view.rerender(
      <PropertyCombobox
        client={client}
        projectId={7}
        event="checkout"
        value="amount"
        onChange={vi.fn()}
        label="Property"
        onUnauthorized={() => {}}
      />,
    )
    await new Promise((resolve) => setTimeout(resolve, 800))
    // Same query, same event, same project: a parent render is a new chance to
    // ask and not a new question.
    expect(schemaProperties).toHaveBeenCalledTimes(1)
  })

  it('still routes a 401 through the callback the parent passed most recently', async () => {
    // The other half of holding the callback in a ref: reading `.current`
    // must not pin the FIRST callback the component ever saw. Without this,
    // moving the callback out of the dependency list could be "fixed" by
    // capturing it once, which silently routes an expired session to a
    // handler the parent has already replaced.
    const schemaProperties = vi.fn(async () => {
      throw new ApiError(401, 'unauthorized')
    })
    const client = { schemaProperties } as unknown as ApiClient
    const stale = vi.fn()
    const current = vi.fn()
    const view = render(
      <PropertyCombobox
        client={client}
        projectId={7}
        event="checkout"
        value=""
        onChange={vi.fn()}
        label="Property"
        onUnauthorized={stale}
      />,
    )
    view.rerender(
      <PropertyCombobox
        client={client}
        projectId={7}
        event="checkout"
        value=""
        onChange={vi.fn()}
        label="Property"
        onUnauthorized={current}
      />,
    )
    await userEvent.type(screen.getByLabelText('Property'), 'amount')
    await waitFor(() => expect(current).toHaveBeenCalledTimes(1))
    expect(stale).not.toHaveBeenCalled()
  })
})
