// `INTERVALS`/`Interval` come off core's TOP-LEVEL export, not a deep
// `trends/ast.js` path -- that path is not in `@lyraflow/core`'s `exports`
// map, only `index.ts`'s barrel re-export of it is, so a deep import here
// would resolve at typecheck time and fail at build (`packages/ui/src/api/
// types.ts` carries the same note for `Interval`/`Granularity`). This used
// to be a third, hand-written copy of the same four strings -- Task 2's
// review found it restated a second time in a server route and moved it
// into core; this was the copy left over, and core is now the single
// TypeScript source of truth. `020_saved_reports.sql`'s CHECK constraint is
// the one copy that cannot be removed, because SQL cannot import a
// TypeScript module.
import { INTERVALS, type Interval } from '@lyraflow/core'
import {
  DEFAULT_RANGE,
  type RangeChoice,
  bucketsIn,
  readRange,
  writeRange,
} from '../shared/range.js'

export { INTERVALS }

/** Milliseconds per bucket, keyed like `INTERVALS`. The server's own ceiling
 * is on BUCKETS, so this is what turns a range into that number. This stays
 * here rather than moving to core alongside `INTERVALS` -- it is a UI
 * concern (turning a range choice into a request-shape decision), and core
 * has no business knowing how long a millisecond-scale bucket is. */
export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000,
  '1h': 3_600_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
}

/** `STATS_MAX_BUCKETS` in `events/routes.ts`. Restated rather than imported --
 * the UI package does not depend on the server -- and the point of restating
 * it is to refuse a combination here rather than send a request the server
 * will refuse anyway. */
export const MAX_BUCKETS = 1000

export const BREAKDOWN_SOURCES = ['none', 'event_name', 'attribute', 'property'] as const
export type BreakdownSource = (typeof BREAKDOWN_SOURCES)[number]

export interface TrendParams {
  event: string
  interval: Interval
  source: BreakdownSource
  field: string
  range: RangeChoice
}

export const DEFAULTS: TrendParams = {
  event: '',
  interval: '1d',
  source: 'none',
  field: '',
  range: DEFAULT_RANGE,
}

/**
 * How many buckets the current definition would ask for, or `null` when the
 * range is the server's to pick.
 *
 * The pairing matters more than either half: 30 days at `1m` is 43,200
 * buckets against a ceiling of 1000, and offering span and resolution as two
 * independent choices is exactly how somebody builds that by accident. Said
 * on the screen before the request goes, rather than returned as a 400.
 */
export function bucketCount(p: TrendParams, now: Date): number | null {
  return bucketsIn(p.range, INTERVAL_MS[p.interval], now)
}

export function tooManyBuckets(p: TrendParams, now: Date): boolean {
  const n = bucketCount(p, now)
  return n !== null && n > MAX_BUCKETS
}

function oneOf<T extends string>(list: readonly T[], raw: string | null, fallback: T): T {
  return (list as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback
}

/**
 * Reads a trend's whole definition out of the URL.
 *
 * Like the retention grid and the Feed, the URL is this screen's only
 * persistence -- so a chart is shareable as a link and there is nothing to
 * save. Every unreadable value falls back to its default rather than failing:
 * a hand-edited or truncated link should open a usable screen.
 */
export function readTrendParams(search: URLSearchParams): TrendParams {
  return {
    event: search.get('event') ?? DEFAULTS.event,
    interval: oneOf(INTERVALS, search.get('interval'), DEFAULTS.interval),
    source: oneOf(BREAKDOWN_SOURCES, search.get('source'), DEFAULTS.source),
    field: search.get('field') ?? DEFAULTS.field,
    range: readRange(search),
  }
}

/** Writes them back, dropping anything that equals its default. */
export function writeTrendParams(previous: URLSearchParams, next: TrendParams): URLSearchParams {
  const out = new URLSearchParams(previous)
  const set = (key: string, value: string, fallback: string) => {
    if (value === '' || value === fallback) out.delete(key)
    else out.set(key, value)
  }
  set('event', next.event, DEFAULTS.event)
  set('interval', next.interval, DEFAULTS.interval)
  set('source', next.source, DEFAULTS.source)
  set('field', next.field, DEFAULTS.field)
  return writeRange(out, next.range)
}

/**
 * The `group_by` value a set of params compiles to, or `undefined`.
 *
 * `undefined` for a source that needs a field and has not been given one --
 * so a half-finished breakdown asks for an ungrouped chart rather than a
 * request the server refuses. The screen says separately that the split is
 * not finished.
 */
export function groupByOf(p: TrendParams): string | undefined {
  if (p.source === 'none') return undefined
  if (p.source === 'event_name') return 'event_name'
  if (p.field === '') return undefined
  return `${p.source}:${p.field}`
}

/** True when a breakdown was chosen but its field is still empty. */
export function breakdownIncomplete(p: TrendParams): boolean {
  return (p.source === 'attribute' || p.source === 'property') && p.field === ''
}

/**
 * The inverse of `groupByOf`: turns a stored trend's `group_by` wire value
 * back into the `source`/`field` pair the controls understand. Used only
 * when seeding a saved trend's URL from its stored definition
 * (`Trends.tsx`) -- `TrendReports.tsx`'s `groupBySummary` needed only the
 * field half, for a one-line display, and stayed a narrower, one-way read
 * rather than growing into this.
 *
 * A `group_by` this cannot parse falls back to `none` rather than throwing.
 * Decision 2 in the saved-reports spec is explicit that a trend's
 * definition cannot fail to parse -- `group_by` is free text the report
 * endpoint accepts or rejects on its own terms, not a grammar with its own
 * `stale` flag the way retention's `where` clauses have -- so this is a
 * defensive fallback for a row written by hand or by a future version of
 * this code, not a case the product is expected to reach.
 */
export function sourceAndFieldFromGroupBy(groupBy: string | null): {
  source: BreakdownSource
  field: string
} {
  if (groupBy === null) return { source: 'none', field: '' }
  if (groupBy === 'event_name') return { source: 'event_name', field: '' }
  const i = groupBy.indexOf(':')
  if (i < 0) return { source: 'none', field: '' }
  const source = groupBy.slice(0, i)
  const field = groupBy.slice(i + 1)
  if ((source === 'attribute' || source === 'property') && field !== '') {
    return { source, field }
  }
  return { source: 'none', field: '' }
}

/** The URL keys that make up a trend's DEFINITION -- everything a saved
 * trend seeds from storage. Deliberately excludes `range`/`from`/`to`:
 * decision 1 in the saved-reports spec is that the range is never stored,
 * so it is not part of what "already carries a trend parameter" means here
 * -- a link that only pins a range (`?range=30d`) still seeds its event,
 * interval and breakdown from the stored definition, and a link that pins
 * an explicit interval keeps that interval rather than the stored one. */
const DEFINITION_KEYS = ['event', 'interval', 'source', 'field'] as const

/**
 * True when the URL already carries some part of a trend's definition --
 * the gate `Trends.tsx` uses to decide whether opening a saved report may
 * seed the URL from the stored row at all.
 *
 * All-or-nothing over the four keys, not seeded field-by-field: a partial
 * seed would make the definition on screen a splice of two sources (the
 * URL for whichever fields happened to be present, storage for the rest),
 * which is exactly the second source of truth this screen is built to
 * avoid. A shared link that already names an event, interval or breakdown
 * is trusted whole; a link that names none of them is seeded whole.
 */
export function hasTrendDefinitionParams(search: URLSearchParams): boolean {
  return DEFINITION_KEYS.some((key) => search.has(key))
}
