import type { CompiledQuery } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'

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

export async function runSegment(opts: {
  client: ClickHouseClient
  compiled: CompiledQuery
}): Promise<number> {
  const { client, compiled } = opts
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
    const rows = await r.json<{ person_count: string }>()
    return Number(rows[0]?.person_count ?? 0)
  } catch (err) {
    // ClickHouse reports both ceilings as codes 159 (TIMEOUT_EXCEEDED) and
    // 241 (MEMORY_LIMIT_EXCEEDED). Both mean the same thing to a caller:
    // this segment is too expensive as written.
    const message = err instanceof Error ? err.message : String(err)
    if (/Code: (159|241)/.test(message)) throw new SegmentTimeoutError()
    throw err
  }
}
