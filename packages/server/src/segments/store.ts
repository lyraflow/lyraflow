import { type FilterNode, SegmentQuery } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'

export interface StoredSegment {
  id: number
  name: string
  astVersion: number
  filter: FilterNode
  lastCount: number | null
  lastEvaluatedAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * A row `list()` could not parse, surfaced instead of thrown. Same metadata
 * as `StoredSegment` minus the tree itself — `filter: null` and `stale: true`
 * mark it on the wire (see routes.ts's `toWire`) rather than the row simply
 * being absent, so an operator can see it exists, still rename or delete it,
 * and knows WHY it will not run. `get`/`create`/`update` still throw
 * `StoredTreeError` for a single row looked up on its own — that behaviour is
 * unchanged and correct; this type exists only for the "one bad row must not
 * take the whole list down" case `list()` fixes.
 */
export interface StaleListedSegment {
  id: number
  name: string
  astVersion: number
  filter: null
  stale: true
  lastCount: number | null
  lastEvaluatedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ListedSegment = StoredSegment | StaleListedSegment

/**
 * A stored tree failed to parse. Carries the version so the response can name
 * it — the whole point of storing `ast_version` is that this case is
 * diagnosable rather than a mystery 500.
 */
export class StoredTreeError extends Error {
  constructor(readonly astVersion: number) {
    super(`stored filter tree does not parse under ast_version ${astVersion}`)
    this.name = 'StoredTreeError'
  }
}

export class DuplicateNameError extends Error {
  constructor() {
    super('a segment with that name already exists in this project')
    this.name = 'DuplicateNameError'
  }
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'

interface Row {
  id: string
  name: string
  ast_version: number
  filter: unknown
  last_count: string | null
  last_evaluated_at: string | null
  created_at: string
  updated_at: string
}

/**
 * CRUD over `segments`.
 *
 * Every method takes `projectId` and every statement filters on it. That is
 * not defensive duplication: `id` is a caller-supplied path segment, and a
 * query that looked up by `id` alone would happily return another tenant's
 * segment. Scoping in the WHERE clause is also what makes "not found" and
 * "belongs to someone else" indistinguishable to a caller, which is
 * deliberate — a 403 would confirm the id exists.
 */
export class SegmentStore {
  constructor(private readonly pool: Pool) {}

  #hydrate(row: Row): StoredSegment {
    // A stored tree is untrusted input on the way out. Not because Postgres
    // corrupts data, but because the row may predate an AST change or have
    // been written by an older build. Parsing here means a stale tree is a
    // named 400 rather than SQL compiled from something unexpected.
    const parsed = SegmentQuery.safeParse({ ast_version: row.ast_version, filter: row.filter })
    if (!parsed.success) throw new StoredTreeError(row.ast_version)
    return {
      id: Number(row.id),
      name: row.name,
      astVersion: row.ast_version,
      filter: parsed.data.filter,
      lastCount: row.last_count === null ? null : Number(row.last_count),
      lastEvaluatedAt: row.last_evaluated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Lists every segment in a project. Unlike `get`, a single row that fails
   * to parse (see `#hydrate`) does NOT abort the whole response — that is
   * precisely the situation `ast_version` was stored to make diagnosable,
   * and a 400 for the whole list is the opposite of diagnosable: it takes
   * down every OTHER segment in the project along with the bad one, so the
   * operator cannot even see, rename, or delete the rows that are still
   * fine. A row that fails to hydrate is returned as a `StaleListedSegment`
   * instead (`filter: null`, `stale: true`) so the list still renders and
   * the bad row is identifiable by id and name.
   */
  async list(projectId: number): Promise<ListedSegment[]> {
    const r = await this.pool.query<Row>(
      `SELECT id, name, ast_version, filter, last_count, last_evaluated_at, created_at, updated_at
         FROM segments WHERE project_id = $1 ORDER BY name ASC`,
      [projectId],
    )
    return r.rows.map((row): ListedSegment => {
      try {
        return this.#hydrate(row)
      } catch (err) {
        if (err instanceof StoredTreeError) {
          return {
            id: Number(row.id),
            name: row.name,
            astVersion: row.ast_version,
            filter: null,
            stale: true,
            lastCount: row.last_count === null ? null : Number(row.last_count),
            lastEvaluatedAt: row.last_evaluated_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }
        }
        throw err
      }
    })
  }

  async get(projectId: number, id: number): Promise<StoredSegment | null> {
    const r = await this.pool.query<Row>(
      `SELECT id, name, ast_version, filter, last_count, last_evaluated_at, created_at, updated_at
         FROM segments WHERE project_id = $1 AND id = $2`,
      [projectId, id],
    )
    const row = r.rows[0]
    return row ? this.#hydrate(row) : null
  }

  async create(projectId: number, name: string, query: SegmentQuery): Promise<StoredSegment> {
    try {
      const r = await this.pool.query<Row>(
        `INSERT INTO segments (project_id, name, ast_version, filter)
         VALUES ($1, $2, $3, $4)
         RETURNING id, name, ast_version, filter, last_count, last_evaluated_at, created_at, updated_at`,
        [projectId, name, query.ast_version, JSON.stringify(query.filter)],
      )
      const row = r.rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no row')
      return this.#hydrate(row)
    } catch (err) {
      if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
        throw new DuplicateNameError()
      }
      throw err
    }
  }

  /**
   * Changing `filter` clears the snapshot in the same statement; renaming
   * does not. A stored count belongs to the tree it was computed from.
   */
  async update(
    projectId: number,
    id: number,
    patch: { name?: string; query?: SegmentQuery },
  ): Promise<StoredSegment | null> {
    try {
      const r = await this.pool.query<Row>(
        `UPDATE segments SET
           name              = COALESCE($3, name),
           ast_version       = COALESCE($4, ast_version),
           filter            = COALESCE($5::jsonb, filter),
           last_count        = CASE WHEN $5::jsonb IS NULL THEN last_count        ELSE NULL END,
           last_evaluated_at = CASE WHEN $5::jsonb IS NULL THEN last_evaluated_at ELSE NULL END,
           updated_at        = now()
         WHERE project_id = $1 AND id = $2
         RETURNING id, name, ast_version, filter, last_count, last_evaluated_at, created_at, updated_at`,
        [
          projectId,
          id,
          patch.name ?? null,
          patch.query?.ast_version ?? null,
          patch.query ? JSON.stringify(patch.query.filter) : null,
        ],
      )
      const row = r.rows[0]
      return row ? this.#hydrate(row) : null
    } catch (err) {
      if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
        throw new DuplicateNameError()
      }
      throw err
    }
  }

  async remove(projectId: number, id: number): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM segments WHERE project_id = $1 AND id = $2', [
      projectId,
      id,
    ])
    return (r.rowCount ?? 0) > 0
  }

  /** Writes the last-run snapshot. Never rejects for a caller that ignores it. */
  async recordRun(projectId: number, id: number, count: number, at: Date): Promise<void> {
    await this.pool.query(
      `UPDATE segments SET last_count = $3, last_evaluated_at = $4
         WHERE project_id = $1 AND id = $2`,
      [projectId, id, count, at.toISOString()],
    )
  }
}
