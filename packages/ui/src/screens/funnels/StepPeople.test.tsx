import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { FunnelPeoplePage, MemberRow } from '../../api/types.js'
import { StepPeople } from './StepPeople.js'

/**
 * `StepPeople` renders `MemberList`, which now wraps every person id in a
 * `react-router` `<Link>` unconditionally (#<issue>) -- so a render without
 * a router in scope throws, where it used to render fine. Every test in
 * this file needs one, not just tests that click the link, because the row
 * itself carries the link whether or not a given test looks at it.
 */
function Router(props: { children: ReactNode }) {
  return <MemoryRouter>{props.children}</MemoryRouter>
}

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
  it('renders a reached/dropped toggle over a MemberList that is already loading', () => {
    const funnelPeople = vi.fn(async () => page())
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />, { wrapper: Router })
    expect(screen.getByRole('button', { name: /^reached/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^dropped here/i })).toBeInTheDocument()
    // No "Show people" gate: selecting a step IS the request, so the list is
    // already loading. The toggle is what this test is about.
    expect(screen.queryByRole('button', { name: /show people/i })).not.toBeInTheDocument()
  })

  it('fetches reached (the default mode) for the given project/funnel/step/range', async () => {
    const funnelPeople = vi.fn(async () => page({ person_count: 134 }))
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />, { wrapper: Router })
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
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />, { wrapper: Router })

    expect(await screen.findByRole('button', { name: 'Reached (134)' })).toBeInTheDocument()
    // Dropped has not been fetched yet -- its button must not show ANY
    // count, and must not borrow reached's number either.
    expect(screen.getByRole('button', { name: 'Dropped here' })).toBeInTheDocument()
    expect(screen.queryByText(/Dropped here \(/)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Dropped here' }))
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
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />, { wrapper: Router })

    // Load reached's first page, then its second -- a real cursor now exists.
    await userEvent.click(await screen.findByRole('button', { name: /load more/i }))
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('person-1')).toBeInTheDocument()

    // Switch to dropped. The reached rows must be gone immediately, and the
    // list must be back to its pre-fetch state, not left showing stale rows
    // under the newly selected mode.
    await userEvent.click(screen.getByRole('button', { name: /^dropped here/i }))
    expect(screen.queryByText('person-1')).not.toBeInTheDocument()
    expect(screen.queryByText('person-0')).not.toBeInTheDocument()
    // The walk restarts on its own. This used to be proved by a "Show people"
    // button reappearing; with the gate gone the claim is stronger, not
    // weaker -- the refetch must happen with NO click, and it must ask for
    // page one, so `cursor` is undefined rather than the reached walk's.
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
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />, { wrapper: Router })
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
      { wrapper: Router },
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
  })
})

describe('StepPeople -- seeded counts', () => {
  it('shows both seeded counts on the first paint, before any fetch resolves', () => {
    // The "no fetch at all" this once asserted is gone ON PURPOSE: selecting a
    // step IS the request, so the list loads without a second click. What the
    // seed is still for survives unchanged and is what this pins -- both
    // labels carry a number on the very first paint, with no request having
    // come back yet. Asserted synchronously, before any await, so a resolved
    // fetch cannot be what put the numbers there.
    const funnelPeople = vi.fn(async () => page())
    render(
      <StepPeople
        client={fakeClient(funnelPeople)}
        {...BASE_PROPS}
        seedCounts={{ reached: 134, dropped: 47 }}
      />,
      { wrapper: Router },
    )
    expect(screen.getByRole('button', { name: 'Reached (134)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dropped here (47)' })).toBeInTheDocument()
  })

  it('loads the list without a second click', () => {
    // The whole point of the change: a step click, or a mode flip, must not
    // then require "Show people". The panel is remounted on both, so that
    // second click came back every single time.
    const funnelPeople = vi.fn(async () => page())
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />, { wrapper: Router })
    expect(screen.queryByRole('button', { name: /show people/i })).not.toBeInTheDocument()
    expect(funnelPeople).toHaveBeenCalledTimes(1)
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
      { wrapper: Router },
    )
    // Seeded, pre-fetch.
    expect(screen.getByRole('button', { name: 'Reached (134)' })).toBeInTheDocument()

    // The fetch answered 140, not the seeded 134 -- the fresher number wins.
    expect(await screen.findByRole('button', { name: 'Reached (140)' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reached (134)' })).not.toBeInTheDocument()
    // Dropped was never fetched -- its seed of 47 must still be showing.
    expect(screen.getByRole('button', { name: 'Dropped here (47)' })).toBeInTheDocument()
  })
})

describe('StepPeople on an optional step', () => {
  const OPTIONAL_PROPS = { ...BASE_PROPS, step: 3, optional: true, event: 'video_submitted' }

  it('offers the two populations a branch HAS, in the event’s own words, and never the one the server refuses', async () => {
    // `dropped` on an optional step is a 400 (Task 8's route), so a toggle
    // that offers it is not a wording problem -- it is a button that cannot
    // work. And "dropped" would be wrong even if the server allowed it:
    // nobody drops out at a branch, they carried on down the funnel.
    const funnelPeople = vi.fn(async () => page())
    render(<StepPeople client={fakeClient(funnelPeople)} {...OPTIONAL_PROPS} />, {
      wrapper: Router,
    })
    expect(screen.getByRole('button', { name: /^did video_submitted/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^did not/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /dropped/i })).not.toBeInTheDocument()
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(1))
  })

  it('asks for mode `skipped`, not `dropped`, when the second option is chosen', async () => {
    const funnelPeople = vi.fn(async () => page({ person_count: 50 }))
    render(<StepPeople client={fakeClient(funnelPeople)} {...OPTIONAL_PROPS} />, {
      wrapper: Router,
    })
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole('button', { name: /^did not/i }))
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(2))
    expect(funnelPeople).toHaveBeenNthCalledWith(2, 1, 7, {
      step: 3,
      mode: 'skipped',
      since: RANGE.since,
      until: RANGE.until,
      cursor: undefined,
    })
  })

  it('seeds the skipped count the same way the others are seeded', () => {
    const funnelPeople = vi.fn(async () => page())
    render(
      <StepPeople
        client={fakeClient(funnelPeople)}
        {...OPTIONAL_PROPS}
        seedCounts={{ reached: 30, skipped: 50 }}
      />,
      { wrapper: Router },
    )
    expect(screen.getByRole('button', { name: 'Did video_submitted (30)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Did not (50)' })).toBeInTheDocument()
  })

  // THE 400 THIS COMPONENT EXISTS TO AVOID. `skipped` is legal on step 3 and
  // illegal on step 4, so a mode carried across the change is a request that
  // cannot succeed -- and it arrives as "could not load these people", with
  // nothing on screen saying the client asked something impossible.
  //
  // Proved WITHOUT a remount, deliberately: `FunnelDetail` keys this
  // component on the step, so a test that unmounts it would pass against a
  // component with no reset at all, which is exactly the mutation this is
  // for.
  it('resets the mode to `reached` when the step it is asked about changes, rather than carrying an illegal one over', async () => {
    const funnelPeople = vi.fn(async () => page())
    const { rerender } = render(
      <StepPeople client={fakeClient(funnelPeople)} {...OPTIONAL_PROPS} />,
      { wrapper: Router },
    )
    await userEvent.click(screen.getByRole('button', { name: /^did not/i }))
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(2))
    expect(funnelPeople).toHaveBeenNthCalledWith(
      2,
      1,
      7,
      expect.objectContaining({ mode: 'skipped' }),
    )

    rerender(
      <StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} step={4} event="purchase" />,
    )
    // The required step's own pair is back, with `reached` selected.
    expect(screen.getByRole('button', { name: /^reached/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: /^dropped here/i })).toBeInTheDocument()
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(3))
    expect(funnelPeople).toHaveBeenNthCalledWith(3, 1, 7, {
      step: 4,
      mode: 'reached',
      since: RANGE.since,
      until: RANGE.until,
      cursor: undefined,
    })
    // Asserted over EVERY call, not just the third: nothing may ever have
    // asked step 4 for `skipped`, not even for one render.
    // `vi.fn(async () => page())` infers a zero-argument signature, so the
    // recorded calls come back as `[]` and every index is out of range.
    // Widened here rather than by loosening the mock: the mock's own return
    // type is what makes the rest of this file's fixtures type-check.
    const calls = funnelPeople.mock.calls as unknown as [
      number,
      number,
      { step: number; mode: string },
    ][]
    for (const call of calls) {
      if (call[2].step === 4) expect(call[2].mode).not.toBe('skipped')
    }
  })

  it('resets the mode when the SAME step number changes shape, which is the other way an illegal mode survives', async () => {
    // A re-run against an edited definition can make step 3 required while
    // the step number on screen never changes. `skipped` is then illegal on
    // a step the reader never navigated away from.
    const funnelPeople = vi.fn(async () => page())
    const { rerender } = render(
      <StepPeople client={fakeClient(funnelPeople)} {...OPTIONAL_PROPS} />,
      { wrapper: Router },
    )
    await userEvent.click(screen.getByRole('button', { name: /^did not/i }))
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(2))

    rerender(
      <StepPeople
        client={fakeClient(funnelPeople)}
        {...BASE_PROPS}
        step={3}
        event="video_submitted"
      />,
    )
    expect(screen.getByRole('button', { name: /^reached/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    await waitFor(() => expect(funnelPeople).toHaveBeenCalledTimes(3))
    expect(funnelPeople).toHaveBeenNthCalledWith(
      3,
      1,
      7,
      expect.objectContaining({ mode: 'reached' }),
    )
  })

  it('leaves a required step’s toggle exactly as it was', () => {
    // The common case must not have moved. `optional` absent is a required
    // step, and its two labels are the ones every existing test names.
    const funnelPeople = vi.fn(async () => page())
    render(<StepPeople client={fakeClient(funnelPeople)} {...BASE_PROPS} />, { wrapper: Router })
    expect(screen.getByRole('button', { name: 'Reached' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dropped here' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^did /i })).not.toBeInTheDocument()
  })
})
