import type { RetentionRequest } from '../../api/types.js'

export const GRANULARITIES = ['day', 'week', 'month'] as const
export type Granularity = (typeof GRANULARITIES)[number]

/** The same ceiling the API enforces. Stated here so the control cannot ask
 * for a grid the server refuses. */
export const MAX_PERIODS = 26

export interface RetentionParams {
  start: string
  return: string
  granularity: Granularity
  periods: number
}

export const DEFAULTS: RetentionParams = {
  start: '',
  return: '',
  granularity: 'week',
  periods: 8,
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
  return out
}

/** The request body a set of params compiles to. */
export function toRequest(p: RetentionParams): RetentionRequest {
  return {
    start_event: p.start,
    return_event: p.return,
    granularity: p.granularity,
    periods: p.periods,
  }
}
