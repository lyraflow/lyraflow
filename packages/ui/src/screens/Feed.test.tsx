import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { DEFAULT_POLL_INTERVAL_MS, Feed } from './Feed.js'

/** The fields `GET /v1/events` sends for an event that carried none of the
 * optional context -- spelled out once so a fixture below can override only
 * what its own test is about. */
const EMPTY_CONTEXT = {
  url: '',
  referrer: '',
  utm_source: '',
  utm_medium: '',
  utm_campaign: '',
  utm_term: '',
  utm_content: '',
  device_type: 'desktop',
  os: '',
  browser: '',
  country: '',
  region: '',
  city: '',
}

const EVENTS = [
  {
    ...EMPTY_CONTEXT,
    event_id: 'e1',
    timestamp: '2026-08-15T09:14:02.000Z',
    event_name: 'page_view',
    anonymous_id: 'anon_8fa2',
    user_id: '',
    properties: { plan: 'trial' },
    properties_num: { seats: 12 },
    path: '/pricing',
    utm_campaign: 'launch',
  },
  {
    ...EMPTY_CONTEXT,
    event_id: 'e2',
    timestamp: '2026-08-15T09:14:01.000Z',
    event_name: 'signed_up',
    anonymous_id: 'anon_8fa2',
    user_id: 'cem@example.test',
    properties: {},
    properties_num: {},
    path: '',
  },
]

// Two of these are byte-identical at the same instant. That is what a client
// looping on one malformed payload produces, and it is the single most
// valuable thing this screen ever shows -- so the table must render BOTH.
const REJECTIONS = [
  {
    received_at: '2026-08-15T09:13:44.000Z',
    reason: 'invalid_payload',
    detail: '"ts" is not a number',
    payload: '{"ts":"x"}',
  },
  {
    received_at: '2026-08-15T09:13:44.000Z',
    reason: 'invalid_payload',
    detail: '"ts" is not a number',
    payload: '{"ts":"x"}',
  },
  {
    received_at: '2026-08-15T09:12:10.000Z',
    reason: 'unknown_event',
    detail: 'no such event',
    payload: '{}',
  },
]

const BUCKETS = [
  { bucket: '2026-08-15T09:12:00.000Z', events: 3 },
  { bucket: '2026-08-15T09:13:00.000Z', events: 7 },
  { bucket: '2026-08-15T09:14:00.000Z', events: 5 },
]

function fakeClient(over: { events?: typeof EVENTS } = {}) {
  return {
    events: vi.fn(async () => ({ events: over.events ?? EVENTS, next_cursor: null })),
    rejections: vi.fn(async () => ({
      rejections: REJECTIONS,
      has_more: false,
      next_offset: REJECTIONS.length,
    })),
    stats: vi.fn(async () => ({ buckets: BUCKETS })),
  } as unknown as ApiClient & { events: Mock; rejections: Mock; stats: Mock }
}

/** Succeeds once, then fails — for the "keeps its rows on error" test. */
function failingAfterFirstCall() {
  let n = 0
  const c = fakeClient()
  c.events = vi.fn(async () => {
    if (n++ > 0) throw new ApiError(503, 'unavailable')
    return { events: EVENTS, next_cursor: null }
  }) as unknown as typeof c.events
  return c
}

/** Every poll fails on every call, from the very first one -- no resource
 * ever has anything to show. This is the fixture for the matrix's "no data,
 * error" row: unlike `failingAfterFirstCall`, there is no prior success on
 * any of the three endpoints for something-was-cleared confusion to hide
 * behind. */
function allFailingFromStart() {
  const c = fakeClient()
  c.events = vi.fn(async () => {
    throw new ApiError(503, 'unavailable')
  }) as unknown as typeof c.events
  c.rejections = vi.fn(async () => {
    throw new ApiError(503, 'unavailable')
  }) as unknown as typeof c.rejections
  c.stats = vi.fn(async () => {
    throw new ApiError(503, 'unavailable')
  }) as unknown as typeof c.stats
  return c
}

/** All three succeed once, then all fail on every later call. Used to prove
 * the "as of" text names a REAL elapsed time rather than always reading
 * "just now" -- every other fixture in this file that mixes success and
 * failure keeps at least one poll succeeding on every tick, which would let
 * a version of `Feed` that hardcodes `new Date()` as the "last updated"
 * moment (instead of reading `updatedAt` off the failed poll's own state)
 * pass unnoticed. */
function allSucceedThenAllFail() {
  let eventsN = 0
  let rejectionsN = 0
  let statsN = 0
  const c = fakeClient()
  c.events = vi.fn(async () => {
    if (eventsN++ > 0) throw new ApiError(503, 'unavailable')
    return { events: EVENTS, next_cursor: null }
  }) as unknown as typeof c.events
  c.rejections = vi.fn(async () => {
    if (rejectionsN++ > 0) throw new ApiError(503, 'unavailable')
    return { rejections: REJECTIONS, has_more: false, next_offset: REJECTIONS.length }
  }) as unknown as typeof c.rejections
  c.stats = vi.fn(async () => {
    if (statsN++ > 0) throw new ApiError(503, 'unavailable')
    return { buckets: BUCKETS }
  }) as unknown as typeof c.stats
  return c
}

/** Events fails on every call, from the very first one; rejections and
 * stats keep succeeding. Fix round 1 on #82: the mixed case where the
 * events poll specifically has never once succeeded while the SCREEN as a
 * whole has data (from the other two), so the top banner reads "showing
 * the last data received" while the Accepted badge, unguarded, would still
 * show a confirmed-looking "0". */
function eventsFailingFromStart() {
  const c = fakeClient()
  c.events = vi.fn(async () => {
    throw new ApiError(503, 'unavailable')
  }) as unknown as typeof c.events
  return c
}

// Invented: every existing "shows an error" fixture fails the *events*
// poll specifically. Nothing in the given suite would notice a mutation
// that wired the alert to `eventsState.error` alone and dropped the other
// two `??` branches -- rejections and stats can fail on their own (a
// dictionary reload, a slow aggregation) while events keeps working fine.
function failingRejectionsAfterFirstCall() {
  let n = 0
  const c = fakeClient()
  c.rejections = vi.fn(async () => {
    if (n++ > 0) throw new ApiError(503, 'unavailable')
    return { rejections: REJECTIONS, has_more: false, next_offset: REJECTIONS.length }
  }) as unknown as typeof c.rejections
  return c
}

function renderFeed(
  opts: {
    client?: ReturnType<typeof fakeClient>
    projectId?: number
    pollIntervalMs?: number
    onUnauthorized?: () => void
  } = {},
) {
  const client = opts.client ?? fakeClient()
  const projects = [
    {
      id: 1,
      name: 'Alpha',
      slug: 'alpha',
      created_at: '',
      retention_months: 24,
      monthly_event_quota: null,
      disabled_at: null,
    },
    {
      id: 2,
      name: 'Beta',
      slug: 'beta',
      created_at: '',
      retention_months: 24,
      monthly_event_quota: null,
      disabled_at: null,
    },
  ]
  const view = render(
    <ProjectProvider projects={projects} initialId={opts.projectId ?? 1}>
      <Feed
        client={client}
        pollIntervalMs={opts.pollIntervalMs}
        onUnauthorized={opts.onUnauthorized}
      />
    </ProjectProvider>,
  )
  return {
    client,
    rerenderWithProject: (id: number) =>
      view.rerender(
        <ProjectProvider projects={projects} initialId={id}>
          <Feed
            client={client}
            pollIntervalMs={opts.pollIntervalMs}
            onUnauthorized={opts.onUnauthorized}
          />
        </ProjectProvider>,
      ),
  }
}

/**
 * The two tests below need a *second* poll to actually land -- real timers
 * would mean either a literal multi-second `waitFor` (fragile, slow) or
 * shrinking the production interval to fit `@testing-library/dom`'s default
 * 1000ms `waitFor` budget (the shape Finding 1 of the first review round
 * rejected: production behaviour bent to fit one test). Fake timers with
 * `shouldAdvanceTime: true` -- the same technique `usePolling.test.ts` already
 * uses -- let the test jump straight to the next tick without either cost.
 */
async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    await run()
  } finally {
    vi.useRealTimers()
  }
}

describe('Feed', () => {
  // Matrix row 4 (data, no error): the plain case. Asserting the alert's
  // absence here, not just the rows' presence, is what would catch a stub
  // that always renders SOME banner regardless of state.
  it('renders accepted events', async () => {
    renderFeed()
    expect(await screen.findByText('page_view')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // The reason the screen exists: an operator on the Accepted tab must be
  // able to see that something is being refused, without going looking.
  it('shows the rejected count while the Accepted tab is selected', async () => {
    renderFeed()
    const tab = await screen.findByRole('tab', { name: /rejected/i })
    expect(tab.textContent).toMatch(/3/)
    expect(await screen.findByRole('tab', { name: /accepted/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('shows rejection reasons and details on the Rejected tab', async () => {
    renderFeed()
    await userEvent.click(await screen.findByRole('tab', { name: /rejected/i }))
    // Two of the three fixture rejections share this reason on purpose (see
    // the byte-identical test below), so this must be an "AllBy" query --
    // `findByText` would throw on the legitimate duplicate.
    const reasons = await screen.findAllByText('invalid_payload')
    expect(reasons.length).toBeGreaterThan(0)
    expect(screen.getAllByText(/not a number/i).length).toBeGreaterThan(0)
  })

  // Byte-identical rejections at the same instant are the signal, not noise:
  // a client looping on one bad payload is the most likely thing this screen
  // ever shows. The table must not dedupe them.
  it('renders byte-identical rejections as separate rows', async () => {
    renderFeed()
    await userEvent.click(await screen.findByRole('tab', { name: /rejected/i }))
    expect(await screen.findAllByText('invalid_payload')).toHaveLength(2)
  })

  it('requests the active project and re-requests when it changes', async () => {
    const client = fakeClient()
    const { rerenderWithProject } = renderFeed({ client, projectId: 1 })
    await waitFor(() => expect(client.events).toHaveBeenCalledWith(1, expect.anything()))
    rerenderWithProject(2)
    await waitFor(() => expect(client.events).toHaveBeenCalledWith(2, expect.anything()))
  })

  it('sends an explicit limit', async () => {
    const client = fakeClient()
    renderFeed({ client })
    await waitFor(() => expect(client.events).toHaveBeenCalled())
    expect(client.events.mock.calls[0]?.[1]).toHaveProperty('limit')
  })

  // Matrix row 1 (no data, no error): the only case where "No events yet"
  // is an honest thing to say.
  it('shows an empty state rather than a blank table', async () => {
    const client = fakeClient({ events: [] })
    renderFeed({ client })
    expect(await screen.findByText(/no events yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    // Fix round 2 on #82: the asymmetric half of the badge fix. A confirmed
    // zero (the events poll succeeded and returned nothing) must show a
    // genuine "0", not the dash `loadFailed` cases get -- swallowing a real
    // zero into "unknown" is its own false claim, and the one a self-hoster
    // checking whether tracking works actually needs to be true.
    expect((await screen.findByRole('tab', { name: /accepted/i })).textContent).toMatch(/\b0\b/)
  })

  // Matrix row 2 (no data, error) -- issue #82's own bug. Nothing has ever
  // been received for this project on ANY of the three polls, so "No
  // events yet" would assert something the poll never established. The
  // banner must say the load failed, and must NEVER appear next to the
  // empty-state copy -- a stub that renders both would satisfy a weaker
  // test that only checked one or the other.
  it('shows a load-failed message, never the empty state, when there is no data at all and a poll errors', async () => {
    const client = allFailingFromStart()
    renderFeed({ client })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/could not load the feed/i)
    expect(screen.queryByText(/no events yet/i)).not.toBeInTheDocument()
    expect(screen.queryByText('page_view')).not.toBeInTheDocument()
    // Fix round 1 on #82: the badge is the same claim as the table body,
    // relocated -- "Accepted 0" is just as false as "No events yet" when
    // the events poll has never once succeeded.
    expect(await screen.findByRole('tab', { name: /accepted/i })).toHaveTextContent('—')
  })

  // Fix round 1 on #82. The bug had moved rather than being fixed: the
  // table body correctly stopped rendering "No events yet", but
  // `TabsTrigger` still rendered `formatCount(events.length, ...)`, and
  // `events.length === 0` cannot distinguish "confirmed zero" from "never
  // confirmed" -- so the Accepted badge kept showing "0" the whole time the
  // events poll was failing, sitting right next to a banner reading
  // "Could not refresh the feed. Showing the last data received." This is
  // the exact mixed case that exposed it: events has never succeeded, but
  // the screen as a whole has data (from rejections/stats), so the banner
  // is in its "showing the last data received" branch while the Accepted
  // badge must still say "unknown", not "0".
  it('shows a dash on the Accepted badge, not a confirmed zero, when the events poll has never succeeded', async () => {
    const client = eventsFailingFromStart()
    renderFeed({ client })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/could not refresh the feed/i)
    const tab = await screen.findByRole('tab', { name: /accepted/i })
    expect(tab.textContent).toMatch(/—/)
    expect(tab.textContent).not.toMatch(/\b0\b/)
  })

  // Matrix row 3 (data, error): the only row where "showing the last data
  // received" is true, and the row that must also name WHEN that data is
  // from -- not just that it's stale.
  it('shows an error without clearing the rows it already has', async () => {
    await withFakeTimers(async () => {
      const client = failingAfterFirstCall()
      renderFeed({ client })
      expect(await screen.findByText('page_view')).toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS)
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
      expect(screen.getByText('page_view')).toBeInTheDocument()
      const alert = screen.getByRole('alert')
      expect(alert.textContent).toMatch(/could not refresh the feed/i)
      expect(alert.textContent).toMatch(/showing the last data received, as of/i)
      // Within the same test's fake-timer tick, the last successful poll is
      // effectively simultaneous with the check -- pinning "just now" (vs.
      // some other relative phrase) proves this reads a real `updatedAt`
      // rather than a hardcoded string.
      expect(alert.textContent).toMatch(/just now/i)
    })
  })

  // Every other fixture in this file that pairs data with an error keeps at
  // least one of the three polls succeeding on every tick, so its
  // `updatedAt` is always effectively "now" -- a version of `Feed` that
  // read the wall clock instead of the poll's own `updatedAt` would pass
  // every test above this one. Here ALL THREE polls stop succeeding after
  // their first call, so real time can elapse between "last success" and
  // "now" -- and the banner has to say so.
  it('names how long ago the shown data is from, once real time has actually elapsed', async () => {
    await withFakeTimers(async () => {
      const client = allSucceedThenAllFail()
      renderFeed({ client })
      expect(await screen.findByText('page_view')).toBeInTheDocument()
      // Past `format.ts`'s own MINUTE boundary for "just now" -- every poll
      // after the first fails, so none of this advance can push
      // `updatedAt` forward with it.
      await vi.advanceTimersByTimeAsync(65_000)
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
      // Not pinned to an exact minute count -- `shouldAdvanceTime` also
      // advances by whatever real wall-clock time the surrounding `await`s
      // take, so a tight bound is flaky by construction (the same reason
      // `Feed.test.tsx`'s poll-interval test uses asymmetric margins).
      // "just now" is impossible past the 60s mark either way.
      expect(screen.getByRole('alert').textContent).toMatch(/\d+ minutes? ago/i)
    })
  })

  // Invented mutation #1: an operator does not know or care which of the
  // three polls hiccuped -- only the events poll is exercised by the test
  // above, so a version of Feed that reads only `eventsState.error` would
  // pass every other test in this file while going silent on a failing
  // rejections (or stats) request. A rejections-only outage is exactly the
  // case where this screen's job -- surfacing that refusals are happening --
  // is most at risk of failing quietly.
  it('shows an error when only the rejections poll fails', async () => {
    await withFakeTimers(async () => {
      const client = failingRejectionsAfterFirstCall()
      renderFeed({ client })
      expect(await screen.findByText('page_view')).toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS)
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    })
  })

  // Fix round 1, Finding 1 (Critical): production behaviour must never be
  // bent to fit a test again -- the previous version of this file shipped a
  // 300ms poll interval to production so its own real-timer tests would fit
  // inside `waitFor`'s 1000ms budget. Three polled endpoints at 300ms is
  // roughly ten requests a second per open tab against Postgres and
  // ClickHouse. This pins the default at the boundary: one tick before it,
  // nothing has polled again; one tick after, it has. A default silently
  // lowered (or raised) would fail one half of this or the other.
  it('defaults to polling every 3 seconds when pollIntervalMs is not given', async () => {
    await withFakeTimers(async () => {
      const client = fakeClient()
      renderFeed({ client })
      await waitFor(() => expect(client.events).toHaveBeenCalledTimes(1))
      // Asymmetric margins, not a tight 2999/3000 boundary: `shouldAdvanceTime`
      // also ticks the fake clock forward by whatever real wall-clock time the
      // surrounding `await`s take, so a boundary this tight is flaky by
      // construction. 2000ms is still far past where a wrongly-small interval
      // (300ms, the one Finding 1 removed) would have already polled again;
      // 3500ms total is still comfortably before a wrongly-large one would.
      await vi.advanceTimersByTimeAsync(2000)
      expect(client.events).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1500)
      await waitFor(() => expect(client.events).toHaveBeenCalledTimes(2))
    })
  })

  // The other half of Finding 1's fix: `pollIntervalMs` is real, not just a
  // parameter nobody calls. A caller (a future settings screen, or a test
  // that needs a faster cycle) can actually override the default.
  it('polls at the given pollIntervalMs when overridden', async () => {
    await withFakeTimers(async () => {
      const client = fakeClient()
      renderFeed({ client, pollIntervalMs: 50 })
      await waitFor(() => expect(client.events).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(50)
      await waitFor(() => expect(client.events).toHaveBeenCalledTimes(2))
    })
  })

  // Invented mutation #2: every fixture in this file gives both tabs a
  // non-empty result, so nothing here previously exercised the Rejected
  // tab's own zero case. A `formatCount` that special-cases falsy counts
  // (e.g. `n ? n.toLocaleString() : ''`) reads correctly against every
  // other test -- REJECTIONS always has 3 -- yet renders the Rejected tab
  // as a bare "Rejected" with no visible "0" when nothing has been
  // refused, which reads as broken/loading rather than "all clear".
  it('shows a zero count and the empty state on the Rejected tab when there are none', async () => {
    const client = fakeClient()
    client.rejections = vi.fn(async () => ({ rejections: [], has_more: false, next_offset: 0 }))
    renderFeed({ client })
    const tab = await screen.findByRole('tab', { name: /rejected/i })
    await waitFor(() => expect(tab.textContent).toMatch(/0/))
    await userEvent.click(tab)
    expect(await screen.findByText(/no rejections/i)).toBeInTheDocument()
  })

  // The Rejected tab's own version of issue #82: "No rejections. Everything
  // received has been accepted." is a stronger claim than "zero rows" --
  // it says nothing was refused, which is exactly what a poll that has
  // never once succeeded cannot establish. Symmetric fixture to the events
  // one above: rejections fails from the very first call for this project,
  // while events/stats keep succeeding.
  it('does not show "No rejections" when the rejections poll has never succeeded and is failing', async () => {
    const client = fakeClient()
    client.rejections = vi.fn(async () => {
      throw new ApiError(503, 'unavailable')
    }) as unknown as typeof client.rejections
    renderFeed({ client })
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    const tab = await screen.findByRole('tab', { name: /rejected/i })
    // Fix round 1 on #82: the Rejected badge has the same "0 vs unknown"
    // problem the Accepted one did.
    expect(tab.textContent).toMatch(/—/)
    expect(tab.textContent).not.toMatch(/\b0\b/)
    await userEvent.click(tab)
    expect(screen.queryByText(/no rejections/i)).not.toBeInTheDocument()
  })

  // Important 5 from the whole-branch review. GET /v1/events deliberately
  // returns its page OLDEST-first (so it reads like a log and --follow can
  // continue from the last row shown -- see that route's own docstring).
  // With DEFAULT_LIMIT = 100, a newly-arriving event lands at row 100,
  // below the fold, on a screen whose own empty state promises "it will
  // show up here within a few seconds". The fix is display-only: the API
  // contract itself must stay oldest-first for the CLI's --follow.
  it('renders the Accepted tab newest-first, reversing the oldest-first API page', async () => {
    const client = fakeClient()
    const orderedEvents = [
      { ...EVENTS[0], event_id: 'ord-1', event_name: 'oldest_event' },
      { ...EVENTS[0], event_id: 'ord-2', event_name: 'middle_event' },
      { ...EVENTS[0], event_id: 'ord-3', event_name: 'newest_event' },
    ]
    client.events = vi.fn(async () => ({
      events: orderedEvents,
      next_cursor: null,
    })) as unknown as typeof client.events
    renderFeed({ client })
    await screen.findByText('newest_event')
    const rows = screen.getAllByRole('row').slice(1) // drop the header row
    const names = rows.map((r) => within(r).getByText(/_event$/).textContent)
    expect(names).toEqual(['newest_event', 'middle_event', 'oldest_event'])
  })

  // Important 6 from the whole-branch review, first half. GET /v1/events
  // defaults `since` to the last 24 hours when omitted; GET
  // /v1/events/rejections has NO default of its own -- only the
  // dead-letter table's 30-day TTL bounds it. Left unmatched, the two tabs'
  // counts describe different spans side by side as if comparable.
  it('sends an explicit since on the rejections poll matching the feed default window', async () => {
    const client = fakeClient()
    renderFeed({ client })
    await waitFor(() => expect(client.rejections).toHaveBeenCalled())
    const call = client.rejections.mock.calls[0]?.[1] as { since?: string }
    expect(call.since).toBeDefined()
    const sinceMs = new Date(call.since as string).getTime()
    const nowMs = Date.now()
    // Within a few seconds of exactly 24h ago -- not "some date in the
    // past", which a default-less call would also satisfy.
    expect(nowMs - sinceMs).toBeGreaterThan(24 * 60 * 60 * 1000 - 5000)
    expect(nowMs - sinceMs).toBeLessThan(24 * 60 * 60 * 1000 + 5000)
  })

  // Important 9 from the whole-branch review. Shell.test.tsx's own comment
  // names this exact failure -- "every screen quietly keeps reading the old
  // project while the header says otherwise" -- and only tested that the
  // CONTEXT updated, never the rendered rows. This is the test that looks
  // at the rows: switching to a project whose poll then fails must show NO
  // rows, not the previous project's, even though usePolling never clears
  // `data` on an error by itself.
  //
  // Issue #82: this is also the exact reproduction from the bug report --
  // switching projects into a poll that fails, here on the events endpoint
  // specifically while rejections/stats keep succeeding. Before the fix,
  // this rendered "No events yet" (asserting something the poll never
  // established for project 2) directly beside "Could not refresh the
  // feed. Showing the last data received." (claiming to show rows that had
  // just been cleared). The events poll for project 2 has never once
  // succeeded, so the Accepted tab must never claim "No events yet" -- that
  // claim is only ever honest about a poll that actually ran.
  it('shows no rows, not the previous project rows, when switching to a project whose poll fails', async () => {
    const client = fakeClient()
    client.events = vi.fn(async (projectId: number) => {
      if (projectId === 2) throw new ApiError(503, 'unavailable')
      return { events: EVENTS, next_cursor: null }
    }) as unknown as typeof client.events
    const { rerenderWithProject } = renderFeed({ client, projectId: 1 })
    expect(await screen.findByText('page_view')).toBeInTheDocument()

    rerenderWithProject(2)
    await waitFor(() => expect(client.events).toHaveBeenCalledWith(2, expect.anything()))
    await waitFor(() => expect(screen.queryByText('page_view')).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    // The absence check is the one that matters -- a screen that rendered
    // both the alert AND the empty-state copy would still pass every
    // assertion above this one.
    expect(screen.queryByText(/no events yet/i)).not.toBeInTheDocument()
  })

  // Critical 2 from the whole-branch review. A 401 from ANY polled endpoint
  // means the session is gone -- indistinguishable, without this, from the
  // server merely being slow, and the operator is left staring at frozen
  // rows behind a banner that reads like a transient hiccup forever, at
  // roughly one request per second, with no route back to login.
  it('calls onUnauthorized when a poll comes back 401', async () => {
    await withFakeTimers(async () => {
      const client = fakeClient()
      let n = 0
      client.events = vi.fn(async () => {
        if (n++ > 0) throw new ApiError(401, 'invalid_session')
        return { events: EVENTS, next_cursor: null }
      }) as unknown as typeof client.events
      const onUnauthorized = vi.fn()
      renderFeed({ client, onUnauthorized })
      expect(await screen.findByText('page_view')).toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS)
      await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    })
  })

  // The negative case for the same fix: an ordinary non-401 failure must
  // NOT trigger the login bounce -- that is exactly the generic "Could not
  // refresh" banner's job below, and conflating the two would send an
  // operator to login over a transient 503.
  it('does not call onUnauthorized for a non-401 failure', async () => {
    await withFakeTimers(async () => {
      const client = failingAfterFirstCall()
      const onUnauthorized = vi.fn()
      renderFeed({ client, onUnauthorized })
      expect(await screen.findByText('page_view')).toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS)
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
      expect(onUnauthorized).not.toHaveBeenCalled()
    })
  })
})
