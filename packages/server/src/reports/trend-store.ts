import { type Interval, MAX_WHERE_PREDICATES, WherePredicate } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'
import { z } from 'zod'

/**
 * The shape version stamped on every row THIS build writes.
 *
 * `020_saved_reports.sql` argued that this table needed no such column,
 * because a trend's definition was three scalar values. 021 made that false
 * by adding `event_where` -- the segment grammar, JSON, parsed. The
 * where-grammar versions itself independently and is handled by `stale`;
 * this column is for finding every row written under an earlier shape of
 * THIS table without parsing each one.
 */
const TREND_DEFINITION_VERSION = 1

/**
 * The `where` predicates' own schema -- the SAME one `events/routes.ts`
 * validates a run's `where` against, not a second notion of a valid
 * predicate. A second one would drift from the first the moment the grammar
 * changes, which is exactly the failure `stale` exists to make visible
 * rather than silently wrong.
 */
const StoredWhere = z.array(WherePredicate).max(MAX_WHERE_PREDICATES)

/**
 * `stale` is `true` when the row's stored `event_where` no longer parses
 * under `StoredWhere`, `false` otherwise, and is ALWAYS present -- never
 * omitted for an ordinary row, so a client checks one field regardless of
 * whether the row it is looking at happens to be broken. `list()` never
 * throws for this reason; `#hydrate` computes it inline. Identical to
 * `StoredRetentionReport.stale`, which documents the same rule.
 *
 * `where` is `unknown[]`, not `WherePredicate[]`: a row written by a FUTURE
 * build can be read by this one, and typing it as parsed would be a lie the
 * compiler cannot catch. `stale` is how a caller knows which it has.
 */
export interface StoredTrend {
  id: number
  name: string
  event: string
  interval: Interval
  group_by: string | null
  where: unknown[]
  definition_version: number
  stale: boolean
  created_at: string
  updated_at: string
}

/**
 * What `create` requires and `update` accepts a subset of. Snake_case, like
 * `RetentionReportInput`.
 *
 * The store's vocabulary is the table's in every field but ONE: this
 * `where` is the column `event_where`, because `where` is a reserved word in
 * SQL. Everything a caller can see -- the wire, the URL, this type -- says
 * `where`; only the statements below say `event_where`. A reserved word is a
 * SQL problem and stays one.
 */
export interface TrendInput {
  name: string
  event: string
  interval: Interval
  group_by: string | null
  /**
   * Typed as validated `WherePredicate[]` on the way IN, because a caller
   * constructing this has already gone through the grammar's own schema
   * (`trend-routes.ts` does, via `CreateBody`/`PatchBody`). `#hydrate`
   * re-parses on the way OUT, for the reason `StoredTrend.where` gives.
   */
  where: WherePredicate[]
}

export class DuplicateTrendNameError extends Error {
  constructor() {
    super('a trend report with that name already exists in this project')
    this.name = 'DuplicateTrendNameError'
  }
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'

interface Row {
  id: string
  name: string
  event: string
  interval: Interval
  group_by: string | null
  event_where: unknown
  definition_version: number
  created_at: string
  updated_at: string
}

const COLUMNS =
  'id, name, event, interval, group_by, event_where, definition_version, created_at, updated_at'

/**
 * CRUD over `trend_reports`.
 *
 * Every method takes `projectId` and every statement filters on it, same
 * discipline as `FunnelStore` and `SegmentStore` and for the same reason: an
 * id is a caller-supplied path segment, and a query that looked it up alone
 * would happily return another tenant's report. Scoping in the WHERE clause
 * also makes "not found" and "belongs to someone else" indistinguishable to
 * a caller, which is deliberate -- a 403 would confirm the id exists.
 *
 * Deliberately NOT the shape `FunnelStore` is: no cached last-run snapshot to
 * invalidate on write. `020_saved_reports.sql`'s own comment gives the
 * reason -- a trend's definition is three scalar values plus a predicate
 * list, not a compiled step sequence, so there is nothing here that can go
 * stale the way a funnel's cached counts can. `where` can still fail to
 * parse, which is what `stale` is for; that is a narrower claim than "there
 * is nothing here that can fail to parse" and this docstring used to
 * overstate it.
 */
export class TrendStore {
  constructor(private readonly pool: Pool) {}

  #hydrate(row: Row): StoredTrend {
    // Never thrown -- see `StoredTrend`'s own docstring.
    const parsed = StoredWhere.safeParse(row.event_where)
    return {
      id: Number(row.id),
      name: row.name,
      event: row.event,
      interval: row.interval,
      group_by: row.group_by,
      where: parsed.success ? parsed.data : (row.event_where as unknown[]),
      definition_version: row.definition_version,
      stale: !parsed.success,
      created_at: row.created_at,
      updated_at: row.updated_at,
    }
  }

  async list(projectId: number): Promise<StoredTrend[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM trend_reports WHERE project_id = $1 ORDER BY name ASC`,
      [projectId],
    )
    return r.rows.map((row) => this.#hydrate(row))
  }

  async get(projectId: number, id: number): Promise<StoredTrend | null> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM trend_reports WHERE project_id = $1 AND id = $2`,
      [projectId, id],
    )
    const row = r.rows[0]
    return row ? this.#hydrate(row) : null
  }

  async create(projectId: number, input: TrendInput): Promise<StoredTrend> {
    try {
      const r = await this.pool.query<Row>(
        `INSERT INTO trend_reports
           (project_id, name, event, interval, group_by, event_where, definition_version)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         RETURNING ${COLUMNS}`,
        [
          projectId,
          input.name,
          input.event,
          input.interval,
          input.group_by,
          JSON.stringify(input.where),
          TREND_DEFINITION_VERSION,
        ],
      )
      const row = r.rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no row')
      return this.#hydrate(row)
    } catch (err) {
      if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
        throw new DuplicateTrendNameError()
      }
      throw err
    }
  }

  /**
   * `group_by` is `string | null | undefined` in `patch`, and the three mean
   * different things: a string sets it, explicit `null` clears the
   * breakdown, and `undefined` (the key absent altogether, or a JSON body
   * that never carried it) leaves it alone. `patch.group_by !== undefined`
   * is what distinguishes the second case from the third -- exactly
   * `FunnelStore.update`'s `segmentId !== undefined` check, and for the same
   * reason: a caller reading a plain property off an object it did not
   * build sees `undefined` whether the key is absent or was never set,
   * which is the same distinction JSON itself draws (a missing key parses
   * to nothing; an explicit `null` parses to `null`).
   *
   * `where` draws the same absent/present distinction, spelled differently
   * because an array can carry "empty" as a real value and a string cannot:
   * `patch.where` is truthy for `[]` (arrays are always truthy in
   * JavaScript, regardless of length) and falsy only for `undefined`, so
   * `patch.where ? JSON.stringify(patch.where) : null` writes an explicit
   * empty list while leaving an absent key to COALESCE onto the stored
   * value. A patch that writes `where` also re-stamps `definition_version`
   * to `TREND_DEFINITION_VERSION` -- the stored predicates are now whatever
   * THIS build parsed and wrote, whether or not the row's old value already
   * matched, so a future migration that needs "every row written under the
   * old shape" is not defeated by a PATCH that left an old stamp behind. A
   * patch that only renames, or only touches event/interval/group_by,
   * leaves the version alone -- the predicate tree did not change.
   */
  async update(
    projectId: number,
    id: number,
    patch: Partial<TrendInput>,
  ): Promise<StoredTrend | null> {
    try {
      const r = await this.pool.query<Row>(
        `UPDATE trend_reports SET
           name        = COALESCE($3, name),
           event       = COALESCE($4, event),
           interval    = COALESCE($5, interval),
           group_by    = CASE WHEN $6 THEN $7 ELSE group_by END,
           event_where = COALESCE($8::jsonb, event_where),
           definition_version = CASE WHEN $8::jsonb IS NULL THEN definition_version ELSE $9 END,
           updated_at  = now()
         WHERE project_id = $1 AND id = $2
         RETURNING ${COLUMNS}`,
        [
          projectId,
          id,
          patch.name ?? null,
          patch.event ?? null,
          patch.interval ?? null,
          patch.group_by !== undefined,
          patch.group_by ?? null,
          // `[]` is truthy, so an explicit empty list WRITES (clearing the
          // filter) while an absent key stays `null` and COALESCEs to the
          // stored value. The same distinction `group_by` draws above with
          // its boolean flag, spelled differently only because an array can
          // carry "empty" as a real value and a string cannot.
          patch.where ? JSON.stringify(patch.where) : null,
          TREND_DEFINITION_VERSION,
        ],
      )
      const row = r.rows[0]
      return row ? this.#hydrate(row) : null
    } catch (err) {
      if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
        throw new DuplicateTrendNameError()
      }
      throw err
    }
  }

  async remove(projectId: number, id: number): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM trend_reports WHERE project_id = $1 AND id = $2', [
      projectId,
      id,
    ])
    return (r.rowCount ?? 0) > 0
  }
}
