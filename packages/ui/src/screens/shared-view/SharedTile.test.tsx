import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import { ApiError } from '../../api/client.js'
import type {
  Funnel,
  FunnelRunResult,
  ResolvedTile,
  RetentionReport,
  RetentionResult,
  TrendReport,
} from '../../api/types.js'
import { createRunQueue } from '../dashboards/runQueue.js'
import type { RangeChoice } from '../shared/range.js'
import { BUSY_MAX_RETRIES, SharedTile } from './SharedTile.js'

const T = '2026-08-01T00:00:00.000Z'
const preset = (id: RangeChoice['preset']): RangeChoice => ({ preset: id, from: '', to: '' })

// The same three report fixtures `DashboardTile.test.tsx` runs against. The
// shared page renders the SAME `TileCard` over the SAME resolved tiles, so
// a second idea of what a report looks like here is how the two surfaces
// would come to disagree about a shape neither of them owns.
const TREND: TrendReport = {
  id: 1,
  name: 'Signups by country',
  event: 'signup',
  interval: '1d',
  group_by: 'attribute:country',
  where: [],
  definition_version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
}

const RETENTION: RetentionReport = {
  id: 2,
  name: 'Weekly return',
  definition_version: 1,
  start_event: 'signed_up',
  return_event: 'project_created',
  start_where: [],
  return_where: [],
  granularity: 'week',
  periods: 8,
  segment_id: null,
  stale: false,
  created_at: T,
  updated_at: T,
}

const FUNNEL: Funnel = {
  id: 3,
  name: 'Signup flow',
  definition_version: 1,
  steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
  window_seconds: 604800,
  segment_id: null,
  stale: false,
  last_entered: 1204,
  last_converted: 491,
  last_evaluated_at: T,
  last_range: null,
  created_at: T,
  updated_at: T,
}

const RETENTION_RUN: RetentionResult = {
  granularity: 'week',
  periods: 3,
  cohorts: [{ cohort: '2026-06-01', size: 4, retained: [4, 2, 1, null] }],
  start_event: 'signed_up',
  return_event: 'project_created',
  since: '2026-06-01T00:00:00.000Z',
  until: '2026-06-15T00:00:00.000Z',
  computed_at: '2026-06-20T00:00:00.000Z',
  warnings: [],
}

const FUNNEL_RUN: FunnelRunResult = {
  entered: 1204,
  converted: 491,
  conversion_rate: 0.4078,
  partial_window_entrants: 312,
  range: { since: '2026-08-08T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' },
  as_of: '2026-08-15T11:58:00.000Z',
  warnings: [],
  steps: [
    { index: 1, event: 'page_view', people: 1204, from_previous: 1, from_start: 1 },
    { index: 2, event: 'signup_completed', people: 491, from_previous: 0.4078, from_start: 0.4078 },
  ],
}

const trendTile = (over: Partial<ResolvedTile> = {}): ResolvedTile =>
  ({ kind: 'trend', report_id: 1, width: 'half', report: TREND, ...over }) as ResolvedTile

function stubClient(over: Record<string, unknown> = {}): ApiClient {
  return {
    runSharedTile: vi.fn(() => new Promise<never>(() => {})),
    ...over,
  } as unknown as ApiClient
}

function renderTile(opts: {
  tile?: ResolvedTile
  client?: ApiClient
  range?: RangeChoice
  index?: number
}) {
  const client = opts.client ?? stubClient()
  const view = render(
    <SharedTile
      client={client}
      token="T"
      index={opts.index ?? 0}
      tile={opts.tile ?? trendTile()}
      range={opts.range ?? preset('7d')}
      queue={createRunQueue()}
    />,
  )
  return { client, ...view }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SharedTile', () => {
  it('runs the tile through the token with the preset, and renders the result', async () => {
    const client = stubClient({
      runSharedTile: vi.fn(async () => ({
        kind: 'trend',
        result: { buckets: [{ bucket: '2026-09-01T00:00:00.000Z', series: 'all', events: 3 }] },
      })),
    })
    renderTile({ client, index: 3, range: preset('30d') })
    expect(await screen.findByTestId('tile-result')).toBeInTheDocument()
    expect(screen.getByTestId('trend-panels')).toBeInTheDocument()
    // The INDEX, not a report id: the public run route addresses a tile by
    // its position in the stored layout, and the viewer never learns an id.
    expect(client.runSharedTile).toHaveBeenCalledWith('T', 3, '30d')
  })

  it('renders a retention result and a funnel result through the same card', async () => {
    const retention = stubClient({
      runSharedTile: vi.fn(async () => ({ kind: 'retention', result: RETENTION_RUN })),
    })
    renderTile({
      client: retention,
      tile: { kind: 'retention', report_id: 2, width: 'half', report: RETENTION },
    })
    expect(await screen.findByTestId('retention-grid')).toBeInTheDocument()

    const funnel = stubClient({
      runSharedTile: vi.fn(async () => ({ kind: 'funnel', result: FUNNEL_RUN })),
    })
    renderTile({
      client: funnel,
      tile: { kind: 'funnel', report_id: 3, width: 'full', report: FUNNEL },
    })
    await waitFor(() => expect(screen.getAllByTestId('tile-result').length).toBeGreaterThan(1))
  })

  // Three states in which the card already says why there is nothing to
  // show. Sending anyway would spend one of the token's 120 runs a minute
  // on a request whose answer cannot be rendered.
  it('sends nothing for a deleted, stale or over-ceiling tile', async () => {
    const deleted = renderTile({ tile: trendTile({ report: null }) })
    expect(await screen.findByTestId('tile-deleted')).toBeInTheDocument()
    expect(deleted.client.runSharedTile).not.toHaveBeenCalled()

    const stale = renderTile({ tile: trendTile({ report: { ...TREND, stale: true } }) })
    expect(await screen.findByTestId('tile-stale')).toBeInTheDocument()
    expect(stale.client.runSharedTile).not.toHaveBeenCalled()

    // A 1-minute trend over 30 days is 43,200 buckets, far past `MAX_BUCKETS`.
    const ceiling = renderTile({
      tile: trendTile({ report: { ...TREND, interval: '1m' } }),
      range: preset('30d'),
    })
    expect(await screen.findByTestId('tile-ceiling')).toBeInTheDocument()
    expect(ceiling.client.runSharedTile).not.toHaveBeenCalled()
  })

  // These two drive a PLAIN `vi.useFakeTimers()`, not the
  // `{ shouldAdvanceTime: true }` the rest of this package uses, and never
  // reach for `findBy`/`waitFor`. Both facts have the same cause: Testing
  // Library only knows how to advance JEST's fake clock (`helpers.js`'s
  // `jestFakeTimersAreEnabled` tests `typeof jest`), so under vitest's it
  // would poll on a clock that never moves -- which is what
  // `shouldAdvanceTime` exists to paper over, by letting REAL elapsed time
  // move the fake clock as well. That is fine for a test asserting only
  // that something eventually happened, and wrong here: what these two pin
  // is a deadline, and real time leaking into it makes "still 1 call at
  // 999ms" depend on how long the assertions themselves took. Advancing the
  // clock by hand and reading the DOM synchronously afterwards is
  // deterministic instead. `advanceTimersByTimeAsync` flushes the microtask
  // queue as it goes, which is what lets the rejected run settle.
  it('waits out a 429 for retry-after seconds, at most twice, then errors', async () => {
    vi.useFakeTimers()
    const client = stubClient({
      runSharedTile: vi.fn().mockRejectedValue(new ApiError(429, 'too_many_runs', undefined, 2)),
    })
    renderTile({ client })

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByTestId('tile-busy')).toHaveTextContent('Busy, retrying…')
    expect(client.runSharedTile).toHaveBeenCalledTimes(1)

    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(client.runSharedTile).toHaveBeenCalledTimes(2)
    // Still busy, not back to a skeleton: a wait between attempts is not a
    // fresh load and must not read as one.
    expect(screen.getByTestId('tile-busy')).toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(2000))
    // A LITERAL 3, not `BUSY_MAX_RETRIES + 1`: written against the constant,
    // this assertion moves with any change to it and pins nothing. The
    // separate assertion below is what pins the constant itself, so a
    // mutation of either the guard or the number it compares against fails
    // exactly one of the two.
    expect(client.runSharedTile).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId('tile-error')).toHaveTextContent(
      'This dashboard is busy. Try again in a moment.',
    )
    // And it STOPS: no fourth attempt however long the page is left open.
    await act(() => vi.advanceTimersByTimeAsync(60_000))
    expect(client.runSharedTile).toHaveBeenCalledTimes(3)
  })

  it('allows two retries and no more', () => {
    expect(BUSY_MAX_RETRIES).toBe(2)
  })

  // The wait is the header's, not a constant of ours: the server knows how
  // long its own window has left to run, and a fixed delay would either
  // hammer it early or idle after it had already cleared. One second is the
  // fallback for a 429 that carries no usable header at all.
  it('falls back to one second when the 429 carries no retry-after', async () => {
    vi.useFakeTimers()
    const client = stubClient({
      runSharedTile: vi.fn().mockRejectedValue(new ApiError(429, 'too_many_runs')),
    })
    renderTile({ client })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByTestId('tile-busy')).toBeInTheDocument()
    await act(() => vi.advanceTimersByTimeAsync(999))
    expect(client.runSharedTile).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(client.runSharedTile).toHaveBeenCalledTimes(2)
  })

  it('names the tile kind in a non-429 failure, and Retry re-runs it', async () => {
    const client = stubClient({
      runSharedTile: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(404, 'report_not_found'))
        .mockResolvedValueOnce({ kind: 'trend', result: { buckets: [] } }),
    })
    renderTile({ client })
    expect(await screen.findByTestId('tile-error')).toHaveTextContent(
      'This trend report no longer exists.',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('tile-result')).toBeInTheDocument()
    expect(client.runSharedTile).toHaveBeenCalledTimes(2)
  })

  // The rename above was a review finding: that test reaches Retry from a
  // 404, where the busy count is already 0, so it cannot see whether Retry
  // resets it. This one can. After two automatic waits the tile is in its
  // terminal error state with the count at its ceiling; if Retry did not
  // reset it, the run it fires would find `retries` still at the limit and
  // go straight back to the error, for four sends in total. Reset, the two
  // waits are available again -- five.
  it('Retry restores the two automatic waits a run had used up', async () => {
    vi.useFakeTimers()
    const client = stubClient({
      runSharedTile: vi.fn().mockRejectedValue(new ApiError(429, 'too_many_runs', undefined, 2)),
    })
    renderTile({ client })

    await act(() => vi.advanceTimersByTimeAsync(0))
    await act(() => vi.advanceTimersByTimeAsync(2000))
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(screen.getByTestId('tile-error')).toBeInTheDocument()
    expect(client.runSharedTile).toHaveBeenCalledTimes(3)

    // `userEvent` drives real timers, so the click is dispatched directly.
    act(() => {
      screen.getByRole('button', { name: 'Retry' }).click()
    })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(client.runSharedTile).toHaveBeenCalledTimes(4)
    expect(screen.getByTestId('tile-busy')).toBeInTheDocument()

    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(client.runSharedTile).toHaveBeenCalledTimes(5)
    await act(() => vi.advanceTimersByTimeAsync(2000))
    expect(client.runSharedTile).toHaveBeenCalledTimes(6)
    expect(screen.getByTestId('tile-error')).toBeInTheDocument()
  })

  // A wait that outlives the range that started it. The unmount case is NOT
  // what this asserts, and that is a finding rather than an omission: with
  // the retry count paired to its range, a timer firing after unmount
  // reaches a no-op state setter, and one firing after a range change
  // writes a count against a range nothing is reading. Neither is visible.
  // What IS visible is a timer whose range has been REPLACED and whose
  // write therefore zeroes the count the new range has already spent -- a
  // tile that had given up starts running again, on its own, with no click.
  // The two `retry-after` values are what stage that: the first range waits
  // ten seconds, long enough for the second range to burn both its retries
  // and settle into the error state first.
  it('cancels a busy wait left behind by a range change, so a settled tile stays settled', async () => {
    vi.useFakeTimers()
    const runSharedTile = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(429, 'too_many_runs', undefined, 10))
      .mockRejectedValue(new ApiError(429, 'too_many_runs', undefined, 1))
    const client = stubClient({ runSharedTile })
    const props = {
      client,
      token: 'T',
      index: 0,
      tile: trendTile(),
      queue: createRunQueue(),
    }
    const { rerender } = render(<SharedTile {...props} range={preset('7d')} />)

    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.getByTestId('tile-busy')).toBeInTheDocument()
    expect(runSharedTile).toHaveBeenCalledTimes(1)

    // The range moves on while that ten-second wait is still pending.
    await act(() => vi.advanceTimersByTimeAsync(10))
    rerender(<SharedTile {...props} range={preset('30d')} />)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(runSharedTile).toHaveBeenCalledTimes(2)

    // The new range spends both of its own waits and gives up.
    await act(() => vi.advanceTimersByTimeAsync(1000))
    await act(() => vi.advanceTimersByTimeAsync(1000))
    expect(runSharedTile).toHaveBeenCalledTimes(4)
    expect(screen.getByTestId('tile-error')).toBeInTheDocument()

    // Now walk past the abandoned range's deadline. Nothing may happen.
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(runSharedTile).toHaveBeenCalledTimes(4)
    expect(screen.getByTestId('tile-error')).toBeInTheDocument()
  })

  // Everything a link would lead to is behind the login this viewer does not
  // have. `href={null}` is how `TileCard` is told so; this pins the outcome
  // rather than the prop, because the prop is the thing that could be
  // changed by accident.
  it('renders no link anywhere', async () => {
    const client = stubClient({
      runSharedTile: vi.fn(async () => ({ kind: 'trend', result: { buckets: [] } })),
    })
    renderTile({ client })
    await screen.findByTestId('tile-result')
    expect(screen.queryAllByRole('link')).toHaveLength(0)
  })
})
