import type { Pool, PoolClient } from '@lyraflow/db'
import { z } from 'zod'

/** The shape version stamped on every row THIS build writes; re-stamped by
 *  any patch that rewrites `tiles`, for the reason `TrendStore.update`
 *  gives about `definition_version`. */
const DASHBOARD_DEFINITION_VERSION = 1

export const TILE_KINDS = ['trend', 'retention', 'funnel'] as const
export type TileKind = (typeof TILE_KINDS)[number]
export const TILE_WIDTHS = ['half', 'full'] as const
export type TileWidth = (typeof TILE_WIDTHS)[number]
/** Also a CHECK in `023_dashboards.sql`; SQL cannot import this constant. */
export const MAX_TILES = 12

export const Tile = z.object({
  kind: z.enum(TILE_KINDS),
  report_id: z.number().int().positive(),
  width: z.enum(TILE_WIDTHS),
})
export type Tile = z.infer<typeof Tile>
export const Tiles = z.array(Tile).max(MAX_TILES)

/**
 * `stale` is `true` when the stored `tiles` no longer parse under `Tiles`,
 * and `tiles` is then `[]` -- a client checks `stale`, never the array, to
 * tell "empty" from "unreadable". Never thrown; `list()` cannot fail for
 * one bad row. Identical contract to `StoredTrend.stale`.
 */
export interface StoredDashboard {
  id: number
  name: string
  tiles: Tile[]
  is_home: boolean
  definition_version: number
  stale: boolean
  created_at: string
  updated_at: string
}

export interface DashboardInput {
  name: string
  tiles: Tile[]
}

export interface DashboardPatch {
  name?: string
  tiles?: Tile[]
  is_home?: boolean
}

export class DuplicateDashboardNameError extends Error {
  constructor() {
    super('a dashboard with that name already exists in this project')
    this.name = 'DuplicateDashboardNameError'
  }
}

const UNIQUE_VIOLATION = '23505'
/** The name UNIQUE constraint (`023_dashboards.sql`'s `UNIQUE (project_id, name)`). */
const NAME_UNIQUE_CONSTRAINT = 'dashboards_project_id_name_key'
/** The one-home-per-project partial unique index -- also a source of
 *  SQLSTATE 23505, and NOT the same failure as the one above. Confirmed
 *  against `pg_constraint`/`pg_indexes` on the test database, not guessed:
 *  Postgres reports a violated unique INDEX under `err.constraint` exactly
 *  as it does a named CONSTRAINT, even though a partial unique index has
 *  no row in `pg_constraint` at all. */
const HOME_UNIQUE_INDEX = 'dashboards_one_home_per_project'

interface Row {
  id: string
  name: string
  tiles: unknown
  is_home: boolean
  definition_version: number
  created_at: string
  updated_at: string
}

const COLUMNS = 'id, name, tiles, is_home, definition_version, created_at, updated_at'

function hydrate(row: Row): StoredDashboard {
  const parsed = Tiles.safeParse(row.tiles)
  return {
    id: Number(row.id),
    name: row.name,
    tiles: parsed.success ? parsed.data : [],
    is_home: row.is_home,
    definition_version: row.definition_version,
    stale: !parsed.success,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

/**
 * True when `err` is a Postgres unique-violation (23505) against exactly
 * the named constraint or index -- NOT "any 23505", because `dashboards`
 * has two independent sources of that SQLSTATE (`NAME_UNIQUE_CONSTRAINT`
 * and `HOME_UNIQUE_INDEX`) and they mean different things: one is a
 * caller mistake (`DuplicateDashboardNameError`), the other is a race
 * `#setHome` retries. Collapsing them onto the SQLSTATE alone -- the
 * earlier version of this function did -- makes the second kind
 * unreachable: `#updateRow`'s catch would convert BOTH into
 * `DuplicateDashboardNameError`, and `#setHome`'s retry, gated on seeing
 * the raw error, would never fire.
 */
function violatesConstraint(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string } | null
  return e?.code === UNIQUE_VIOLATION && e?.constraint === constraint
}

/**
 * CRUD over `dashboards`. Every statement filters on `project_id`, for the
 * reason `TrendStore` gives: an id is a caller-supplied path segment.
 *
 * `update` with `is_home: true` is the one transactional path: clear the
 * project's current home, set this row, commit. The partial unique index
 * `dashboards_one_home_per_project` is what makes two of these racing end
 * with one home -- the loser's second UPDATE fails at the index, the
 * transaction rolls back, and the caller retries once. A dashboard that
 * loses home is not `updated_at`-touched: its definition did not change.
 */
export class DashboardStore {
  constructor(private readonly pool: Pool) {}

  async list(projectId: number): Promise<StoredDashboard[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM dashboards WHERE project_id = $1 ORDER BY name ASC`,
      [projectId],
    )
    return r.rows.map(hydrate)
  }

  async get(projectId: number, id: number): Promise<StoredDashboard | null> {
    const r = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM dashboards WHERE project_id = $1 AND id = $2`,
      [projectId, id],
    )
    const row = r.rows[0]
    return row ? hydrate(row) : null
  }

  async create(projectId: number, input: DashboardInput): Promise<StoredDashboard> {
    try {
      const r = await this.pool.query<Row>(
        `INSERT INTO dashboards (project_id, name, definition_version, tiles)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING ${COLUMNS}`,
        [projectId, input.name, DASHBOARD_DEFINITION_VERSION, JSON.stringify(input.tiles)],
      )
      const row = r.rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no row')
      return hydrate(row)
    } catch (err) {
      if (violatesConstraint(err, NAME_UNIQUE_CONSTRAINT)) throw new DuplicateDashboardNameError()
      throw err
    }
  }

  async update(
    projectId: number,
    id: number,
    patch: DashboardPatch,
  ): Promise<StoredDashboard | null> {
    if (patch.is_home === true) return this.#setHome(projectId, id, patch)
    return this.#updateRow(this.pool, projectId, id, patch)
  }

  async #updateRow(
    q: Pick<Pool | PoolClient, 'query'>,
    projectId: number,
    id: number,
    patch: DashboardPatch,
  ): Promise<StoredDashboard | null> {
    try {
      const r = await q.query<Row>(
        `UPDATE dashboards SET
           name               = COALESCE($3, name),
           tiles              = COALESCE($4::jsonb, tiles),
           definition_version = CASE WHEN $4::jsonb IS NULL THEN definition_version ELSE $5 END,
           is_home            = COALESCE($6, is_home),
           updated_at         = now()
         WHERE project_id = $1 AND id = $2
         RETURNING ${COLUMNS}`,
        [
          projectId,
          id,
          patch.name ?? null,
          patch.tiles ? JSON.stringify(patch.tiles) : null,
          DASHBOARD_DEFINITION_VERSION,
          patch.is_home ?? null,
        ],
      )
      const row = r.rows[0]
      return row ? hydrate(row) : null
    } catch (err) {
      // A 23505 here from `#setHome`'s connection can be EITHER source --
      // only the name check is converted. A `HOME_UNIQUE_INDEX` violation
      // is left raw so `#setHome`'s catch can see it and retry.
      if (violatesConstraint(err, NAME_UNIQUE_CONSTRAINT)) throw new DuplicateDashboardNameError()
      throw err
    }
  }

  async #setHome(
    projectId: number,
    id: number,
    patch: DashboardPatch,
  ): Promise<StoredDashboard | null> {
    // One retry: the only way the transaction fails on `HOME_UNIQUE_INDEX`
    // is a concurrent set-home that committed between our clear and our
    // set. The second attempt sees that row as the current home and clears
    // it. Gated on `violatesConstraint(err, HOME_UNIQUE_INDEX)`, not on
    // SQLSTATE alone -- see that function's docstring for why a caller's
    // own name collision (already converted to `DuplicateDashboardNameError`
    // by `#updateRow`, and so carrying no `.constraint` at all) falls
    // through to `throw err` below without an extra `instanceof` guard: it
    // simply never matches `violatesConstraint`.
    for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect()
      // Set only if ROLLBACK itself fails, below, and passed to
      // `client.release()` in `finally` -- see that catch block for why,
      // same reasoning and pattern as `ProjectDeletionStore.request`.
      let releaseErr: Error | undefined
      try {
        await client.query('BEGIN')
        await client.query(
          'UPDATE dashboards SET is_home = false WHERE project_id = $1 AND is_home AND id <> $2',
          [projectId, id],
        )
        const updated = await this.#updateRow(client, projectId, id, patch)
        await client.query('COMMIT')
        return updated
      } catch (err) {
        // ROLLBACK itself can fail (e.g. a dead connection); that must not
        // replace `err`, which is what this method throws. A rollback
        // failure still has to be dealt with: `client.release()` with NO
        // argument returns the connection to the pool's IDLE list
        // regardless of whether the transaction was ever rolled back, and
        // every later query anyone sends over it then fails with "current
        // transaction is aborted" -- permanently. `client.release(err)`,
        // called with a truthy argument, is what makes the pool DESTROY
        // the connection instead of recycling it.
        try {
          await client.query('ROLLBACK')
        } catch (rollbackErr) {
          releaseErr = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr))
        }
        if (attempt === 0 && violatesConstraint(err, HOME_UNIQUE_INDEX)) {
          continue
        }
        throw err
      } finally {
        client.release(releaseErr)
      }
    }
  }

  async remove(projectId: number, id: number): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM dashboards WHERE project_id = $1 AND id = $2', [
      projectId,
      id,
    ])
    return (r.rowCount ?? 0) > 0
  }
}
