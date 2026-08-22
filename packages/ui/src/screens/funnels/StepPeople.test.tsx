import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { FunnelPeoplePage, MemberRow } from '../../api/types.js'
import { StepPeople } from './StepPeople.js'

function member(id: string): MemberRow {
  return {
    person_id: id,
    first_seen: '2026-08-01T00:00:00.000Z',
    last_seen: '2026-08-10T00:00:00.000Z',
    traits: {},
    traits_num: {},
    trait_total: 0,
  }
}

const RANGE = { since: '2026-08-08T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' }

function page(over: Partial<FunnelPeoplePage> = {}): FunnelPeoplePage {
  return {
    members: [member('person-0')],
    next_cursor: null,
    window_exhausted: false,
    person_count: 1,
    as_of: '2026-08-15T12:00:00.000Z',
    range: RANGE,
    ...over,
  }
}

function fakeClient(funnelPeople: Mock) {
  return { funnelPeople } as unknown as ApiClient & { funnelPeople: Mock }
}

const BASE_PROPS = { projectId: 1, funnelId: 7, step: 2, range: RANGE }

describe('StepPeople', () => {
  it('renders a reached/dropped toggle and a MemberList, and fetches nothing until asked', () => {
    const funnelPeople = vi.fn(async () => page())
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />)
    expect(screen.getByRole('button', { name: /^reached/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^dropped here/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show people/i })).toBeInTheDocument()
    expect(funnelPeople).not.toHaveBeenCalled()
  })

  it('fetches reached (the default mode) for the given project/funnel/step/range when "Show people" is clicked', async () => {
    const funnelPeople = vi.fn(async () => page({ person_count: 134 }))
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />)
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(1))
    expect(funnelPeople).toHaveBeenCalledWith(1, 7, {
      step: 2,
      mode: 'reached',
      since: RANGE.since,
      until: RANGE.until,
      cursor: undefined,
    })
  })

  it("labels each toggle option with ITS OWN count once known, never the other mode's number", async () => {
    const funnelPeople = vi.fn(async (_p: number, _f: number, body: { mode: string }) =>
      body.mode === 'reached' ? page({ person_count: 134 }) : page({ person_count: 47 }),
    )
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />)

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    expect(await screen.findByRole('button', { name: 'Reached (134)' })).toBeInTheDocument()
    // Dropped has not been fetched yet -- its button must not show ANY
    // count, and must not borrow reached's number either.
    expect(screen.getByRole('button', { name: 'Dropped here' })).toBeInTheDocument()
    expect(screen.queryByText(/Dropped here \(/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Dropped here' }))
    await userEvent.click(await screen.findByRole('button', { name: /show people/i }))
    expect(await screen.findByRole('button', { name: 'Dropped here (47)' })).toBeInTheDocument()
    // Switching back to dropped must not have dropped reached's own count.
    expect(screen.getByRole('button', { name: 'Reached (134)' })).toBeInTheDocument()
  })

  // The sharpest guard on this component: a cursor belongs to one
  // population, so switching mode must not let the walk continue with the
  // OTHER mode's cursor (the server would refuse it by label anyway, but a
  // client that never even tries to continue is the point). Proved by
  // actually establishing a real cursor under `reached` (a two-page walk),
  // then switching and checking BOTH that the old page's rows are gone AND
  // that the resumed request after switching carries `cursor: undefined`,
  // not the stale one.
  it('switching mode restarts the walk from page one instead of continuing the old cursor', async () => {
    const funnelPeople = vi.fn(async (_p: number, _f: number, body: Record<string, unknown>) => {
      if (body.mode === 'reached' && body.cursor == null) {
        return page({
          members: [member('person-0')],
          person_count: 134,
          next_cursor: 'reached-cursor-1',
          window_exhausted: false,
        })
      }
      if (body.mode === 'reached') {
        return page({ members: [member('person-1')], person_count: 134 })
      }
      return page({ members: [member('person-dropped-0')], person_count: 47 })
    })
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />)

    // Load reached's first page, then its second -- a real cursor now exists.
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    await userEvent.click(await screen.findByRole('button', { name: /load more/i }))
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('person-1')).toBeInTheDocument()

    // Switch to dropped. The reached rows must be gone immediately, and the
    // list must be back to its pre-fetch state, not left showing stale rows
    // under the newly selected mode.
    await userEvent.click(screen.getByRole('button', { name: /^dropped here/i }))
    expect(screen.queryByText('person-1')).not.toBeInTheDocument()
    expect(screen.queryByText('person-0')).not.toBeInTheDocument()
    const showAgain = await screen.findByRole('button', { name: /show people/i })

    await userEvent.click(showAgain)
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(3))
    expect(funnelPeople).toHaveBeenNthCalledWith(3, 1, 7, {
      step: 2,
      mode: 'dropped',
      since: RANGE.since,
      until: RANGE.until,
      cursor: undefined,
    })
    expect(await screen.findByText('person-dropped-0')).toBeInTheDocument()
  })

  it('an error surfaces without removing the toggle', async () => {
    const funnelPeople = vi.fn(async () => {
      throw new Error('boom')
    })
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />)
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i)
    expect(screen.getByRole('button', { name: /^reached/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^dropped here/i })).toBeInTheDocument()
  })

  it("routes a 401 to onUnauthorized, same as this screen's other fetches", async () => {
    const onUnauthorized = vi.fn()
    const funnelPeople = vi.fn(async () => {
      throw new ApiError(401, 'unauthorized')
    })
    render(
      <StepPeople
        client={fakeClient(funnelPeople)}
        {...BASE_PROPS}
        onUnauthorized={onUnauthorized}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
  })
})

describe('StepPeople -- seeded counts', () => {
  it('shows both seeded counts immediately, with no fetch at all', () => {
    const funnelPeople = vi.fn(async () => page())
    render(
      <StepPeople
        client={fakeClient(funnelPeople)}
        {...BASE_PROPS}
        seedCounts={{ reached: 134, dropped: 47 }}
      />,
    )
    expect(screen.getByRole('button', { name: 'Reached (134)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dropped here (47)' })).toBeInTheDocument()
    expect(funnelPeople).not.toHaveBeenCalled()
  })

  // The seed is provisional, not a cache: it can be stale by the time an
  // operator actually opens a mode, so a real fetch for that mode must
  // overwrite it -- and ONLY that mode's seed, not the other one, which is
  // still all the reader has for the mode not yet opened.
  it("a resolved fetch overrides ITS OWN mode's seed with the fresher number, and leaves the other mode's seed alone", async () => {
    const funnelPeople = vi.fn(async () => page({ person_count: 140 }))
    render(
      <StepPeople
        client={fakeClient(funnelPeople)}
        {...BASE_PROPS}
        seedCounts={{ reached: 134, dropped: 47 }}
      />,
    )
    // Seeded, pre-fetch.
    expect(screen.getByRole('button', { name: 'Reached (134)' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    // The fetch answered 140, not the seeded 134 -- the fresher number wins.
    expect(await screen.findByRole('button', { name: 'Reached (140)' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reached (134)' })).not.toBeInTheDocument()
    // Dropped was never fetched -- its seed of 47 must still be showing.
    expect(screen.getByRole('button', { name: 'Dropped here (47)' })).toBeInTheDocument()
  })
})
