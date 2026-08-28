import type { CohortRow, RetentionResult } from '../../api/types.js'

/**
 * A cell's retention as a percentage of its cohort, or `null` when the cell
 * was not measurable.
 *
 * `null` in, `null` out — the distinction the API draws between "nobody came
 * back" and "that period has not finished" is the one thing this screen must
 * not collapse, and doing the arithmetic on a `null` would produce `0`.
 *
 * A cohort of zero cannot happen (a cohort exists because somebody entered
 * it) but is handled rather than divided by: the alternative is `NaN%` on
 * screen, which reads as a bug in the report rather than in this function.
 */
export function share(cell: number | null, size: number): number | null {
  if (cell === null) return null
  if (size === 0) return null
  return (cell / size) * 100
}

/**
 * How strongly to tint a cell, 0–1.
 *
 * Linear in the percentage and capped well below 1, because the tint is
 * behind text that still has to be read: at full strength the strongest
 * cells lose their contrast, which is the one thing `marketing/brand`'s
 * rules refuse to trade away.
 */
export const MAX_TINT = 0.32

export function tint(pct: number | null): number {
  if (pct === null) return 0
  return Math.max(0, Math.min(100, pct)) * (MAX_TINT / 100)
}

/**
 * The column heading for period `k`.
 *
 * Period 0 is named rather than numbered because it is the one column whose
 * meaning is not obvious: it is the cohort's OWN period, so for a grid whose
 * start and return events are the same it is 100% by construction, and for
 * one where they differ it is the most interesting number on the screen.
 */
export function periodLabel(k: number, granularity: RetentionResult['granularity']): string {
  if (k === 0) return `Same ${granularity}`
  return `+${k}`
}

/**
 * A cohort's row label: the date the period starts, as the reader's own
 * calendar reads it.
 *
 * The API returns `YYYY-MM-DD` for a bucket that is UTC by construction, so
 * it is formatted from its parts rather than through `new Date` — which
 * would resolve it in the browser's zone and could show the day before.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function cohortLabel(bucket: string): string {
  const [y, m, d] = bucket.split('-').map(Number)
  if (!y || !m || !d) return bucket
  return `${d} ${MONTHS[m - 1]} ${y}`
}

/**
 * How many cells across the whole grid could not be measured.
 *
 * Reported as a sentence above the table rather than left for the reader to
 * infer from the dashes. A grid where a third of the cells are "not yet" is
 * a different object from one where two are, and the difference decides
 * whether the trend along a column means anything.
 */
export function unmeasuredCount(cohorts: CohortRow[]): number {
  return cohorts.reduce((n, c) => n + c.retained.filter((v) => v === null).length, 0)
}
