import type { WherePredicate } from '@lyraflow/core/segments/ast.js'
import type { RetentionRequest } from '../../api/types.js'
import {
  DEFAULT_RANGE,
  type RangeChoice,
  bucketsIn,
  readRange,
  resolveRange,
  writeRange,
} from '../shared/range.js'
import { countIncomplete, readWhere, whereFromStored } from '../shared/where.js'

export { whereFromStored }

export const GRANULARITIES = ['day', 'week', 'month'] as const
export type Granularity = (typeof GRANULARITIES)[number]

/** The same ceiling the API enforces. Stated here so the control cannot ask
 * for a grid the server refuses. */
export const MAX_PERIODS = 26

export interface RetentionParams {
  start: string
  return: string
  /** Which occurrence of the start event counts. */
  startWhere: WherePredicate[]
  /** Which occurrence of the return event counts. Independent of the above. */
  returnWhere: WherePredicate[]
  granularity: Granularity
  periods: number
  range: RangeChoice
  /** The population this grid is restricted to, or `null` for everyone.
   * Round-tripped through the URL like every other field here even though
   * this screen offers no picker for it -- its only writer is the seed step
   * in `Retention.tsx`, carrying a saved report's stored `segment_id`
   * through so every run (not only the first, auto-run one) keeps asking
   * about the same population the report was saved against. Carrying the
   * ID rather than dropping it is decision 3 in the saved-reports spec: the
   * run path looks it up, and if it is gone, says so and runs over
   * everyone rather than silently widening with nothing said. */
  segmentId: number | null
}

/** An upper bound on one period, for the cohort-count check only. A month is
 * taken as its SHORTEST (28 days) so this can only over-count cohorts, which
 * fails safe -- the same direction `validateRetention` errs in on the
 * server. */
const PERIOD_MS: Record<Granularity, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 28 * 86_400_000,
}

/** `MAX_COHORTS` in `core/retention/ast.ts`. Restated for the reason
 * `MAX_PERIODS` is: a control must not offer a run the server refuses. */
export const MAX_COHORTS = 60

export const DEFAULTS: RetentionParams = {
  start: '',
  return: '',
  startWhere: [],
  returnWhere: [],
  granularity: 'week',
  periods: 8,
  range: DEFAULT_RANGE,
  segmentId: null,
}

export function cohortCount(p: RetentionParams, now: Date): number | null {
  return bucketsIn(p.range, PERIOD_MS[p.granularity], now)
}

export function tooManyCohorts(p: RetentionParams, now: Date): boolean {
  const n = cohortCount(p, now)
  return n !== null && n > MAX_COHORTS
}

function granularityOf(raw: string | null): Granularity {
  return (GRANULARITIES as readonly string[]).includes(raw ?? '')
    ? (raw as Granularity)
    : DEFAULTS.granularity
}

/**
 * M4 from the whole-branch review: a bare `Number()` coerces shapes a
 * numeric id must not accept -- `'0x10'` reads as 16, `'1e3'` as 1000.
 * `packages/server/src/numeric-id.ts`'s own docstring is the reason this
 * matches its strictness rather than the loose parse this used to be: two
 * routes there once skipped exactly this check by copying each other, and
 * the second one's own comment said so. `/^\d+$/` first, so `Number()`
 * never sees anything it could coerce, then `Number.isSafeInteger` for the
 * same reason that file's own parser applies it. No security stake here --
 * the server's segment lookup is project-scoped and this is the operator's
 * own URL -- but the UI package cannot import a server module (this would
 * pull the whole server package into the browser bundle), so the check is
 * restated rather than shared, the same way `MAX_BUCKETS` and `MAX_COHORTS`
 * already are in this file and `trends/params.ts`.
 */
function readSegmentId(raw: string | null): number | null {
  if (raw == null || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * How many predicates are not yet finished.
 *
 * Checked against core's own schema, so "finished" means exactly "the server
 * would accept it" rather than a second opinion about it that could drift.
 * The screen disables Run and says the count: sending an incomplete
 * predicate is a 400 the operator did not ask for, and silently dropping it
 * runs a wider grid than they built.
 */
export function incompletePredicates(p: RetentionParams): number {
  return countIncomplete([...p.startWhere, ...p.returnWhere])
}

export function readRetentionParams(search: URLSearchParams): RetentionParams {
  const rawPeriods = Number(search.get('periods'))
  return {
    start: search.get('start') ?? DEFAULTS.start,
    return: search.get('return') ?? DEFAULTS.return,
    startWhere: readWhere(search.get('start_where')),
    returnWhere: readWhere(search.get('return_where')),
    range: readRange(search),
    granularity: granularityOf(search.get('granularity')),
    periods:
      Number.isInteger(rawPeriods) && rawPeriods > 0 && rawPeriods <= MAX_PERIODS
        ? rawPeriods
        : DEFAULTS.periods,
    segmentId: readSegmentId(search.get('segment')),
  }
}

/**
 * Writes them back, dropping anything that equals its default.
 *
 * A URL carrying only what was actually chosen is one somebody can read, and
 * it keeps `/retention` itself a clean link rather than a query string of
 * defaults. Empty event names are omitted for the same reason — the screen
 * has not been asked to measure anything yet.
 */
export function writeRetentionParams(
  previous: URLSearchParams,
  next: RetentionParams,
): URLSearchParams {
  const out = new URLSearchParams(previous)
  const set = (key: string, value: string, fallback: string) => {
    if (value === '' || value === fallback) out.delete(key)
    else out.set(key, value)
  }
  set('start', next.start, DEFAULTS.start)
  set('return', next.return, DEFAULTS.return)
  set('granularity', next.granularity, DEFAULTS.granularity)
  set('periods', String(next.periods), String(DEFAULTS.periods))
  // An empty list is omitted rather than written as `[]`, so an untouched
  // screen still has a clean `/retention` address.
  set('start_where', next.startWhere.length > 0 ? JSON.stringify(next.startWhere) : '', '')
  set('return_where', next.returnWhere.length > 0 ? JSON.stringify(next.returnWhere) : '', '')
  if (next.segmentId == null) out.delete('segment')
  else out.set('segment', String(next.segmentId))
  return writeRange(out, next.range)
}

/** The URL keys that make up a retention report's DEFINITION -- everything a
 * saved report seeds from storage. Deliberately excludes `range`/`from`/`to`:
 * decision 1 in the saved-reports spec is that the range is never stored,
 * so it is not part of what "already carries a definition" means here --
 * a link that only pins a range (`?range=90d`) still seeds its events,
 * predicates, granularity, periods and segment from the stored definition,
 * and a link that pins an explicit granularity keeps that granularity
 * rather than the stored one. */
const DEFINITION_KEYS = [
  'start',
  'return',
  'start_where',
  'return_where',
  'granularity',
  'periods',
  'segment',
] as const

/**
 * True when the URL already carries some part of a retention report's
 * definition -- the gate `Retention.tsx` uses to decide whether opening a
 * saved report may seed the URL from the stored row at all.
 *
 * All-or-nothing over the seven keys, not seeded field-by-field, for the
 * same reason `hasTrendDefinitionParams` is: a partial seed would make the
 * definition on screen a splice of two sources (the URL for whichever
 * fields happened to be present, storage for the rest), which is exactly
 * the second source of truth this screen is built to avoid. A shared link
 * that already names any part of the definition is trusted whole; a link
 * that names none of it is seeded whole.
 */
export function hasRetentionDefinitionParams(search: URLSearchParams): boolean {
  return DEFINITION_KEYS.some((key) => search.has(key))
}

/** The request body a set of params compiles to. */
export function toRequest(p: RetentionParams, now: Date = new Date()): RetentionRequest {
  const bounds = resolveRange(p.range, now)
  return {
    ...bounds,
    start_event: p.start,
    return_event: p.return,
    granularity: p.granularity,
    periods: p.periods,
    // Omitted when empty rather than sent as `[]`: the route treats an absent
    // list and an empty one identically, and not sending one keeps the
    // request the same shape it was before predicates existed.
    ...(p.startWhere.length > 0 ? { start_where: p.startWhere } : {}),
    ...(p.returnWhere.length > 0 ? { return_where: p.returnWhere } : {}),
    // Omitted when `null` rather than sent as `segment_id: null`, for the
    // same reason -- an unrestricted grid is the request shape this screen
    // sent before a segment could be carried at all, and the pre-existing
    // "runs the definition in the URL" test in `Retention.test.tsx` asserts
    // that exact key set.
    ...(p.segmentId != null ? { segment_id: p.segmentId } : {}),
  }
}
