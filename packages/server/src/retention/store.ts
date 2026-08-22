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
  /**
   * Called synchronously from inside `dropOnePartition`, immediately after
   * each REAL `ALTER TABLE ... DROP PARTITION` command returns -- one call
   * per partition actually dropped, not one call per project and not one
   * call per `dropExpired`. Never called for a dry run's Guard-4
   * short-circuit (`dropped: false`) -- there is no ALTER to be
   * "immediately after", and Guard 5 is about recording real, irreversible
   * work.
   *
   * This is where Guard 5's log line belongs, and specifically NOT as a
   * wrapper around `dropExpired`'s returned array: `dropExpired` loops over
   * every expired partition in BOTH `RETENTION_TABLES` for one project
   * before it ever returns, so a caller that only inspects the returned
   * array after `dropExpired` resolves is logging once per PROJECT, with
   * every partition that project dropped bunched into that one moment. A
   * process interrupted between two of those real, already-executed drops
   * -- a SIGTERM mid-project, the crash scenario Guard 5 exists for --
   * would then lose every log line for that project's drops with nothing
   * to show for it, however many there were. Calling `onDrop` here instead
   * writes each line the instant its partition is actually gone, so the
   * unrecorded window shrinks to the smallest one this store can offer
   * without a cross-statement transaction: one partition, not one project's
   * worth. See `shutdown.ts`'s own comment on `retention.stop()` for the
   * bound this produces together with `RetentionWorker`'s between-project
   * stop check.
   *
   * A THROW FROM HERE IS NOT SWALLOWED, which is deliberately the opposite
   * of how `RetentionWorker` treats its own `onError`/`onRun` handlers
   * (`#invokeHandler` absorbs both a synchronous throw and an async
   * rejection). This handler runs INSIDE the irreversible loop, so its throw
   * propagates out of `dropOnePartition` and out of `dropExpired`: every
   * partition after this one -- including every table after this one -- is
   * never reached, while the partition just dropped stays dropped. That
   * asymmetry is the point. The worker's handlers are notifications about
   * work that has already finished, so silencing them costs nothing; this
   * one is the only record each drop leaves, so a handler that cannot write
   * is a reason to stop dropping, not a reason to keep dropping unrecorded.
   * Proven in store.test.ts against a live database rather than asserted
   * here. Note the blast radius: a handler that throws on EVERY call halts
   * that project's sweep after its first partition, on every run.
   *
   * Optional so every existing construction site and test that does not
   * care about logging keeps compiling unchanged.
   */
  onDrop?: (result: DropResult) => void
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
 * `dropExpired` refuses any `now` further than this from the real process
 * clock. See that method's docstring for why: a skewed `now` moves the
 * boundary with it, so no comparison against the boundary itself can ever
 * detect it.
 */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000

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
  readonly #onDrop: (result: DropResult) => void

  constructor(opts: RetentionStoreOptions) {
    this.#pg = opts.pg
    this.#ch = opts.ch
    this.#dryRun = opts.dryRun
    this.#onDrop = opts.onDrop ?? (() => {})
  }

  /**
   * Every project and the retention it is currently configured with —
   * INCLUDING one that is being deleted.
   *
   * Excluding `deleting_at IS NOT NULL` was tried and reverted. The saving
   * was redundant work (dropping an already-dropped partition is a no-op),
   * and the cost was the one thing this method must never do: hide data from
   * the sweep. A project purge can end permanently `failed` — attempts
   * exhausted, `deleting_at` stamped and never cleared — with whatever
   * survived the partial teardown still in ClickHouse. Excluded from here,
   * that data is never swept and never reported again, which is precisely
   * the orphaned-project state (#39) the delete feature exists to make
   * unreachable, reached down the failure path instead.
   *
   * The overlap it avoided is harmless in a way the omission is not: every
   * step of both workers is predicated on the project, and both are
   * idempotent.
   */
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

    // Compound partition key needs the tuple form. Confirmed against a live
    // server (24.8): a bare `ALTER TABLE t DROP PARTITION 202401` against a
    // `(project_id, month)` key ALWAYS errors -- `Code: 248 ... Wrong number
    // of fields in the partition expression: 1, must be: 2` -- it never
    // silently matches nothing, so wrong arity is the loud failure of the
    // two. The SILENT one is right arity with a wrong value:
    // `tuple(41, 202401)` where the project is 42 returns success and drops
    // nothing at all. That is why `p` and `m` go through `query_params`
    // rather than string interpolation -- typed, and never raw SQL text a
    // garbage-parsed value could reshape.
    await this.#ch.command({
      query: `ALTER TABLE ${table} DROP PARTITION tuple({p:UInt32}, {m:UInt32})`,
      query_params: { p: projectId, m: partition },
    })
    const result: DropResult = { projectId, table, partition, dropped: true }
    // `onDrop`'s own contract (RetentionStoreOptions): called for a REAL
    // drop only, the instant one just happened -- not for the dry-run
    // branch above, which issued no ALTER to be "immediately after".
    this.#onDrop(result)
    return result
  }

  /**
   * Drops every partition of `target.projectId`, across `RETENTION_TABLES`,
   * strictly older than `retentionBoundary(now, target.retentionMonths)`.
   *
   * Guard 1: `now` is a parameter, read once by the caller, never
   * `new Date()` here to COMPUTE THE BOUNDARY -- a boundary recomputed per
   * partition or per table could move mid-run. The clock-skew check below
   * does read the real process clock, once, but only to sanity-check the
   * `now` argument itself before it is ever used; it is not a second input
   * to the boundary calculation, and does not run again once the per-table
   * loop starts. Guard 1 forbids recomputing the boundary mid-run, not
   * sanity-checking an input once at the top.
   *
   * NOT all-or-nothing across `RETENTION_TABLES`. The checks below run
   * once, before any table is touched, so a *rejected* run never drops
   * anything. But once the per-table loop starts issuing real
   * `ALTER TABLE ... DROP PARTITION` calls, there is no transaction across
   * them: a later table's own failure (a ClickHouse error, a network drop)
   * leaves whatever an earlier table already, irreversibly, dropped. A
   * caller that sees this reject must not assume zero partitions were
   * removed -- inspect how far the per-table loop got, or re-derive it from
   * `listPartitions`, before deciding a retry is safe. `store.test.ts`
   * proves this directly, by injecting a failure into the second table of a
   * live run and confirming the first table's drop survives the throw.
   */
  async dropExpired(target: RetentionTarget, now: Date): Promise<DropResult[]> {
    // Before anything else: `now` must be within a day of the real process
    // clock. This is the guard that closes the hole a skewed `now` opens --
    // and it is a REAL hole, not a hypothetical one, because `now` is an
    // injected seam on the scheduler's own options object (see Task 3's
    // brief), not something only a broken machine clock could get wrong.
    //
    // Neither of this store's other checks can catch a skewed `now`: the
    // boundary is *computed from* `now` (`now` minus `retentionMonths`
    // months), so a wrong `now` produces a boundary that is wrong by
    // exactly the same amount, in the same direction -- any comparison
    // between the boundary and `now` itself still holds no matter how far
    // off `now` is. A `now` of 2099, with a perfectly ordinary
    // `retentionMonths: 13`, silently expires every partition a project
    // has, including the current month -- confirmed live before this guard
    // existed: every row gone, no throw. Sanity-checking `now` against the
    // one clock this process actually trusts is the only place that can
    // catch it.
    //
    // The validity half is not decoration. `now.getTime()` is `NaN` for an
    // `Invalid Date` (a bad `new Date(process.env.RETENTION_NOW)` or a
    // failed CLI `--now` parse -- `now` is the injected seam, so this is
    // directly reachable), and `NaN > MAX_CLOCK_SKEW_MS` is `false`: a bare
    // skew comparison would let it walk straight through, produce an
    // `Invalid Date` boundary, and make `expiredPartitions` return `[]`
    // unconditionally -- a clean, silent, zero-drop "success" a scheduler
    // cannot tell from a healthy run. Same trap the `retentionMonths` check
    // below defends against with `Number.isInteger`; this must not
    // reintroduce it for `now`.
    if (Number.isNaN(now.getTime())) {
      throw new Error(
        `refusing to evaluate retention for project ${target.projectId}: now (${String(now)}) is an invalid Date`,
      )
    }

    const skewMs = Math.abs(Date.now() - now.getTime())
    if (skewMs > MAX_CLOCK_SKEW_MS) {
      throw new Error(
        `refusing to evaluate retention for project ${target.projectId}: now (${now.toISOString()}) is too far from the process clock (${new Date().toISOString()}) to trust with an irreversible drop -- skew ${skewMs}ms exceeds the ${MAX_CLOCK_SKEW_MS}ms this store allows`,
      )
    }

    // `retentionMonths` did not necessarily come through the Postgres
    // column's `CHECK (retention_months BETWEEN 1 AND 120)` -- this method
    // takes an arbitrary `RetentionTarget`, and boundary.ts says explicitly
    // that a caller not coming through that column must validate before
    // calling `retentionBoundary`. This is that validation. Without it, a
    // `retentionMonths` of `0` does not "do nothing": `retentionBoundary`
    // lands exactly on the current month, so any genuinely old partition
    // still compares as expired and is dropped for real -- confirmed live.
    // `NaN`, separately, produces a boundary of `Invalid Date`, which makes
    // `expiredPartitions` return `[]` unconditionally -- a clean, silent,
    // zero-drop "success" indistinguishable in a log from a healthy run
    // with nothing left to expire.
    //
    // This is also, now, the ONLY guard against a negative `retentionMonths`
    // -- see this file's history for why an earlier "boundary can never be
    // in the future" assertion was removed rather than kept alongside it.
    // For any `retentionMonths` this check accepts (an integer in
    // `[1, 120]`), `retentionBoundary` subtracts at least one whole month
    // from `now`, so the resulting boundary can never be later than `now`
    // -- the property that assertion checked is now true BY CONSTRUCTION,
    // not by a second runtime comparison. Proven exhaustively (all 120
    // valid months, several `now` values): zero violations. Keeping that
    // assertion once this check and the clock-skew check above both exist
    // would not add protection -- every input it could ever catch is
    // already an out-of-range `retentionMonths`, caught here first, with a
    // message about the real problem. A check that can never independently
    // fire is not defence-in-depth; it is a second, misleading name for
    // this one.
    if (
      !Number.isInteger(target.retentionMonths) ||
      target.retentionMonths < 1 ||
      target.retentionMonths > 120
    ) {
      throw new Error(
        `refusing to evaluate retention for project ${target.projectId}: retentionMonths ${target.retentionMonths} is not an integer in [1, 120]`,
      )
    }

    const boundary = retentionBoundary(now, target.retentionMonths)
    const boundaryMonth = toYYYYMM(boundary)
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
