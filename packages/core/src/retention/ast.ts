import { z } from 'zod'
import { MAX_WHERE_PREDICATES, WherePredicate } from '../segments/ast.js'

/**
 * How wide a period is. No `hour`: retention asks whether somebody came
 * BACK, and an hour is inside one sitting rather than after it -- a grid of
 * hourly cohorts measures session length, which is a different report with a
 * different shape.
 */
export const GRANULARITIES = ['day', 'week', 'month'] as const
export type Granularity = (typeof GRANULARITIES)[number]

/**
 * How many periods after the cohort's own are measured.
 *
 * 26 is half a year of weeks and is already a table wider than a laptop. The
 * cap exists because the grid is RENDERED: every period is a column, so an
 * uncapped `periods` is not a slow query, it is an unreadable screen.
 */
export const MAX_PERIODS = 26

/**
 * How many cohort rows one run may produce.
 *
 * Bounds the row count independently of granularity -- 60 days, 60 weeks and
 * 60 months are all the same table -- so a caller cannot turn a wide range
 * plus `day` into a thousand-row scan by accident.
 */
export const MAX_COHORTS = 60

/**
 * `*` means any event, the same spelling a segment behaviour uses.
 *
 * It is what makes acquisition retention expressible without a second report
 * type: `start: '*'` cohorts people by when they were first seen inside the
 * range, and `return: '*'` measures whether they did anything at all.
 */
export const ANY_EVENT = '*'

export const RetentionQuery = z.object({
  /**
   * The event that puts somebody in a cohort. Their FIRST occurrence of it
   * inside the range decides which cohort -- see the design note; their first
   * occurrence EVER is deliberately not used, because then the range would
   * only filter rather than define.
   */
  start_event: z.string().min(1).max(128),
  /** The event that counts as coming back. May be the same as `start_event`. */
  return_event: z.string().min(1).max(128),
  /**
   * Narrows WHICH occurrence of `start_event` puts somebody in a cohort.
   *
   * The segment `WherePredicate` verbatim, exactly as a funnel step's `where`
   * is -- a claim about one event is one idea, and a parallel grammar for it
   * here would drift from the other two at the first operator added to
   * either.
   *
   * Without this the report cannot ask its most ordinary question: a site
   * whose every navigation is a `$page` can only cohort by "viewed any page",
   * so `$page where path = /register` and `$page where path = /` are the same
   * report. That is the shape Cem hit on 2026-08-28.
   */
  start_where: z.array(WherePredicate).max(MAX_WHERE_PREDICATES).optional(),
  /** The same, for what counts as coming back. Independent of `start_where`:
   * "viewed the pricing page, then came back and viewed the docs" needs two
   * different predicates on the same event name. */
  return_where: z.array(WherePredicate).max(MAX_WHERE_PREDICATES).optional(),
  granularity: z.enum(GRANULARITIES),
  periods: z.number().int().positive().max(MAX_PERIODS),
  /**
   * Bounds COHORT ENTRY, not the measurement. The scan runs on past `until`
   * for as long as the last cohort needs, exactly as a funnel's does -- see
   * `compileRetention`.
   */
  since: z.string().datetime(),
  until: z.string().datetime(),
})
export type RetentionQuery = z.infer<typeof RetentionQuery>

export class RetentionValidationError extends Error {
  constructor(
    message: string,
    readonly code: 'range' | 'cohorts',
  ) {
    super(message)
    this.name = 'RetentionValidationError'
  }
}

/** Milliseconds in one period, for the cohort-count check only. */
const PERIOD_MS: Record<Granularity, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  // An upper bound on a calendar month would UNDER-count cohorts and let an
  // over-cap run through; 28 days is the shortest month, so it can only
  // over-count, which fails safe.
  month: 28 * 86_400_000,
}

/**
 * Refuses a run that would produce more rows than the grid can show, before
 * any SQL is built.
 *
 * Checked here rather than by truncating the result: a grid silently missing
 * its oldest cohorts is a chart with a trend that is not in the data, and the
 * caller has no way to tell it happened.
 */
export function validateRetention(q: RetentionQuery): void {
  const since = new Date(q.since).getTime()
  const until = new Date(q.until).getTime()
  if (!(until > since)) {
    throw new RetentionValidationError('`until` must be after `since`', 'range')
  }
  const cohorts = Math.ceil((until - since) / PERIOD_MS[q.granularity])
  if (cohorts > MAX_COHORTS) {
    throw new RetentionValidationError(
      `that range is ${cohorts} ${q.granularity} cohorts, above the limit of ${MAX_COHORTS}`,
      'cohorts',
    )
  }
}
