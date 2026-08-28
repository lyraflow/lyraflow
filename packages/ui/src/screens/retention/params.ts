import { WherePredicate } from '@lyraflow/core/segments/ast.js'
import type { RetentionRequest } from '../../api/types.js'

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
}

export const DEFAULTS: RetentionParams = {
  start: '',
  return: '',
  startWhere: [],
  returnWhere: [],
  granularity: 'week',
  periods: 8,
}

/**
 * Reads a `where` list out of one URL parameter.
 *
 * JSON in a query string is not pretty, and the alternative is worse: the
 * screen's whole persistence IS the URL, so leaving predicates out of it
 * would mean a link that silently reproduces a DIFFERENT grid from the one
 * whoever shared it was looking at.
 *
 * Validated through core's own `WherePredicate`, per element, rather than
 * trusted as parsed JSON. A hand-edited or truncated link then degrades to
 * "no predicates" instead of building a tree the server refuses -- and a
 * predicate that survives here is one the compiler can definitely compile.
 */
function readWhere(raw: string | null): WherePredicate[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: WherePredicate[] = []
    for (const item of parsed) {
      const one = WherePredicate.safeParse(item)
      if (one.success) out.push(one.data)
    }
    return out
  } catch {
    return []
  }
}

function granularityOf(raw: string | null): Granularity {
  return (GRANULARITIES as readonly string[]).includes(raw ?? '')
    ? (raw as Granularity)
    : DEFAULTS.granularity
}

/**
 * Reads the grid's whole definition out of the URL.
 *
 * This report has no store — the URL IS its persistence (see the design
 * note), so this and `writeRetentionParams` are the only place its shape is
 * decided. Every unreadable value falls back to the default rather than
 * failing: a hand-edited or truncated link should open a usable screen, not
 * an error page.
 */
export function readRetentionParams(search: URLSearchParams): RetentionParams {
  const rawPeriods = Number(search.get('periods'))
  return {
    start: search.get('start') ?? DEFAULTS.start,
    return: search.get('return') ?? DEFAULTS.return,
    startWhere: readWhere(search.get('start_where')),
    returnWhere: readWhere(search.get('return_where')),
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
  return out
}

/** The request body a set of params compiles to. */
export function toRequest(p: RetentionParams): RetentionRequest {
  return {
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
