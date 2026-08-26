import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RANGE_ID,
  FEED_RANGES,
  HISTORICAL_POLL_MS,
  LIVE_POLL_MS,
  MAX_DISPLAY_BUCKETS,
  rangeById,
  rangeWindow,
} from './range.js'

/** The server's own ceiling, from `packages/server/src/events/routes.ts`.
 * Restated rather than imported: the UI package does not depend on the
 * server, and a copy that drifts is exactly what the test below catches. */
const STATS_MAX_BUCKETS = 1000
const INTERVAL_MS = { '1m': 60_000, '1h': 3_600_000, '1d': 86_400_000 }
/** Both ceilings, and which one binds depends on the span -- at thirty days
 * it is the display one, at every other span it is the server's. */
const CAP = Math.min(STATS_MAX_BUCKETS, MAX_DISPLAY_BUCKETS)

describe('FEED_RANGES', () => {
  it('pairs every span with a resolution the server will accept', () => {
    // The pairing is the whole reason this table exists. 24 hours at `1m`
    // is 1440 buckets against a cap of 1000 -- an unconditional 400, and
    // the obvious thing to build if span and interval were offered as two
    // independent choices.
    for (const range of FEED_RANGES) {
      const buckets = Math.ceil(range.spanMs / INTERVAL_MS[range.interval])
      expect(buckets).toBeLessThanOrEqual(STATS_MAX_BUCKETS)
      // ...and under the tighter one, which is what stops a legal-but-
      // unreadable pairing: thirty days at `1h` is 720 buckets, inside the
      // server's cap and about a pixel and a third per bar on screen.
      expect(buckets).toBeLessThanOrEqual(MAX_DISPLAY_BUCKETS)
    }
    expect(MAX_DISPLAY_BUCKETS).toBeLessThan(STATS_MAX_BUCKETS)
  })

  it('takes the FINEST resolution each span can legally carry', () => {
    // The bound above is satisfied by answering `1d` to everything, which
    // would draw an hour of traffic as a single bar. This is the other half.
    const order = ['1m', '1h', '1d'] as const
    for (const range of FEED_RANGES) {
      const finer = order[order.indexOf(range.interval) - 1]
      if (finer === undefined) continue
      const buckets = Math.ceil(range.spanMs / INTERVAL_MS[finer])
      expect(buckets).toBeGreaterThan(CAP)
    }
  })

  it('polls live only for the spans a person can watch change', () => {
    // Re-scanning ninety days every three seconds asks an expensive
    // question twenty times a minute and answers it with a number that
    // cannot visibly move.
    for (const range of FEED_RANGES) {
      expect(range.pollMs).toBe(range.spanMs <= 24 * 3_600_000 ? LIVE_POLL_MS : HISTORICAL_POLL_MS)
    }
    expect(HISTORICAL_POLL_MS).toBeGreaterThan(LIVE_POLL_MS)
  })

  it('has a unique id per range, and a default that is one of them', () => {
    const ids = FEED_RANGES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(DEFAULT_RANGE_ID)
  })

  it('opens on the window the events table was already reading', () => {
    // The table sent no `since` and inherited the server's 24-hour default
    // while the chart above it was hard-coded to sixty minutes. Opening on
    // 24 hours keeps the behaviour an operator already knows and makes the
    // chart agree with the table for the first time.
    expect(rangeById(DEFAULT_RANGE_ID).spanMs).toBe(24 * 3_600_000)
  })
})

describe('rangeById', () => {
  it('returns the named range', () => {
    expect(rangeById('7d').label).toBe('Last 7 days')
  })

  it('falls back to the DEFAULT range on an unknown id, not to a position', () => {
    // A shared link outlives the list it was made from. Asserting only that
    // the result is *some* range let the fallback be `FEED_RANGES[1]`, which
    // is the default by coincidence of ordering -- reorder the list and
    // every stale link silently opens on a different window.
    expect(rangeById('not-a-range').id).toBe(DEFAULT_RANGE_ID)
    expect(rangeById('').id).toBe(DEFAULT_RANGE_ID)
  })
})

describe('rangeWindow', () => {
  it('spans exactly the range, ending now', () => {
    const now = new Date('2026-08-26T12:00:00.000Z')
    const w = rangeWindow(rangeById('1h'), now)
    expect(w.until).toBe('2026-08-26T12:00:00.000Z')
    expect(w.since).toBe('2026-08-26T11:00:00.000Z')
  })

  it('resolves against the clock at CALL time, not when the range was chosen', () => {
    // A feed left open for an hour must keep asking for the last N minutes
    // as of each poll. Precomputing the window when the picker changes
    // freezes the screen on a window that slides out from under it.
    const range = rangeById('1h')
    const first = rangeWindow(range, new Date('2026-08-26T12:00:00.000Z'))
    const later = rangeWindow(range, new Date('2026-08-26T13:00:00.000Z'))
    expect(later.since).not.toBe(first.since)
    expect(later.until).not.toBe(first.until)
  })
})
