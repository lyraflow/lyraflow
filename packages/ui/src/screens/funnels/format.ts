/**
 * Formatting only. Nothing here computes a rate: `from_previous` and
 * `from_start` arrive from the server, which returns both deliberately
 * because deriving one from the other is a multiplication callers get
 * subtly wrong. See packages/core/src/funnels/levels.ts.
 */
import type { FunnelStep } from '../../api/types.js'
import { wherePhrase } from '../segments/vocabulary.js'
import { secondsToWindowInput } from './WindowField.js'

/** A server-supplied 0..1 rate as a percentage. Exact 0 and 1 render without
 * a decimal, because "0.0%" reads as a rounded small number rather than none. */
export function formatPercent(rate: number): string {
  if (!Number.isFinite(rate)) return '0%'
  if (rate === 0) return '0%'
  if (rate === 1) return '100%'
  return `${(rate * 100).toFixed(1)}%`
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * `Funnel.window_seconds` in human units, e.g. "7-day window" -- never the
 * raw seconds count the wire carries. Reuses `secondsToWindowInput`'s own
 * "pick the largest unit that divides evenly" (`WindowField`'s seeding
 * logic) rather than a second, hand-rolled copy, so a list row always
 * agrees with what the builder itself would show if this same window were
 * opened for editing. The unit is singularised by hand (`PER_UNIT`'s keys
 * are the plural `minutes`/`hours`/`days` an operator picks from a
 * `<select>`) because "7-days window" reads as a typo, not two windows.
 */
export function formatWindow(seconds: number): string {
  const { value, unit } = secondsToWindowInput(seconds)
  const singular = unit.slice(0, -1)
  return `${value}-${singular} window`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`
}

/**
 * The subtitle's range label, derived from the RESOLVED `range` a run or
 * preview actually answered -- never from picker state. `FunnelRunResult`
 * carries `range: { since, until }` precisely so the client never has to
 * guess what it ran over; deriving this from a `days` selector instead (the
 * whole-branch review's I1) can show "Last 90 days" beside numbers that were
 * actually computed for 30, because the picker can move after the request
 * that produced the numbers on screen was already in flight.
 */
/** How many whole days a range spans, or `null` when either bound does not
 * parse. Split out of `formatRangeDays` so the two phrasings below cannot
 * disagree about the arithmetic — the label and the sentence describe the
 * same range and must count it the same way. */
export function rangeDays(range: { since: string; until: string }): number | null {
  const since = new Date(range.since).getTime()
  const until = new Date(range.until).getTime()
  if (Number.isNaN(since) || Number.isNaN(until)) return null
  return Math.round((until - since) / DAY)
}

export function formatRangeDays(range: { since: string; until: string }): string {
  const days = rangeDays(range)
  if (days === null) return 'unknown range'
  return `Last ${days} day${days === 1 ? '' : 's'}`
}

/**
 * The same range as a clause that reads inside a sentence.
 *
 * `formatRangeDays` is a LABEL — capitalised, standing alone under a chart or
 * in a dropdown. Dropped mid-sentence it produces "Showing Last 7 days",
 * which is why this exists rather than the caller lowercasing by hand and
 * getting "unknown range" wrong at the edge.
 *
 * One day is "the last day", not "the last 1 day": a range picker offering
 * "Last 1 day" is a list where the parallel matters more than the grammar,
 * and a sentence is the opposite case.
 */
export function rangePhrase(days: number | null): string {
  if (days === null) return 'an unknown range'
  if (days === 1) return 'the last day'
  return `the last ${days} days`
}

/** `now` is a parameter, not `new Date()`, so this is a pure function a test
 * can pin by value rather than by shape. */
export function formatRelative(iso: string, now: Date): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return 'unknown'
  const delta = now.getTime() - then
  if (delta < MINUTE) return 'just now'
  if (delta < HOUR) return plural(Math.floor(delta / MINUTE), 'minute')
  if (delta < DAY) return plural(Math.floor(delta / HOUR), 'hour')
  return plural(Math.floor(delta / DAY), 'day')
}

/**
 * One step of a funnel, as prose: its event, plus the predicates narrowing
 * it if it carries any.
 *
 * `page_view (where page is changelog, duration_ms at least 30)`.
 *
 * A step's predicates could only be written through the API until the
 * builder gained an editor for them, so every screen that lists a funnel
 * rendered the bare event name and two funnels differing only in their
 * predicates were the same row. Predicated steps are ordinary now, which
 * makes that ambiguity the common case rather than the exotic one.
 *
 * The words are `wherePhrase`'s, i.e. the segments vocabulary's -- `at
 * least`, `is not`, `between X and Y` -- so a predicate reads the same here,
 * in a segment's summary, and on the control that authored it. Spelling the
 * operator a second way in this package is exactly the drift that module
 * exists to prevent.
 *
 * **The brackets are load-bearing, not decoration.** `wherePhrase` returns a
 * comma-separated list with no terminator (its own doc comment), and these
 * labels get joined by ` -> ` into a chain: without them,
 * `page_view where page is changelog, duration_ms at least 30 -> signup`
 * leaves a reader no marker for where step 1's predicates stop, and a
 * summary that can be misread is worse than none -- acting on the wrong
 * population looks exactly like acting on the right one.
 *
 * `(optional)` for the same reason the predicates are here at all: two
 * funnels whose steps differ only in which one is optional measure
 * different populations and would otherwise render as the same row. It
 * follows the event and precedes the `where` clause, matching the order the
 * flow chart's own `aria-label` reads a step in -- `page_view (optional)
 * (where page is changelog)`.
 */
export function stepLabel(step: FunnelStep): string {
  const name = step.optional === true ? `${step.event} (optional)` : step.event
  if (step.where == null || step.where.length === 0) return name
  return `${name} (where ${wherePhrase(step.where)})`
}

/** A funnel's steps as one line, in order. */
export function stepChain(steps: readonly FunnelStep[]): string {
  return steps.map(stepLabel).join(' → ')
}
