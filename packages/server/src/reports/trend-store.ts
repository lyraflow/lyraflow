import type { Pool } from '@lyraflow/db'

/** The four bucket widths `020_saved_reports.sql`'s CHECK constraint allows. */
export type TrendInterval = '1m' | '1h' | '1d' | '1w'

export interface StoredTrend {
  id: number
  name: string
  event: string
  interval: TrendInterval
  group_by: string | null
  created_at: string
  updated_at: string
}

/**
 * What `create` requires and `update` accepts a subset of. Snake_case,
 * unlike `FunnelStore`'s camelCase inputs -- there is no wire-to-domain
 * translation happening here at all: a trend's definition is three scalar
 * columns, so the store's own vocabulary is the table's, and `trend-routes.ts`
 * parses the request body directly into this shape rather than renaming each
 * field twice for no reason.
 */
export interface TrendInput {
  name: string
  event: string
  interval: TrendInterval
  group_by: string | null
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
  interval: TrendInterval
  group_by: string | null
  created_at: string
  updated_at: string
}

const COLUMNS = 'id, name, event, interval, group_by, created_at, updated_at'

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
 * Deliberately NOT the shape `FunnelStore` is: no `#hydrate`/parse step, no
 * `definition_version`, no cached last-run snapshot to invalidate on write.
 * `020_saved_reports.sql`'s own comment gives the reason -- a trend's
 * definition is three scalar columns rather than a parsed tree, so there is
 * nothing here that can fail to parse and nothing that can go stale the way
 * a funnel's cached counts can. That is a finding to report, not an
 * oversight to quietly fix: if a later change needs a `definition_version`
 * after all, it is because the definition stopped being scalar, and that is
 * a decision for whoever makes that change, not for this store to
 * anticipate.
 */
export class TrendStore {
  constructor(private readonly pool: Pool) {}

  #hydrate(row: Row): StoredTrend {
    return {
      id: Number(row.id),
      name: row.name,
      event: row.event,
      interval: row.interval,
      group_by: row.group_by,
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
        `INSERT INTO trend_reports (project_id, name, event, interval, group_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
        [projectId, input.name, input.event, input.interval, input.group_by],
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
   */
  async update(
    projectId: number,
    id: number,
    patch: Partial<TrendInput>,
  ): Promise<StoredTrend | null> {
    try {
      const r = await this.pool.query<Row>(
        `UPDATE trend_reports SET
           name       = COALESCE($3, name),
           event      = COALESCE($4, event),
           interval   = COALESCE($5, interval),
           group_by   = CASE WHEN $6 THEN $7 ELSE group_by END,
           updated_at = now()
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
