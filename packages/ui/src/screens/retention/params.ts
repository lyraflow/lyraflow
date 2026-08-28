import { WherePredicate } from '@lyraflow/core/segments/ast.js'
import type { RetentionRequest } from '../../api/types.js'
import {
  DEFAULT_RANGE,
  type RangeChoice,
  bucketsIn,
  readRange,
  resolveRange,
  writeRange,
} from '../shared/range.js'

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
 * Reads a `where` list out of one URL parameter.
 *
 * JSON in a query string is not pretty, and the alternative is worse: the
 * screen's whole persistence IS the URL, so leaving predicates out of it
 * would mean a link that silently reproduces a DIFFERENT grid from the one
 * whoever shared it was looking at.
 *
 * **Deliberately LENIENT about completeness.** This validated every element
 * against core's full `WherePredicate` and that was a real bug: the editor
 * adds a blank row (`{ property: '', operator: '=', value: '' }`) and
 * `property` is `z.string().min(1)`, so a newly-added row failed on the way
 * back out and "Add predicate" looked like a dead button. The control was
 * fine; this function ate its output.
 *
 * So the check is STRUCTURAL -- is this shaped like a predicate the editor
 * can render -- not "is this finished". Finishedness is a separate question,
 * answered by `incompletePredicates` and reported on the screen, because a
 * half-built row must block the run rather than be dropped from it: dropping
 * it would quietly widen the grid the operator thought they had built.
 *
 * Garbage is still refused. An array of numbers, strings or objects with no
 * operator degrades to no predicates, which is what a hand-edited or
 * truncated link should do.
 */
function looksLikePredicate(v: unknown): v is WherePredicate {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.operator !== 'string') return false
  if (o.source === 'attribute') return typeof o.attribute === 'string'
  return typeof o.property === 'string'
}

function readWhere(raw: string | null): WherePredicate[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(looksLikePredicate)
  } catch {
    return []
  }
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
  return [...p.startWhere, ...p.returnWhere].filter((w) => !WherePredicate.safeParse(w).success)
    .length
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
  return writeRange(out, next.range)
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
  }
}
