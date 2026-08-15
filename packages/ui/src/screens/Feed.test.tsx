import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { DEFAULT_POLL_INTERVAL_MS, Feed } from './Feed.js'

const EVENTS = [
  {
    event_id: 'e1',
    timestamp: '2026-08-15T09:14:02.000Z',
    event_name: 'page_view',
    anonymous_id: 'anon_8fa2',
    user_id: '',
    properties: { path: '/pricing' },
    properties_num: {},
    url: '',
    path: '/pricing',
    referrer: '',
    device_type: 'desktop',
  },
  {
    event_id: 'e2',
    timestamp: '2026-08-15T09:14:01.000Z',
    event_name: 'signed_up',
    anonymous_id: 'anon_8fa2',
    user_id: 'cem@example.test',
    properties: {},
    properties_num: {},
    url: '',
    path: '',
    referrer: '',
    device_type: 'desktop',
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
    },
    {
      id: 2,
      name: 'Beta',
      slug: 'beta',
      created_at: '',
      retention_months: 24,
      monthly_event_quota: null,
    },
  ]
  const view = render(
    <ProjectProvider projects={projects} initialId={opts.projectId ?? 1}>
      <Feed client={client} pollIntervalMs={opts.pollIntervalMs} />
    </ProjectProvider>,
  )
  return {
    client,
    rerenderWithProject: (id: number) =>
      view.rerender(
        <ProjectProvider projects={projects} initialId={id}>
          <Feed client={client} pollIntervalMs={opts.pollIntervalMs} />
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
  it('renders accepted events', async () => {
    renderFeed()
    expect(await screen.findByText('page_view')).toBeInTheDocument()
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

  it('shows an empty state rather than a blank table', async () => {
    const client = fakeClient({ events: [] })
    renderFeed({ client })
    expect(await screen.findByText(/no events yet/i)).toBeInTheDocument()
  })

  it('shows an error without clearing the rows it already has', async () => {
    await withFakeTimers(async () => {
      const client = failingAfterFirstCall()
      renderFeed({ client })
      expect(await screen.findByText('page_view')).toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS)
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
      expect(screen.getByText('page_view')).toBeInTheDocument()
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
})
