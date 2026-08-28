import { RESOLVED_PERSON_ALIAS, resolvedPersonExpr } from '../identity/resolve.js'
import { notSuppressedExpr } from '../privacy/suppression.js'
import { type Params, chDateTime } from '../segments/params.js'
import { ANY_EVENT, type Granularity, type RetentionQuery, validateRetention } from './ast.js'

export interface CompiledRetention {
  sql: string
  params: Record<string, unknown>
}

/**
 * The bucketing function per granularity, and the `dateDiff` unit that
 * counts periods between two buckets.
 *
 * All three return a `Date` rather than a `DateTime`, which is what makes
 * `dateDiff` count whole periods: `toStartOfDay` returns a DateTime and a
 * `dateDiff('day', …)` over two of those is still whole days, but the row
 * label would then carry a `00:00:00` the report never uses. Naming the pair
 * together is the point -- a bucket and a diff unit that disagree produce a
 * grid whose column 1 is not the period after column 0, and nothing about
 * the numbers looks wrong.
 *
 * `toStartOfWeek(t, 1)` is MONDAY. Mode 0 is Sunday, which is ClickHouse's
 * default and is not what a retention grid means anywhere Lyraflow is likely
 * to be read; the mode is written explicitly so it is a decision rather than
 * a default nobody checked.
 */
const BUCKET: Record<Granularity, { of: (ts: string) => string; unit: string }> = {
  day: { of: (ts) => `toDate(${ts})`, unit: 'day' },
  week: { of: (ts) => `toStartOfWeek(${ts}, 1)`, unit: 'week' },
  month: { of: (ts) => `toStartOfMonth(${ts})`, unit: 'month' },
}

/**
 * An upper bound on one period, used ONLY to decide how far past `until` the
 * scan must run.
 *
 * 31 days for a month is deliberately the LONGEST month rather than the
 * shortest: this bound decides how much data is read, so over-estimating
 * costs a little scan and under-estimating silently truncates the last
 * cohort's final periods -- which would read as a real drop-off.
 */
const PERIOD_MS_MAX: Record<Granularity, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 31 * 86_400_000,
}

/**
 * Compiles a retention grid into ONE pass over `events`.
 *
 * The shape:
 *
 *   scan      — bounded by project, by the range extended for observation,
 *               and by the two event names; deduplicated by `event_id` and
 *               filtered by suppression, exactly as the funnel scan is. This
 *               is the only place `events` is read.
 *   cohorts   — each person's FIRST start event inside the range, bucketed.
 *               One row per person; a person belongs to exactly one cohort.
 *   activity  — the distinct buckets in which each person did the return
 *               event, over the whole extended scan.
 *   per-person— for each person in a cohort, an indicator array of length
 *               `periods + 1`: did they return in period 0, 1, … n.
 *   grid      — one row per cohort: its size, and the element-wise sum of
 *               those indicators.
 *
 * `sumForEach` is what makes the last step one aggregate rather than
 * `periods + 1` conditional ones. The alternative -- a `countIf` per column
 * -- grows the SQL with the grid and puts the column count into the query
 * TEXT, which is how a wide report starts failing to parse rather than
 * failing to fit.
 *
 * **The scan runs past `until`, and must.** `until` bounds who ENTERS a
 * cohort; measuring period `n` of the last cohort needs events from `n`
 * periods after that. This is the same entry/observation split funnels
 * already make, and getting it wrong does not error -- it silently reports
 * the newest cohorts as having stopped coming back.
 *
 * Whether a cell was measurable at all is NOT decided here. It depends on
 * `now` rather than on the data, so it is computed by `measurableCells` and
 * applied to the result -- a query that returned 0 for an unfinished period
 * and a query that returned 0 for a real one are indistinguishable in SQL.
 */
export function compileRetention(opts: {
  query: RetentionQuery
  projectId: number
  database: string
  now: Date
  /** The person-set SQL a segment restriction compiled to, if any. */
  segmentPersonSql?: string
  params: Params
}): CompiledRetention {
  const { query, projectId, database, now, segmentPersonSql, params } = opts

  validateRetention(query)

  const bucket = BUCKET[query.granularity]
  const since = new Date(query.since)
  const until = new Date(query.until)

  // `periods + 1` because period 0 is measured too (it is the cohort's own
  // period, and when start and return differ it is the most interesting cell
  // in the grid rather than a guaranteed 100%).
  const observeMs = (query.periods + 1) * PERIOD_MS_MAX[query.granularity]
  // Capped at `now`: there are no events in the future, and an unbounded
  // upper bound would defeat the partition pruning the range exists for.
  const scanUntil = new Date(Math.min(until.getTime() + observeMs, now.getTime()))

  const projectParam = params.add(projectId, 'UInt32')
  const sinceParam = params.add(chDateTime(since), 'DateTime64(3)')
  const untilParam = params.add(chDateTime(until), 'DateTime64(3)')
  const scanEnd = params.add(chDateTime(scanUntil), 'DateTime64(3)')
  const periodsParam = params.add(query.periods, 'UInt32')

  const resolved = resolvedPersonExpr({ database, alias: 'e' })
  const notSuppressed = notSuppressedExpr({
    database,
    projectId,
    params,
    person: resolved,
    instant: 'e.timestamp',
  })

  // `*` compiles to NO event_name predicate rather than to a comparison
  // against the literal `'*'`, which would match nothing. Same rule as a
  // segment behaviour's event.
  const anyStart = query.start_event === ANY_EVENT
  const anyReturn = query.return_event === ANY_EVENT
  const startName = anyStart ? null : params.add(query.start_event, 'String')
  const returnName = anyReturn ? null : params.add(query.return_event, 'String')

  // The scan reads only the events some part of the report can use. When
  // either side is `*` there is nothing to narrow by and the predicate is
  // omitted entirely -- an `IN` list containing one name would then exclude
  // the very events the `*` side exists to count.
  const names = [startName, returnName].filter((n): n is string => n !== null)
  const nameFilter =
    anyStart || anyReturn ? '' : `\n      AND event_name IN (${[...new Set(names)].join(', ')})`

  const startCond = startName === null ? '1' : `event_name = ${startName}`
  const returnCond = returnName === null ? '1' : `event_name = ${returnName}`

  // ANDed into the WHERE, not appended after the GROUP BY. It was the
  // latter, which is not merely stylistically wrong -- `GROUP BY x WHERE …`
  // does not parse, so every grid carrying a real `segment_id` failed at
  // ClickHouse. It went unnoticed because the only test naming a segment
  // named one that does not exist, which leaves `segmentPersonSql`
  // undefined and this string empty.
  const segmentFilter = segmentPersonSql
    ? ` AND ${RESOLVED_PERSON_ALIAS} IN (${segmentPersonSql})`
    : ''

  const sql = `
WITH scan AS (
  SELECT
    ${resolved} AS ${RESOLVED_PERSON_ALIAS},
    e.event_name AS event_name,
    e.timestamp  AS timestamp
  FROM (
    SELECT project_id, anonymous_id, user_id, timestamp, event_name, event_id
    FROM events
    WHERE project_id = ${projectParam}
      AND timestamp >= ${sinceParam}
      AND timestamp < ${scanEnd}${nameFilter}
    LIMIT 1 BY project_id, event_id
  ) AS e
  WHERE ${notSuppressed}
),
cohorts AS (
  SELECT
    ${RESOLVED_PERSON_ALIAS},
    ${bucket.of('min(timestamp)')} AS cohort
  FROM scan
  WHERE ${startCond} AND timestamp < ${untilParam}${segmentFilter}
  GROUP BY ${RESOLVED_PERSON_ALIAS}
),
activity AS (
  SELECT
    ${RESOLVED_PERSON_ALIAS},
    groupUniqArray(${bucket.of('timestamp')}) AS buckets
  FROM scan
  WHERE ${returnCond}
  GROUP BY ${RESOLVED_PERSON_ALIAS}
),
per_person AS (
  SELECT
    c.cohort AS cohort,
    arrayMap(
      k -> toUInt8(has(
        arrayMap(b -> dateDiff('${bucket.unit}', c.cohort, b), a.buckets),
        k
      )),
      range(0, ${periodsParam} + 1)
    ) AS hit
  FROM cohorts AS c
  LEFT JOIN activity AS a USING (${RESOLVED_PERSON_ALIAS})
)
SELECT
  toString(cohort)   AS cohort,
  toUInt32(count())  AS cohort_size,
  arrayMap(v -> toUInt32(v), sumForEach(hit)) AS retained
FROM per_person
GROUP BY cohort
ORDER BY cohort
`

  return { sql, params: params.values }
}

/**
 * Which cells of one cohort's row could have been measured at all.
 *
 * A cell is measurable only once its period has FINISHED: period `k` of a
 * cohort starting at `C` closes at `C + (k+1)` periods, and until then a
 * count of zero means "not yet" rather than "nobody came back".
 *
 * **This is the whole honesty of the report.** A retention grid whose
 * bottom-right corner reads 0% because those weeks have not happened yet is
 * the standard way this chart lies, and it lies exactly where a reader looks
 * for a trend. The counts are real; what this decides is which of them are
 * allowed to be shown as an answer.
 *
 * Calendar arithmetic, not `k * periodMs`: months are not a fixed length and
 * neither, across a DST boundary, is a local day -- but every bucket here is
 * UTC, so the day and week cases are exact and only `month` needs the
 * calendar. Done through `Date.UTC` so all three take the same path rather
 * than two of them taking a faster one that is right for a different reason.
 */
export function measurableCells(opts: {
  cohortStart: Date
  granularity: Granularity
  periods: number
  now: Date
}): boolean[] {
  const { cohortStart, granularity, periods, now } = opts
  const out: boolean[] = []
  for (let k = 0; k <= periods; k++) {
    out.push(periodEnd(cohortStart, granularity, k + 1).getTime() <= now.getTime())
  }
  return out
}

/** The instant `n` whole periods after a cohort's start, in UTC. */
function periodEnd(start: Date, granularity: Granularity, n: number): Date {
  const y = start.getUTCFullYear()
  const m = start.getUTCMonth()
  const d = start.getUTCDate()
  if (granularity === 'month') return new Date(Date.UTC(y, m + n, d))
  const days = granularity === 'week' ? 7 * n : n
  return new Date(Date.UTC(y, m, d + days))
}
