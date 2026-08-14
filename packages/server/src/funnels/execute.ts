import type { CompiledQuery, FunnelResult, FunnelStep, LevelRow } from '@lyraflow/core'
import { summarise } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import { runCompiled } from '../segments/execute.js'

/**
 * ClickHouse returns every numeric as a string over JSONEachRow, so the
 * histogram arrives as text and is widened here rather than in `summarise`,
 * which stays a pure function over numbers and needs no database to test.
 */
interface HistogramRow {
  level: string
  people: string
  partial: string
}

/**
 * Runs a compiled funnel and turns its histogram into per-step counts.
 *
 * The ClickHouse ceilings and the timeout mapping come from
 * `runCompiled` — the same wrapper the segment engine uses. A funnel is
 * reachable by the same authenticated caller and scans the same table, so a
 * second timeout policy here would be one more thing to keep in agreement.
 */
export async function runFunnel(opts: {
  client: ClickHouseClient
  compiled: CompiledQuery
  steps: FunnelStep[]
}): Promise<FunnelResult> {
  const rows = await runCompiled<HistogramRow>(opts.client, opts.compiled)
  const levels: LevelRow[] = rows.map((r) => ({
    level: Number(r.level),
    people: Number(r.people),
    partial: Number(r.partial),
  }))
  return summarise(levels, opts.steps)
}
