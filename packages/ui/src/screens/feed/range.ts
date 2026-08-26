import type { StatsQuery } from '../../api/types.js'

/**
 * A window the feed can be read over, and everything that follows from it.
 *
 * **The interval is not a second choice.** `/v1/events/stats` caps a
 * response at `STATS_MAX_BUCKETS` (1000), so a span and a resolution are one
 * decision: 24 hours at `1m` is 1440 buckets and an unconditional 400. Each
 * option below carries the finest resolution its span can legally have, and
 * offering the two separately would let an operator build a request the
 * server must refuse.
 *
 * **The poll interval is not a second choice either.** The three-second poll
 * exists to answer "is my instrumentation working right now", which is a
 * question about the last few minutes. Re-scanning ninety days every three
 * seconds asks the same expensive question of the database twenty times a
 * minute and answers it with a number that cannot visibly change -- the cost
 * surface `SEGMENT_MAX_EXECUTION_SECONDS` exists to defend. So the live
 * ranges keep the live cadence and the historical ones slow down.
 */
export interface FeedRange {
  /** Stable id, used as the `<select>` value and in tests. */
  id: string
  label: string
  /** How far back the window reaches, in milliseconds. */
  spanMs: number
  /** The finest resolution this span can carry inside the bucket cap. */
  interval: NonNullable<StatsQuery['interval']>
  /** How often to re-ask, in milliseconds. */
  pollMs: number
}

/**
 * The most bars this chart is drawn with, and it is a TIGHTER bound than the
 * server's.
 *
 * `/v1/events/stats` caps a response at 1000 buckets, and at thirty days an
 * hourly resolution is 720 -- legal, and about a pixel and a third per bar on
 * a laptop-width card, which is a smear rather than a chart. So the
 * resolution for a span is the finest one under BOTH ceilings, and at thirty
 * days it is this one that binds, not the server's.
 *
 * Stated as a number rather than derived from a measured width on purpose:
 * the range must be decidable before the plot has been laid out, and a chart
 * whose resolution changed as the window was dragged would redraw its own
 * history under the reader.
 */
export const MAX_DISPLAY_BUCKETS = 400

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The live cadence, and the reason the feed is called a feed. */
export const LIVE_POLL_MS = 3000

/** What a range too wide to watch in real time refreshes at instead. Still
 * automatic -- an operator who leaves the screen open on 30 days should not
 * come back to numbers from when they opened it -- just not twenty times a
 * minute. */
export const HISTORICAL_POLL_MS = 60_000

export const FEED_RANGES: readonly FeedRange[] = [
  { id: '1h', label: 'Last hour', spanMs: HOUR, interval: '1m', pollMs: LIVE_POLL_MS },
  { id: '24h', label: 'Last 24 hours', spanMs: DAY, interval: '1h', pollMs: LIVE_POLL_MS },
  { id: '7d', label: 'Last 7 days', spanMs: 7 * DAY, interval: '1h', pollMs: HISTORICAL_POLL_MS },
  {
    id: '30d',
    label: 'Last 30 days',
    spanMs: 30 * DAY,
    interval: '1d',
    pollMs: HISTORICAL_POLL_MS,
  },
  {
    id: '90d',
    label: 'Last 90 days',
    spanMs: 90 * DAY,
    interval: '1d',
    pollMs: HISTORICAL_POLL_MS,
  },
]

/**
 * The window the feed opens on.
 *
 * 24 hours, which is what the events table was ALREADY reading -- it sent no
 * `since` at all and inherited the server's 24-hour default, while the chart
 * above it was hard-coded to sixty minutes. The two disagreed by a factor of
 * twenty-four and the screen said so nowhere. Opening on the table's window
 * keeps the default behaviour an operator already knows and makes the chart
 * agree with it.
 */
export const DEFAULT_RANGE_ID = '24h'

export function rangeById(id: string): FeedRange {
  return FEED_RANGES.find((r) => r.id === id) ?? (FEED_RANGES[1] as FeedRange)
}

/**
 * The window's edges as of NOW, resolved at call time.
 *
 * Never precomputed and stored: a feed left open for an hour must keep
 * asking for the last N minutes as of each poll, not as of whenever the
 * range was last chosen. That is the same rule `RangePicker` follows on the
 * funnel screen, where it emits days rather than a `since`.
 */
export function rangeWindow(range: FeedRange, now: Date = new Date()) {
  return {
    since: new Date(now.getTime() - range.spanMs).toISOString(),
    until: now.toISOString(),
  }
}
