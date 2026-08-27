import type { CompiledQuery } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { MemberRow } from './cache.js'

/**
 * Ceilings, not suggestions. A segment query is reachable by an authenticated
 * caller, and an unbounded one is how a single request takes the whole
 * instance down for every other tenant. ClickHouse enforces both server-side,
 * so a client that gives up early does not leave the query running.
 */
export const SEGMENT_MAX_EXECUTION_SECONDS = 30
export const SEGMENT_MAX_MEMORY_BYTES = 4 * 1024 ** 3

export class SegmentTimeoutError extends Error {
  constructor() {
    super('segment query exceeded its time or memory ceiling')
    this.name = 'SegmentTimeoutError'
  }
}

/**
 * The one place a compiled query reaches ClickHouse. Every output mode goes
 * through it so the ceilings and the error mapping cannot diverge — a second
 * copy is how one mode ends up without a memory limit.
 *
 * Exported because the funnel engine runs through it too. A funnel is
 * reachable by the same authenticated caller and scans the same table, so it
 * needs the same ceilings; giving it its own would mean two timeout policies
 * kept in agreement by whoever remembers, and the one added next year is the
 * one that forgets. The name is deliberately not segment-specific.
 */
export async function runCompiled<T>(
  client: ClickHouseClient,
  // `sql` and `params` only, rather than a whole `CompiledQuery`. This runs
  // compiled retention grids too, and those carry no `warnings` -- widening
  // the parameter to what the function actually reads is honest, where giving
  // retention an empty `warnings` array to satisfy a type would be a field
  // invented for the compiler rather than for a caller.
  compiled: Pick<CompiledQuery, 'sql' | 'params'>,
): Promise<T[]> {
  try {
    const r = await client.query({
      query: compiled.sql,
      query_params: compiled.params,
      format: 'JSONEachRow',
      clickhouse_settings: {
        max_execution_time: SEGMENT_MAX_EXECUTION_SECONDS,
        max_memory_usage: String(SEGMENT_MAX_MEMORY_BYTES),
        // Without this, ClickHouse would rather return a partial result than
        // fail — a silently truncated population presented as a count is
        // worse than an error.
        timeout_overflow_mode: 'throw',
      },
    })
    return await r.json<T>()
  } catch (err) {
    // ClickHouse reports both ceilings as codes 159 (TIMEOUT_EXCEEDED) and
    // 241 (MEMORY_LIMIT_EXCEEDED). Both mean the same thing to a caller:
    // this segment is too expensive as written.
    const message = err instanceof Error ? err.message : String(err)
    if (/Code: (159|241)/.test(message)) throw new SegmentTimeoutError()
    throw err
  }
}

export async function runSegment(opts: {
  client: ClickHouseClient
  compiled: CompiledQuery
}): Promise<number> {
  const rows = await runCompiled<{ person_count: string }>(opts.client, opts.compiled)
  return Number(rows[0]?.person_count ?? 0)
}

export async function runSegmentMembers(opts: {
  client: ClickHouseClient
  compiled: CompiledQuery
}): Promise<MemberRow[]> {
  return runCompiled<MemberRow>(opts.client, opts.compiled)
}
