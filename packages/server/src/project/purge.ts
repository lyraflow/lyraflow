import type { ClickHouseClient, Pool } from '@lyraflow/db'

/**
 * The five ClickHouse tables a project's data lives in, in teardown order.
 * Partition drops first, mutations second, purely so the cheap irreversible
 * work happens before the expensive irreversible work — unlike
 * `purgePerson`, whose step order IS load-bearing because its event
 * predicate is derived from identity bindings. Here every predicate is
 * `project_id` and none depends on another table surviving.
 */
export const PURGE_TABLES = [
  'events',
  'device_index',
  'person_traits',
  'event_schema',
  'events_dead_letter',
] as const

/** The tables whose partition key STARTS with project_id, and whether that
 * key is compound. `person_traits` is `PARTITION BY project_id` alone, so its
 * DROP takes a bare value; the other two are `(project_id, toYYYYMM(...))`
 * and need the tuple form. Getting this backwards is loud, not silent:
 * ClickHouse answers `Code: 248 ... Wrong number of fields in the partition
 * expression`. */
const PARTITIONED: ReadonlyArray<{ table: string; compound: boolean }> = [
  { table: 'events', compound: true },
  { table: 'device_index', compound: true },
  { table: 'person_traits', compound: false },
]

/** The tables that cannot be dropped by partition: `event_schema` has no
 * partitioning at all, and `events_dead_letter` is partitioned by
 * `received_at`, which says nothing about which project a row belongs to. */
const MUTATED = ['event_schema', 'events_dead_letter'] as const

export interface PurgeProgress {
  table: string
  partitions?: number
  mutated?: boolean
}

const TUPLE_PARTITION = /^\((\d+),\s*(\d+)\)$/
const BARE_PARTITION = /^(\d+)$/

/**
 * The partitions `table` currently holds for `projectId`, read from
 * `system.parts` — ClickHouse's own ground truth for what physically exists,
 * which is what the drop has to agree with. Scoped to `currentDatabase()`
 * because `system.parts` is server-wide.
 */
async function listPartitions(
  ch: ClickHouseClient,
  table: string,
  projectId: number,
  compound: boolean,
): Promise<string[]> {
  const rs = await ch.query({
    query: `SELECT DISTINCT partition FROM system.parts
             WHERE database = currentDatabase() AND table = {table:String} AND active`,
    query_params: { table },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ partition: string }>()
  const mine: string[] = []
  for (const row of rows) {
    const match = compound
      ? TUPLE_PARTITION.exec(row.partition)
      : BARE_PARTITION.exec(row.partition)
    if (!match) {
      throw new Error(
        `unexpected partition format for table ${table}: ${JSON.stringify(row.partition)}`,
      )
    }
    if (Number(match[1]) === projectId)
      mine.push(compound ? (match[2] as string) : (match[1] as string))
  }
  return mine
}

async function countRows(ch: ClickHouseClient, table: string, projectId: number): Promise<number> {
  const rs = await ch.query({
    query: `SELECT count() AS n FROM ${table} WHERE project_id = {p:UInt32}`,
    query_params: { p: projectId },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ n: string }>()
  return Number(rows[0]?.n ?? 0)
}

/**
 * The ordered destruction of one project, across both stores.
 *
 * POSTGRES GOES LAST, AND ONLY AFTER A VERIFIED-ZERO READ. That is the
 * inverse of #39: `RetentionStore.listProjects()` derives its targets from
 * the Postgres `projects` table, so for as long as ClickHouse holds this
 * project's data, the row that makes it findable and sweepable must still be
 * there. Delete the row first and those partitions are never swept and never
 * reported again — the exact state this feature exists to make unreachable.
 *
 * THE VERIFY STEP IS NOT A BELT-AND-BRACES COUNT. `IngestBuffer` holds
 * accepted rows for up to `flushIntervalMs`, so an event accepted seconds
 * before the request can land in `events` AFTER its partition was dropped,
 * and `device_index_mv` / `event_schema_str_mv` / `event_schema_num_mv` then
 * repopulate from it. A non-zero count returns `deleted: false` with the
 * Postgres row intact, which leaves the request claimable and the next pass
 * redoes the teardown. Ingest is already refused by then, so the reappearing
 * set is bounded and the second pass converges.
 *
 * Idempotent by construction: every step is predicated on `project_id`,
 * dropping an already-dropped partition is a no-op, and a crash mid-purge is
 * simply re-claimed after the lease expires and restarted from the top.
 */
export async function purgeProject(opts: {
  ch: ClickHouseClient
  pg: Pool
  projectId: number
  onProgress?: (p: PurgeProgress) => void | Promise<void>
}): Promise<{ deleted: boolean; remaining: Record<string, number> }> {
  const { ch, pg, projectId, onProgress } = opts

  for (const { table, compound } of PARTITIONED) {
    const partitions = await listPartitions(ch, table, projectId, compound)
    for (const partition of partitions) {
      // Typed parameters, never interpolated SQL text. Right arity with a
      // wrong value is the SILENT failure here — `tuple(41, 202401)` where
      // the project is 42 succeeds and drops nothing.
      await ch.command(
        compound
          ? {
              query: `ALTER TABLE ${table} DROP PARTITION tuple({p:UInt32}, {m:UInt32})`,
              query_params: { p: projectId, m: Number(partition) },
            }
          : {
              query: `ALTER TABLE ${table} DROP PARTITION {p:UInt32}`,
              query_params: { p: projectId },
            },
      )
    }
    await onProgress?.({ table, partitions: partitions.length })
  }

  for (const table of MUTATED) {
    // mutations_sync = 1 is what turns this from "I asked" into "it is
    // gone" — ALTER ... DELETE is asynchronous by default.
    await ch.command({
      query: `ALTER TABLE ${table} DELETE WHERE project_id = {p:UInt32}`,
      query_params: { p: projectId },
      clickhouse_settings: { mutations_sync: '1' },
    })
    await onProgress?.({ table, mutated: true })
  }

  const remaining: Record<string, number> = {}
  for (const table of PURGE_TABLES) {
    const n = await countRows(ch, table, projectId)
    if (n > 0) remaining[table] = n
  }
  if (Object.keys(remaining).length > 0) return { deleted: false, remaining }

  // Only now. Cascades every project-scoped Postgres table.
  await pg.query('DELETE FROM projects WHERE id = $1', [projectId])
  return { deleted: true, remaining: {} }
}
