export const INTERVALS = ['1m', '1h', '1d', '1w'] as const
export type Interval = (typeof INTERVALS)[number]

export const BREAKDOWN_SOURCES = ['none', 'event_name', 'attribute', 'property'] as const
export type BreakdownSource = (typeof BREAKDOWN_SOURCES)[number]

export interface TrendParams {
  event: string
  interval: Interval
  source: BreakdownSource
  field: string
}

export const DEFAULTS: TrendParams = {
  event: '',
  interval: '1d',
  source: 'none',
  field: '',
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
  return out
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
