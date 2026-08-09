/**
 * The store that issues the one irreversible act in this feature:
 * `ALTER TABLE ... DROP PARTITION`. Everything that can be gotten wrong
 * safely lives in `boundary.ts`; this file's job is to never call the drop
 * without going through that module's guard first, and to never compute the
 * "is this partition safe to drop" answer itself.
 *
 * See `boundary.ts` for why `assertDroppable` is called here rather than
 * reimplemented -- there is exactly one place that decides whether a
 * partition may be dropped, and this store calls it, twice over (once
 * indirectly through `expiredPartitions` to build the candidate list, once
 * directly, immediately before each `ALTER TABLE`, so a future change to how
 * that list is built can never make the drop itself more permissive).
 */

import type { ClickHouseClient, Pool } from '@lyraflow/db'
import { assertDroppable, expiredPartitions, retentionBoundary, toYYYYMM } from './boundary.js'

export interface RetentionTarget {
  projectId: number
  retentionMonths: number
}

export interface DropResult {
  projectId: number
  table: string
  partition: number
  dropped: boolean
}

export interface RetentionStoreOptions {
  pg: Pool
  ch: ClickHouseClient
  dryRun: boolean
}

/**
 * Both tables are partitioned `(project_id, month)` and both hold
 * behavioural data derived from `events`.
 *
 * `person_traits` is deliberately absent: it is `PARTITION BY project_id`
 * with no time dimension -- events age out, identity survives, by design for
 * this plan.
 *
 * `event_schema` is deliberately absent too: it is unpartitioned (see
 * `002_events.sql`), so pruning it would need a mutation, not a partition
 * drop, and is out of scope here.
 */
export const RETENTION_TABLES: readonly string[] = ['events', 'device_index']

/**
 * `system.parts.partition` renders a compound partition key as its tuple's
 * text form, e.g. `(42,202401)` for `(project_id, toYYYYMM(...))` -- no
 * spaces, decimal integers only (confirmed against a live server; both
 * columns behind this key are unsigned integer types, so no sign to worry
 * about). Anything that does not match this shape is a parse gone wrong, not
 * a partition to silently skip -- skipping it would let `listPartitions`
 * under-report a project's true partition set, which is exactly the input
 * the "never drop everything" guard depends on being complete.
 */
const PARTITION_PATTERN = /^\((\d+),(\d+)\)$/

export class RetentionStore {
  readonly #pg: Pool
  readonly #ch: ClickHouseClient
  readonly #dryRun: boolean

  constructor(opts: RetentionStoreOptions) {
    this.#pg = opts.pg
    this.#ch = opts.ch
    this.#dryRun = opts.dryRun
  }

  /** Every project and the retention it is currently configured with. */
  async listProjects(): Promise<RetentionTarget[]> {
    const result = await this.#pg.query<{ id: string; retention_months: number }>(
      'SELECT id, retention_months FROM projects ORDER BY id',
    )
    return result.rows.map((row) => ({
      projectId: Number(row.id),
      retentionMonths: row.retention_months,
    }))
  }

  /**
   * Every `YYYYMM` partition month `table` currently holds for `projectId`,
   * read from `system.parts` rather than tracked separately -- the parts
   * table is ClickHouse's own ground truth for what partitions physically
   * exist, which is what both the drop and the "never drop everything" guard
   * need to agree with.
   *
   * Scoped to the current database explicitly: `system.parts` is
   * server-wide, not scoped to the client's own database, and this table
   * name is shared across every database on the server.
   */
  async listPartitions(projectId: number, table: string): Promise<number[]> {
    const rs = await this.#ch.query({
      query: `SELECT DISTINCT partition FROM system.parts
              WHERE database = currentDatabase() AND table = {table:String} AND active`,
      query_params: { table },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ partition: string }>()
    const months: number[] = []
    for (const row of rows) {
      const match = PARTITION_PATTERN.exec(row.partition)
      if (!match) {
        throw new Error(
          `unexpected partition format for table ${table}: ${JSON.stringify(row.partition)}`,
        )
      }
      const [, projectIdText, monthText] = match
      if (Number(projectIdText) === projectId) {
        months.push(Number(monthText))
      }
    }
    return months.sort((a, b) => a - b)
  }

  /**
   * The guarded drop of exactly one partition. `protected`, not private, on
   * purpose: it is the one place `dropExpired` issues the irreversible
   * `ALTER TABLE`, and tests exercise Guard 2 (assert at the moment of the
   * drop) by calling it directly through a subclass, forcing a partition
   * that never made it through `expiredPartitions`' own filtering -- proving
   * the assertion here fires on its own, not merely that the upstream filter
   * happened to be correct.
   */
  protected async dropOnePartition(
    projectId: number,
    table: string,
    partition: number,
    boundaryMonth: number,
  ): Promise<DropResult> {
    // Guard 2. Re-checked here, in the same breath as the ALTER below, even
    // though `expiredPartitions` already filtered the candidate list --
    // deliberately redundant, so a future change to how that list is built
    // can never make this call itself more permissive.
    assertDroppable(partition, boundaryMonth, projectId)

    if (this.#dryRun) {
      // Guard 4: dry run drops nothing.
      return { projectId, table, partition, dropped: false }
    }

    // Compound partition key needs the tuple form -- confirmed against a
    // live server: `ALTER TABLE t DROP PARTITION 202401` (bare) either
    // errors or, worse, matches nothing silently for a `(project_id, month)`
    // key. `query_params` (not string interpolation) keeps both values typed
    // and keeps a garbage-parsed value from ever becoming raw SQL text.
    await this.#ch.command({
      query: `ALTER TABLE ${table} DROP PARTITION tuple({p:UInt32}, {m:UInt32})`,
      query_params: { p: projectId, m: partition },
    })
    return { projectId, table, partition, dropped: true }
  }

  /**
   * Drops every partition of `target.projectId`, across `RETENTION_TABLES`,
   * strictly older than `retentionBoundary(now, target.retentionMonths)`.
   *
   * Guard 1: `now` is a parameter, read once by the caller, never
   * `new Date()` here -- a boundary recomputed per partition or per table
   * could move mid-run.
   *
   * Guard 3, per table, before any drop for that table runs: if the expired
   * set equals the table's entire current partition list for this project,
   * AND that list is non-empty, this throws instead of proceeding. That
   * shape -- everything expired, including whatever the current month would
   * be -- is what a boundary derived from a zero, a NaN, or an epoch date
   * produces, and it is never a legitimate retention outcome (a real
   * boundary always keeps at least the current month, so at least one
   * partition should survive for any project old enough to have one at
   * all). This is the only guard that catches that failure mode:
   * `assertDroppable` checks one partition against the boundary in
   * isolation and cannot tell a well-formed-but-wrong boundary from a
   * correct one (see `retentionBoundary`'s docstring in `boundary.ts`).
   * Throwing here means a table that has already thrown leaves every later
   * table in `RETENTION_TABLES` untouched too -- an all-or-nothing run,
   * not a partial one.
   */
  async dropExpired(target: RetentionTarget, now: Date): Promise<DropResult[]> {
    const boundary = retentionBoundary(now, target.retentionMonths)
    const boundaryMonth = toYYYYMM(boundary)
    const results: DropResult[] = []

    for (const table of RETENTION_TABLES) {
      const allPartitions = await this.listPartitions(target.projectId, table)
      const expired = expiredPartitions(allPartitions, boundary)

      if (expired.length > 0 && expired.length === allPartitions.length) {
        throw new Error(
          `refusing to drop every partition project ${target.projectId} has in ${table}: all ${allPartitions.length} partition(s) compare as older than retention boundary month ${boundaryMonth} -- this is the symptom of a boundary computed from a zero, a NaN or an epoch date, and never a legitimate retention outcome`,
        )
      }

      for (const partition of expired) {
        // Guard 5: the returned result names every dropped (or, in dry-run,
        // would-be-dropped) partition -- once a partition is truly gone,
        // this return value is the only record it ever existed.
        results.push(await this.dropOnePartition(target.projectId, table, partition, boundaryMonth))
      }
    }

    return results
  }
}
