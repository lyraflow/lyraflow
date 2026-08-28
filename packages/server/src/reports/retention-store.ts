import { type Granularity, MAX_WHERE_PREDICATES, WherePredicate } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'
import { z } from 'zod'

/**
 * `StoredRetentionReport.stale` is `true` when the row's stored
 * `start_where`/`return_where` no longer parse under `StoredWhere` below,
 * `false` otherwise, and is ALWAYS present — never omitted for an ordinary
 * row. `segments/routes.ts`'s own `toWire` docstring gives the reason this
 * is a boolean on every row rather than an error thrown for a bad one: one
 * row a past build wrote, that a later grammar change can no longer parse,
 * must not take the whole list down with it. `list()` never throws for this
 * reason; `#hydrate` computes `stale` inline instead. See `StoredWhere`.
 */
export interface StoredRetentionReport {
  id: number
  name: string
  definition_version: number
  start_event: string
  return_event: string
  start_where: unknown[]
  return_where: unknown[]
  granularity: Granularity
  periods: number
  segment_id: number | null
  stale: boolean
  created_at: string
  updated_at: string
}

/**
 * What `create` requires and `update` accepts a subset of. Snake_case, same
 * choice `TrendInput` makes and for the same reason: this store's own
 * vocabulary is the table's, and `retention-routes.ts` parses the request
 * body straight into this shape.
 *
 * `start_where`/`return_where` are typed as validated `WherePredicate[]`,
 * not `unknown[]` — a caller constructing this input has already gone
 * through the segment grammar's own schema (`retention-routes.ts` does, via
 * `CreateBody`/`PatchBody`), so nothing is re-validated here on the way in.
 * `#hydrate` re-parses on the way OUT because a row written by THIS build
 * can still be read by a FUTURE one after the grammar has moved.
 */
export interface RetentionReportInput {
  name: string
  start_event: string
  return_event: string
  start_where: WherePredicate[]
  return_where: WherePredicate[]
  granularity: Granularity
  periods: number
  segment_id: number | null
}

export class DuplicateRetentionNameError extends Error {
  constructor() {
    super('a retention report with that name already exists in this project')
    this.name = 'DuplicateRetentionNameError'
  }
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'

/**
 * The shape version stamped on every row THIS build writes. `020_saved_reports.sql`'s
 * own comment explains why `retention_reports` carries `definition_version` and
 * `trend_reports` does not: a retention definition's `where` clauses are JSON
 * parsed against a grammar, and a future migration that needs to find every
 * row written under an earlier shape of THIS table (not the where-grammar,
 * which versions itself independently and is handled by `stale` instead)
 * filters on this column rather than parsing every row to find out.
 *
 * Not imported from `@lyraflow/core` the way `FUNNEL_DEFINITION_VERSION` is:
 * nothing about this table's own shape has needed a second value yet, so
 * there is nothing for core to own. When it does, whoever adds the second
 * value decides where it lives; this constant is just where the first one
 * is stamped from today.
 */
const RETENTION_DEFINITION_VERSION = 1

/**
 * The `where` predicates' own schema — the SAME one `reports/routes.ts`
 * validates a run request's `start_where`/`return_where` against
 * (`z.array(WherePredicate).max(MAX_WHERE_PREDICATES)`), not a second notion
 * of a valid predicate written here. A second one would drift from the first
 * the moment the grammar changes, which is exactly the failure mode `stale`
 * exists to make visible rather than silently wrong.
 */
const StoredWhere = z.array(WherePredicate).max(MAX_WHERE_PREDICATES)

interface Row {
  id: string
  name: string
  definition_version: number
  start_event: string
  return_event: string
  start_where: unknown
  return_where: unknown
  granularity: Granularity
  periods: number
  segment_id: string | null
  created_at: string
  updated_at: string
}

const COLUMNS =
  'id, name, definition_version, start_event, return_event, start_where, return_where, ' +
  'granularity, periods, segment_id, created_at, updated_at'

/**
 * CRUD over `retention_reports`.
 *
 * Every method takes `projectId` and every statement filters on it, same
 * discipline as `TrendStore`, `FunnelStore` and `SegmentStore` and for the
 * same reason: an id is a caller-supplied path segment, and a query that
 * looked it up alone would happily return another tenant's report. Scoping
 * in the WHERE clause also makes "not found" and "belongs to someone else"
 * indistinguishable to a caller, which is deliberate — a 403 would confirm
 * the id exists.
 *
 * `segment_id` carries no foreign key at the table level (`020_saved_reports.sql`'s
 * own comment gives the reason: CASCADE would destroy every report built on
 * a segment, and SET NULL would erase the evidence a restriction ever
 * existed), and this store does nothing to compensate — it reads and writes
 * the column as a bare integer, exactly as stored, whether or not a segment
 * with that id currently exists. The run path is what decides what a
 * missing segment means; this store's only job is to not lose the number.
 */
export class RetentionReportStore {
  constructor(private readonly pool: Pool) {}

  #hydrate(row: Row): StoredRetentionReport {
    // Never thrown — see the docstring on `StoredRetentionReport.stale`.
    // Both are parsed independently so a break in one clause does not mask
    // whatever the other clause's row still says.
    const startWhere = StoredWhere.safeParse(row.start_where)
    const returnWhere = StoredWhere.safeParse(row.return_where)
    return {
      id: Number(row.id),
      name: row.name,
      definition_version: row.definition_version,
      start_event: row.start_event,
      return_event: row.return_event,
      start_where: startWhere.success ? startWhere.data : (row.start_where as unknown[]),
      return_where: returnWhere.success ? returnWhere.data : (row.return_where as unknown[]),
      granularity: row.granularity,
      periods: row.periods,
      segment_id: row.segment_id === null ? null : Number(row.segment_id),
      stale: !startWhere.success || !returnWhere.success,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  async list(projectId: number): Promise<StoredRetentionReport[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM retention_reports WHERE project_id = $1 ORDER BY name ASC`,
      [projectId],
    )
    return r.rows.map((row) => this.#hydrate(row))
  }

  async get(projectId: number, id: number): Promise<StoredRetentionReport | null> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM retention_reports WHERE project_id = $1 AND id = $2`,
      [projectId, id],
    )
    const row = r.rows[0]
    return row ? this.#hydrate(row) : null
  }

  async create(projectId: number, input: RetentionReportInput): Promise<StoredRetentionReport> {
    try {
      const r = await this.pool.query<Row>(
        `INSERT INTO retention_reports
           (project_id, name, definition_version, start_event, return_event,
            start_where, return_where, granularity, periods, segment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${COLUMNS}`,
        [
          projectId,
          input.name,
          RETENTION_DEFINITION_VERSION,
          input.start_event,
          input.return_event,
          JSON.stringify(input.start_where),
          JSON.stringify(input.return_where),
          input.granularity,
          input.periods,
          input.segment_id,
        ],
      )
      const row = r.rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no row')
      return this.#hydrate(row)
    } catch (err) {
      if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
        throw new DuplicateRetentionNameError()
      }
      throw err
    }
  }

  /**
   * `segment_id` is `number | null | undefined` in `patch`, and the three
   * mean different things: a number sets the restriction, explicit `null`
   * clears it, and `undefined` (the key absent altogether) leaves it alone.
   * `patch.segment_id !== undefined` distinguishes the second case from the
   * third — the same check `FunnelStore.update`'s `segmentId` and
   * `TrendStore.update`'s `group_by` already make, and for the same reason:
   * a caller reading a plain property off an object it did not build sees
   * `undefined` whether the key is absent or was never set, which is the
   * same distinction JSON itself draws.
   */
  async update(
    projectId: number,
    id: number,
    patch: Partial<RetentionReportInput>,
  ): Promise<StoredRetentionReport | null> {
    try {
      const r = await this.pool.query<Row>(
        `UPDATE retention_reports SET
           name         = COALESCE($3, name),
           start_event  = COALESCE($4, start_event),
           return_event = COALESCE($5, return_event),
           start_where  = COALESCE($6::jsonb, start_where),
           return_where = COALESCE($7::jsonb, return_where),
           granularity  = COALESCE($8, granularity),
           periods      = COALESCE($9, periods),
           segment_id   = CASE WHEN $10 THEN $11 ELSE segment_id END,
           updated_at   = now()
         WHERE project_id = $1 AND id = $2
         RETURNING ${COLUMNS}`,
        [
          projectId,
          id,
          patch.name ?? null,
          patch.start_event ?? null,
          patch.return_event ?? null,
          patch.start_where ? JSON.stringify(patch.start_where) : null,
          patch.return_where ? JSON.stringify(patch.return_where) : null,
          patch.granularity ?? null,
          patch.periods ?? null,
          patch.segment_id !== undefined,
          patch.segment_id ?? null,
        ],
      )
      const row = r.rows[0]
      return row ? this.#hydrate(row) : null
    } catch (err) {
      if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
        throw new DuplicateRetentionNameError()
      }
      throw err
    }
  }

  async remove(projectId: number, id: number): Promise<boolean> {
    const r = await this.pool.query(
      'DELETE FROM retention_reports WHERE project_id = $1 AND id = $2',
      [projectId, id],
    )
    return (r.rowCount ?? 0) > 0
  }
}
