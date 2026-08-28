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
 * The strongest measured cell in the grid, as a percentage.
 *
 * What every other cell's shading is drawn relative to. `0` when nothing is
 * measured yet, which the caller reads as "no shading".
 */
export function peakShare(cohorts: CohortRow[]): number {
  let peak = 0
  for (const c of cohorts) {
    for (const cell of c.retained) {
      const pct = share(cell, c.size)
      if (pct !== null && pct > peak) peak = pct
    }
  }
  return peak
}

/** The strongest tint any cell gets. */
export const MAX_TINT = 0.32
/**
 * The faintest tint a NON-ZERO cell gets.
 *
 * A cell where somebody came back must never be indistinguishable from one
 * where nobody did. Same reasoning as the feed sparkline's minimum bar
 * height: the floor is what stops "very small" rendering as "nothing".
 */
export const MIN_TINT = 0.05

/**
 * How strongly to tint a cell, 0-1 -- **relative to the grid's own strongest
 * cell, on a square-root curve**.
 *
 * Both halves of that are corrections to a linear scale against an absolute
 * 100%, which is what this was and which failed exactly the way the feed
 * sparkline's own comment predicts: "a linear scale is the honest default and
 * it stops working at this shape".
 *
 * Measured on a real grid. A retention report narrowed with `where` predicates
 * -- viewed `/`, then came back and viewed `/signup` -- peaks at 51% and has
 * most of its measured cells between 0 and 15%. Linearly against 100 those are
 * opacities of 0.00 to 0.05, which is a table with no shading at all; the same
 * report unnarrowed has a column of 100% and looked fine, so the scale worked
 * only for the grid whose numbers were biggest. Reported as "you removed the
 * gradient" on 2026-08-28, which is what it looks like from outside.
 *
 * RELATIVE, so the strongest cell in any grid is always fully tinted. The cost
 * is that colour no longer means an absolute rate and two grids are not
 * comparable by shade -- accepted, and STATED under the table, because every
 * cell prints its own percentage: the number is the measurement and the colour
 * is a guide to where to look.
 *
 * SQUARE ROOT rather than linear, for the reason `Sparkline` gives for its bar
 * heights: it lifts the middle of the range off the floor while leaving the
 * order and the zero exactly as they were. Log was not tried here because the
 * range is bounded at both ends, unlike an event count.
 */
export function tint(pct: number | null, peak: number): number {
  if (pct === null || pct <= 0 || peak <= 0) return 0
  const fraction = Math.min(1, pct / peak)
  return Math.max(MIN_TINT, Math.sqrt(fraction) * MAX_TINT)
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
