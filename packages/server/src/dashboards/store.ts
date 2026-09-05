import { randomBytes } from 'node:crypto'
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
/** The stored shape: what a row is hydrated through. No uniqueness rule
 *  here, deliberately -- see `Tiles`. */
const TileList = z.array(Tile).max(MAX_TILES)
/**
 * The shape a WRITE must satisfy: the stored shape, plus a report is on a
 * dashboard at most once. Keyed by the pair, because ids are per table --
 * trend 2 and funnel 2 are two reports, and a key on the id alone would
 * let the trend block the funnel. The issue lands on the SECOND occurrence,
 * as `tiles.<i>`: the first is fine on its own, and the routes send the
 * path back in their field-level 400.
 *
 * Reads go through `TileList` instead, so a row written before this rule
 * existed still hydrates as its two tiles rather than as `stale` -- stale
 * means "this build cannot read the layout", and it can. Such a row's next
 * move or resize is refused until the duplicate is removed, which the edit
 * screen's Remove can do: it sends the remaining tiles, and those are valid.
 */
export const Tiles = TileList.superRefine((tiles, ctx) => {
  const seen = new Set<string>()
  tiles.forEach((t, i) => {
    const key = `${t.kind}:${t.report_id}`
    if (seen.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [i],
        message: `${t.kind} ${t.report_id} is already on this dashboard`,
      })
    }
    seen.add(key)
  })
})

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
  shared: boolean
  share: DashboardShare | null
}

/** The `dashboards.share_token`/`shared_at` pair, hydrated together --
 *  `024_dashboard_shares.sql`'s CHECK guarantees they are both null or both
 *  set, so nothing here represents the other four combinations. */
export interface DashboardShare {
  token: string
  shared_at: string
}

/** 32 random bytes as base64url: 43 characters, no padding (global
 *  constraints, "Product rules"). The pattern is what the shared routes
 *  match a path segment against BEFORE any query, in Task 6. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
export function newShareToken(): string {
  return randomBytes(32).toString('base64url')
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
  share_token: string | null
  shared_at: string | null
}

// `shared_at` is left uncast, deliberately carrying the same untruth
// `created_at`/`updated_at` already carry: node-postgres parses a bare
// `timestamptz` column into a JS `Date`, not the `string` these fields are
// typed as (confirmed against the test database, not assumed). Casting only
// `shared_at` to `::text` would make it arrive on the wire as Postgres text
// (`2026-09-05 12:03:11.123456+00`) while `created_at`/`updated_at` arrive
// as ISO 8601, because `JSON.stringify` calls a `Date`'s own `toISOString`
// -- one row would then carry two date formats. Matching `created_at`'s
// treatment keeps the wire consistent; `hydrate` and every caller still see
// a `Date` at runtime regardless of the declared type.
const COLUMNS =
  'id, name, tiles, is_home, definition_version, created_at, updated_at, share_token, shared_at'
/** `list()`'s column list, identical to `COLUMNS` except the token itself --
 *  a list of N dashboards must not carry N read credentials (global
 *  constraints, "the token never appears in a list body"). `shared_at`
 *  alone is enough to say whether a link exists; `NULL::text` keeps the
 *  column position and type so `hydrate` needs no special case for it. */
const LIST_COLUMNS =
  'id, name, tiles, is_home, definition_version, created_at, updated_at, NULL::text AS share_token, shared_at'

function hydrate(row: Row): StoredDashboard {
  const parsed = TileList.safeParse(row.tiles)
  return {
    id: Number(row.id),
    name: row.name,
    tiles: parsed.success ? parsed.data : [],
    is_home: row.is_home,
    definition_version: row.definition_version,
    stale: !parsed.success,
    created_at: row.created_at,
    updated_at: row.updated_at,
    // `shared_at` is the source of truth for "has a link", even from a
    // `list()` row where `share_token` is always the literal NULL above --
    // `024_dashboard_shares.sql`'s pair CHECK is what makes that safe.
    shared: row.shared_at !== null,
    share:
      row.share_token !== null && row.shared_at !== null
        ? { token: row.share_token, shared_at: row.shared_at }
        : null,
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
 * reason `TrendStore` gives: an id is a caller-supplied path segment. The
 * one exception is `byShareToken`, whose own docstring says why a share
 * token needs no additional scope.
 *
 * `update` with `is_home: true` is the one transactional path: clear the
 * project's current home, set this row, commit. The partial unique index
 * `dashboards_one_home_per_project` is what makes two of these racing end
 * with one home -- the loser's second UPDATE fails at the index, the
 * transaction rolls back, and the caller retries once. A dashboard that
 * loses home is not `updated_at`-touched: its definition did not change.
 *
 * The clear runs before `#setHome` knows the target row exists (it must --
 * setting the new home before clearing the old one would collide with
 * itself on `dashboards_one_home_per_project`). So a `null` from
 * `#updateRow` -- `id` does not exist, or exists in a different project --
 * is answered with ROLLBACK, not COMMIT: a caller that gets 404 must see
 * its previous home untouched, not silently cleared.
 */
export class DashboardStore {
  constructor(private readonly pool: Pool) {}

  async list(projectId: number): Promise<StoredDashboard[]> {
    const r = await this.pool.query<Row>(
      `SELECT ${LIST_COLUMNS} FROM dashboards WHERE project_id = $1 ORDER BY name ASC`,
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
        if (updated === null) {
          // `id` does not exist, or exists in a different project -- the
          // clear above already ran against a row that isn't the one this
          // call is about. ROLLBACK undoes it rather than committing it: a
          // 404 must not silently move the caller's home.
          releaseErr = await this.#rollback(client)
          return null
        }
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
        releaseErr = await this.#rollback(client)
        if (attempt === 0 && violatesConstraint(err, HOME_UNIQUE_INDEX)) {
          continue
        }
        throw err
      } finally {
        client.release(releaseErr)
      }
    }
  }

  /** ROLLBACK, converted to the `client.release()` error argument if it
   *  itself fails -- shared by `#setHome`'s error path and its null-result
   *  path, which must destroy-not-recycle the connection the same way. */
  async #rollback(client: PoolClient): Promise<Error | undefined> {
    try {
      await client.query('ROLLBACK')
      return undefined
    } catch (rollbackErr) {
      return rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr))
    }
  }

  async remove(projectId: number, id: number): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM dashboards WHERE project_id = $1 AND id = $2', [
      projectId,
      id,
    ])
    return (r.rowCount ?? 0) > 0
  }

  /** Idempotent: a row that already has a link keeps it, rather than
   *  minting a second one on a repeat call -- the "returns the same one
   *  again" test in `store.test.ts` pins this. `COALESCE` on both columns
   *  also makes two concurrent calls safe without a transaction: whichever
   *  UPDATE commits first fixes the token, and the second's COALESCE sees
   *  that committed value and writes it right back, rather than each
   *  minting its own and racing to be "the" link. */
  async share(projectId: number, id: number): Promise<DashboardShare | null> {
    const r = await this.pool.query<{ share_token: string; shared_at: string }>(
      `UPDATE dashboards
          SET share_token = COALESCE(share_token, $3),
              shared_at   = COALESCE(shared_at, now())
        WHERE project_id = $1 AND id = $2
        RETURNING share_token, shared_at`,
      [projectId, id, newShareToken()],
    )
    const row = r.rows[0]
    return row ? { token: row.share_token, shared_at: row.shared_at } : null
  }

  /** Reports which of three things happened, distinguished because the
   *  route layer (Task 6) answers each with a different status. The old
   *  value has to come from a row read BEFORE the UPDATE runs, not
   *  `RETURNING` off the updated row -- `RETURNING (shared_at IS NOT
   *  NULL)` evaluates against the NEW row, which this statement has just
   *  set to NULL, so it would report `false` even when a link existed a
   *  moment ago. The `FROM (SELECT ...) old` subquery captures the
   *  pre-update state once, scoped by `project_id` the same as every other
   *  statement here, and `RETURNING old.was_shared` is what a wrong first
   *  draft of this method got backwards -- the "unshare clears both
   *  columns" test in `store.test.ts` is what would have caught it. */
  async unshare(projectId: number, id: number): Promise<'revoked' | 'not_shared' | 'not_found'> {
    const r = await this.pool.query<{ was_shared: boolean }>(
      `UPDATE dashboards d
          SET share_token = NULL, shared_at = NULL
         FROM (SELECT id, shared_at IS NOT NULL AS was_shared FROM dashboards WHERE project_id = $1 AND id = $2) old
        WHERE d.id = old.id
        RETURNING old.was_shared`,
      [projectId, id],
    )
    const row = r.rows[0]
    if (!row) return 'not_found'
    return row.was_shared ? 'revoked' : 'not_shared'
  }

  /** The one read in this store keyed by something other than
   *  `project_id` -- every other statement filters on it because an id is
   *  a caller-supplied path segment (this class's own docstring), but a
   *  share token IS the scope: it is an unguessable 43-character secret,
   *  not a small integer a caller could iterate. The project id is handed
   *  back because every downstream read the shared routes make (Task 6)
   *  still needs one. `dashboards_share_token_key`'s partial unique index
   *  is what makes `share_token = $1` resolve to at most one row. */
  async byShareToken(
    token: string,
  ): Promise<{ projectId: number; dashboard: StoredDashboard } | null> {
    const r = await this.pool.query<Row & { project_id: string }>(
      `SELECT project_id, ${COLUMNS} FROM dashboards WHERE share_token = $1`,
      [token],
    )
    const row = r.rows[0]
    return row ? { projectId: Number(row.project_id), dashboard: hydrate(row) } : null
  }
}
