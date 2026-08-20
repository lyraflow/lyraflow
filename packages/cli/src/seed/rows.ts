/**
 * The single bridge between a generated demo event and a row in `events`.
 *
 * There is deliberately no second implementation of "what an event row looks
 * like" in this package. `toEventRow` — the exact function the ingest route
 * calls for every real event — is imported and used unchanged, so a demo row
 * carries whatever a live row carries: the same column set, the same
 * `properties` / `properties_num` routing through `routeProperties`, the same
 * `$identify` naming for an identify payload, the same context defaults. A copy
 * of its body would drift the first time either side changed, and the whole
 * point of demo data is that it resembles production data.
 */

import { type EventRow, toEventRow } from '@lyraflow/core'
import type { DemoEvent } from './generate.js'

export type { EventRow }

/**
 * HOW NINETY DAYS OF HISTORY GETS PAST THE CLAMP WITHOUT WEAKENING IT.
 *
 * `toEventRow` calls `clampTimestamp(payload.timestamp, now)` unconditionally,
 * and that clamp pulls any timestamp more than `MAX_CLOCK_SKEW_MS` (24h) away
 * from `now` back to the edge of that window. Posting backdated events to
 * `/v1/batch` therefore cannot create history — every one of them lands inside
 * a single day, and `last 7 days`, `last 30 days` and `ever` all give the same
 * answer. The clamp is right (its own docstring explains why an unclamped
 * device clock poisons every time-windowed segment) and is left exactly as it
 * is: there is no bypass here and no "trusted backdating" flag, because that
 * would be a product decision rather than a demo-tool one.
 *
 * What this function does instead is pass the event's OWN instant as `now`.
 * `clampTimestamp` measures the payload timestamp against `now` — not against
 * the wall clock, which it never reads — so with the two equal the difference
 * is zero, the clamp is the identity function, and the row keeps the instant it
 * was generated with. The clamp still runs and still applies its whole rule; it
 * simply has nothing to correct. `rows.test.ts` pins this from the other side:
 * building the same event against the wall clock collapses a ninety-day-old
 * instant to twenty-four hours ago, and the test asserts the difference.
 *
 * `received_at` therefore also becomes the event's own instant, which is the
 * honest reading for data pretending to have been ingested live as it happened.
 * `trusted` is `1` for a related reason: unlike a browser-supplied timestamp,
 * this one was authored by the server-side tool that wrote the row.
 */
export function toDemoRow(ev: DemoEvent, projectId: number): EventRow {
  return toEventRow({
    projectId,
    // One source of truth for the instant: the payload timestamp is derived
    // from `ev.at` here rather than carried alongside it, so the two cannot
    // disagree and quietly put the clamp back in play.
    payload: { ...ev.payload, timestamp: ev.at.toISOString() },
    now: ev.at,
    trusted: true,
    geo: ev.geo,
    ua: ev.ua,
  })
}
