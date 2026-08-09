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
 * a partition to silently skip: `listPartitions` is a public method other
 * tasks call directly, and silently under-reporting a project's true
 * partition set is a wrong answer regardless of who consumes it -- it is not
 * merely "one input among several" the way it would be if some downstream
 * guard could be trusted to catch the shortfall.
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
   * exist, which is what the drop itself needs to agree with.
   *
   * Scoped to the current database explicitly: `system.parts` is
   * server-wide, not scoped to the client's own database, and this table
   * name is shared across every database on the server -- including a
   * second database on the same server that happens to define its own
   * same-named table with the same partition shape, which would otherwise
   * inflate this project's partition list with a foreign database's rows.
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
   * NOT all-or-nothing across `RETENTION_TABLES`. The two checks below run
   * once, before any table is touched, so a *rejected* run never drops
   * anything. But once the per-table loop starts issuing real
   * `ALTER TABLE ... DROP PARTITION` calls, there is no transaction across
   * them: a later table's own failure (a ClickHouse error, a network drop)
   * leaves whatever an earlier table already, irreversibly, dropped. A
   * caller that sees this reject must not assume zero partitions were
   * removed -- inspect how far the per-table loop got, or re-derive it from
   * `listPartitions`, before deciding a retry is safe.
   */
  async dropExpired(target: RetentionTarget, now: Date): Promise<DropResult[]> {
    const boundary = retentionBoundary(now, target.retentionMonths)
    const boundaryMonth = toYYYYMM(boundary)
    const nowMonth = toYYYYMM(now)

    // The boundary can never be in the future. This is the guard that
    // replaced an earlier "never drop every partition a project has" rule --
    // see boundary.ts and this project's own history for why that rule was
    // wrong in both directions: it refused a dormant project's *legitimate*
    // full expiry forever, while failing to catch two of the three causes it
    // named (months=0 lands on the current month, not expired; NaN expires
    // nothing -- see the check below for that one). A negative
    // `retentionMonths` is the one input that actually produces "everything
    // expired," and it does so by pushing the boundary into the future,
    // which is exactly what this checks.
    if (boundaryMonth > nowMonth) {
      throw new Error(
        `refusing to evaluate retention for project ${target.projectId}: boundary month ${boundaryMonth} is in the future relative to now (${nowMonth})`,
      )
    }

    // `retentionMonths` did not necessarily come through the Postgres
    // column's `CHECK (retention_months BETWEEN 1 AND 120)` -- this method
    // takes an arbitrary `RetentionTarget`, and boundary.ts says explicitly
    // that a caller not coming through that column must validate before
    // calling `retentionBoundary`. This is that validation. It must run
    // AFTER the future-boundary check above, not before: a negative value
    // needs to reach the future-boundary error (the message a caller should
    // see for that specific, real failure), and only a value that does NOT
    // produce a future boundary -- zero, NaN, or an out-of-range positive --
    // falls through to be caught here instead. NaN in particular clears the
    // check above silently (`NaN > nowMonth` is `false`, the same shape of
    // hazard `assertDroppable` guards against in boundary.ts) and, left
    // unchecked, makes `expiredPartitions` return an empty list every time
    // -- a clean, silent, zero-drop "success" indistinguishable in a log
    // from a project with nothing left to expire.
    if (
      !Number.isInteger(target.retentionMonths) ||
      target.retentionMonths < 1 ||
      target.retentionMonths > 120
    ) {
      throw new Error(
        `refusing to evaluate retention for project ${target.projectId}: retentionMonths ${target.retentionMonths} is not an integer in [1, 120]`,
      )
    }

    const results: DropResult[] = []

    for (const table of RETENTION_TABLES) {
      const expired = expiredPartitions(
        await this.listPartitions(target.projectId, table),
        boundary,
      )

      for (const partition of expired) {
        // Guard 5: the returned result names every dropped (or, in dry-run,
        // would-be-dropped) partition -- once a partition is truly gone,
        // this return value is the only record it ever existed. A run that
        // legitimately drops every partition a dormant project has (see
        // above) still names every one of them here; it is worth logging
        // that a project's disk footprint just went to zero, never worth
        // refusing to do it.
        results.push(await this.dropOnePartition(target.projectId, table, partition, boundaryMonth))
      }
    }

    return results
  }
}
