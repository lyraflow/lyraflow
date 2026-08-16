/**
 * Formatting only. Nothing here computes a rate: `from_previous` and
 * `from_start` arrive from the server, which returns both deliberately
 * because deriving one from the other is a multiplication callers get
 * subtly wrong. See packages/core/src/funnels/levels.ts.
 */

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

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`
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
