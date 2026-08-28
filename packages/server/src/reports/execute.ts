import { type Granularity, type RetentionQuery, measurableCells } from '@lyraflow/core'
import type { CompiledRetention } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import { runCompiled } from '../segments/execute.js'

/**
 * One cohort's row. `retained[k]` is how many of `size` did the return event
 * in period `k` — or `null` when that period had not finished at the instant
 * the report ran.
 *
 * `null` and `0` are different answers and the type says so. A grid that
 * returned `0` for a period that has not happened yet would be read as a
 * cliff, which is the standard way this chart lies.
 */
export interface CohortRow {
  cohort: string
  size: number
  retained: (number | null)[]
}

export interface RetentionResult {
  granularity: Granularity
  periods: number
  cohorts: CohortRow[]
}

/**
 * The grid as ClickHouse returns it. Numerics arrive as strings over
 * JSONEachRow, so every field is widened here.
 *
 * Named columns with no index signature, for the reason `HistogramRow` in
 * `funnels/execute.ts` gives: a renamed alias in `compileRetention` is then a
 * compile error rather than a silent `Number(undefined)` at runtime.
 */
interface GridRow {
  cohort: string
  cohort_size: string
  retained: string[]
}

export async function runRetention(opts: {
  client: ClickHouseClient
  compiled: CompiledRetention
  query: RetentionQuery
  now: Date
}): Promise<RetentionResult> {
  const { client, compiled, query, now } = opts
  const rows = await runCompiled<GridRow>(client, compiled)

  const cohorts = rows.map((r) => {
    // `${r.cohort}T00:00:00Z` — the SQL buckets to a Date and stringifies it
    // as `YYYY-MM-DD`, which `new Date` would otherwise read as UTC midnight
    // by luck rather than by rule. Every bucket in this report is UTC; saying
    // so here keeps the measurability arithmetic in the same zone the SQL
    // used, rather than in the server's.
    const cohortStart = new Date(`${r.cohort}T00:00:00.000Z`)
    const measurable = measurableCells({
      cohortStart,
      granularity: query.granularity,
      periods: query.periods,
      now,
    })
    // THROWN, not defaulted. This started as `Number(r.retained[k] ?? 0)`,
    // which reads as defensive and is the opposite: a short array then
    // becomes a column of zeroes, and zero is a real answer in this grid --
    // "nobody came back" -- so a structural mismatch would be rendered as a
    // finding. A mutation that compiled `range(0, periods)` instead of
    // `range(0, periods + 1)` was invisible against the `?? 0`, and is
    // caught here.
    if (r.retained.length !== query.periods + 1) {
      throw new Error(
        `retention row for cohort ${r.cohort} has ${r.retained.length} cells, expected ${query.periods + 1}`,
      )
    }
    return {
      cohort: r.cohort,
      size: Number(r.cohort_size),
      retained: Array.from({ length: query.periods + 1 }, (_, k) =>
        measurable[k] ? Number(r.retained[k]) : null,
      ),
    }
  })

  return { granularity: query.granularity, periods: query.periods, cohorts }
}
