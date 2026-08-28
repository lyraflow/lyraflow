/**
 * The date range Trends and Retention share.
 *
 * Both screens hold their whole definition in the URL and run on demand, and
 * both had NO range control at all -- each fell back to a server default
 * scaled to its own resolution. That is a good default and a bad only option:
 * a project whose data stops a week ago shows an empty chart and nothing on
 * screen explains why.
 */

/** `auto` is not a range. It means "send no bounds", which is what both
 * screens did before this control existed -- the server then picks a window
 * scaled to the resolution, which is tuned per interval and worth keeping as
 * the default rather than replacing with a fixed span. */
export const AUTO = 'auto'
export const CUSTOM = 'custom'

export const RANGE_PRESETS = [
  { id: AUTO, label: 'Default for this resolution', spanMs: 0 },
  { id: '24h', label: 'Last 24 hours', spanMs: 86_400_000 },
  { id: '7d', label: 'Last 7 days', spanMs: 7 * 86_400_000 },
  { id: '30d', label: 'Last 30 days', spanMs: 30 * 86_400_000 },
  { id: '90d', label: 'Last 90 days', spanMs: 90 * 86_400_000 },
  { id: '180d', label: 'Last 6 months', spanMs: 180 * 86_400_000 },
  { id: '365d', label: 'Last 12 months', spanMs: 365 * 86_400_000 },
  { id: CUSTOM, label: 'Between two dates…', spanMs: 0 },
] as const

export type RangePresetId = (typeof RANGE_PRESETS)[number]['id']

export interface RangeChoice {
  preset: RangePresetId
  /** `YYYY-MM-DD`, and only meaningful when `preset` is `custom`. */
  from: string
  to: string
}

export const DEFAULT_RANGE: RangeChoice = { preset: AUTO, from: '', to: '' }

export function presetById(id: string): (typeof RANGE_PRESETS)[number] | undefined {
  return RANGE_PRESETS.find((p) => p.id === id)
}

export function readRange(search: URLSearchParams): RangeChoice {
  const raw = search.get('range')
  return {
    preset: presetById(raw ?? '') ? (raw as RangePresetId) : DEFAULT_RANGE.preset,
    from: search.get('from') ?? '',
    to: search.get('to') ?? '',
  }
}

export function writeRange(previous: URLSearchParams, next: RangeChoice): URLSearchParams {
  const out = new URLSearchParams(previous)
  if (next.preset === DEFAULT_RANGE.preset) out.delete('range')
  else out.set('range', next.preset)
  // The two dates are written only for `custom`. Leaving them behind on a
  // switch back to a preset would put bounds in the URL that nothing reads,
  // and they would reappear the moment somebody chose `custom` again.
  if (next.preset === CUSTOM && next.from !== '') out.set('from', next.from)
  else out.delete('from')
  if (next.preset === CUSTOM && next.to !== '') out.set('to', next.to)
  else out.delete('to')
  return out
}

/**
 * The bounds a choice sends, or `{}` for "let the server decide".
 *
 * A `custom` range missing either date resolves to `{}` as well, and the
 * screen says separately that it is unfinished -- resolving half of it would
 * silently pair a chosen start with an unchosen end.
 *
 * Dates are read as whole UTC days, and `to` is INCLUSIVE: somebody who picks
 * 1–7 June means the whole of the 7th, not midnight at its start. Both
 * screens bucket in UTC (`toStartOfWeek`, `toStartOfInterval`), so reading the
 * picker in local time would put an event in a different bucket than the one
 * its own label names.
 */
export function resolveRange(choice: RangeChoice, now: Date): { since?: string; until?: string } {
  if (choice.preset === CUSTOM) {
    // DELIBERATELY REDUNDANT with the `NaN` check below: an empty string
    // parses to an Invalid Date, so that guard already catches this case and
    // mutating this line changes no observable behaviour. It stays because
    // "one of the dates is missing" is the reason, and leaving it to be
    // inferred from date parsing makes the next reader work it out. Noted so
    // nobody deletes one of the two thinking it is dead, or spends a round
    // wondering why breaking it fails nothing.
    if (choice.from === '' || choice.to === '') return {}
    const since = new Date(`${choice.from}T00:00:00.000Z`)
    const until = new Date(`${choice.to}T23:59:59.999Z`)
    if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return {}
    if (until.getTime() <= since.getTime()) return {}
    return { since: since.toISOString(), until: until.toISOString() }
  }
  const preset = presetById(choice.preset)
  if (!preset || preset.spanMs === 0) return {}
  return {
    since: new Date(now.getTime() - preset.spanMs).toISOString(),
    until: now.toISOString(),
  }
}

/** True when `custom` is chosen but not filled in. */
export function rangeIncomplete(choice: RangeChoice): boolean {
  if (choice.preset !== CUSTOM) return false
  return Object.keys(resolveRange(choice, new Date())).length === 0
}

/**
 * How many buckets a choice would produce at `bucketMs`, or `null` when the
 * range is the server's to pick.
 *
 * Both screens have a ceiling the server enforces -- 1000 buckets for a
 * trend, 60 cohorts for a grid -- and both refuse rather than truncate. This
 * is what lets a screen say so BEFORE sending a request it knows will be
 * refused, which is a better answer than the 400.
 */
export function bucketsIn(choice: RangeChoice, bucketMs: number, now: Date): number | null {
  const { since, until } = resolveRange(choice, now)
  if (since === undefined || until === undefined || bucketMs <= 0) return null
  return Math.ceil((new Date(until).getTime() - new Date(since).getTime()) / bucketMs)
}
