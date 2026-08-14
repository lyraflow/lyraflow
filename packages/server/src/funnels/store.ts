import { FUNNEL_DEFINITION_VERSION, type FunnelDefinition, FunnelStep } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'
import { z } from 'zod'

export interface StoredFunnel {
  id: number
  name: string
  definitionVersion: number
  steps: FunnelStep[]
  windowSeconds: number
  segmentId: number | null
  lastEntered: number | null
  lastConverted: number | null
  lastEvaluatedAt: string | null
  createdAt: string
  updatedAt: string
}

/**
 * A row `list()` could not parse, surfaced instead of thrown — the same
 * contract `StaleListedSegment` has, and for the same reason: one row written
 * by an older build must not take down every other funnel in the project, or
 * the operator cannot even see, rename or delete the rows that are still fine.
 */
export interface StaleListedFunnel {
  id: number
  name: string
  definitionVersion: number
  steps: null
  stale: true
  windowSeconds: number
  segmentId: number | null
  lastEntered: number | null
  lastConverted: number | null
  lastEvaluatedAt: string | null
  createdAt: string
  updatedAt: string
}

export type ListedFunnel = StoredFunnel | StaleListedFunnel

/**
 * A stored definition failed to parse. Carries the version so the response can
 * name it — the whole point of storing `definition_version` is that this case
 * is diagnosable rather than a mystery 500.
 */
export class StoredDefinitionError extends Error {
  constructor(readonly definitionVersion: number) {
    super(`stored funnel definition does not parse under version ${definitionVersion}`)
    this.name = 'StoredDefinitionError'
  }
}

export class DuplicateFunnelNameError extends Error {
  constructor() {
    super('a funnel with that name already exists in this project')
    this.name = 'DuplicateFunnelNameError'
  }
}

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505'

const StoredSteps = z.array(FunnelStep).min(2)

interface Row {
  id: string
  name: string
  definition_version: number
  steps: unknown
  window_seconds: number
  segment_id: string | null
  last_entered: string | null
  last_converted: string | null
  last_evaluated_at: string | null
  created_at: string
  updated_at: string
}

/**
 * CRUD over `funnels`.
 *
 * Every method takes `projectId` and every statement filters on it. `id` is a
 * caller-supplied path segment, and a query looking it up alone would happily
 * return another tenant's funnel. Scoping in the WHERE clause is also what
 * makes "not found" and "belongs to someone else" indistinguishable to a
 * caller, which is deliberate — a 403 would confirm the id exists.
 */
export class FunnelStore {
  constructor(private readonly pool: Pool) {}

  #hydrate(row: Row): StoredFunnel {
    // A stored definition is untrusted input on the way out — not because
    // Postgres corrupts data, but because the row may predate a shape change
    // or have been written by an older build. Parsing here makes a stale
    // definition a named 400 rather than SQL compiled from something
    // unexpected.
    const parsed = StoredSteps.safeParse(row.steps)
    if (!parsed.success) throw new StoredDefinitionError(row.definition_version)
    return {
      id: Number(row.id),
      name: row.name,
      definitionVersion: row.definition_version,
      steps: parsed.data,
      windowSeconds: row.window_seconds,
      segmentId: row.segment_id === null ? null : Number(row.segment_id),
      lastEntered: row.last_entered === null ? null : Number(row.last_entered),
      lastConverted: row.last_converted === null ? null : Number(row.last_converted),
      lastEvaluatedAt: row.last_evaluated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  #stale(row: Row): StaleListedFunnel {
    return {
      id: Number(row.id),
      name: row.name,
      definitionVersion: row.definition_version,
      steps: null,
      stale: true,
      windowSeconds: row.window_seconds,
      segmentId: row.segment_id === null ? null : Number(row.segment_id),
      lastEntered: row.last_entered === null ? null : Number(row.last_entered),
      lastConverted: row.last_converted === null ? null : Number(row.last_converted),
      lastEvaluatedAt: row.last_evaluated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async list(projectId: number): Promise<ListedFunnel[]> {
    const r = await this.pool.query<Row>(
      `SELECT id, name, definition_version, steps, window_seconds, segment_id,
              last_entered, last_converted, last_evaluated_at, created_at, updated_at
         FROM funnels WHERE project_id = $1 ORDER BY name ASC`,
      [projectId],
    )
    return r.rows.map((row): ListedFunnel => {
      try {
        return this.#hydrate(row)
      } catch (err) {
        if (err instanceof StoredDefinitionError) return this.#stale(row)
        throw err
      }
    })
  }

  async get(projectId: number, id: number): Promise<StoredFunnel | null> {
    const r = await this.pool.query<Row>(
      `SELECT id, name, definition_version, steps, window_seconds, segment_id,
              last_entered, last_converted, last_evaluated_at, created_at, updated_at
         FROM funnels WHERE project_id = $1 AND id = $2`,
      [projectId, id],
    )
    const row = r.rows[0]
    return row ? this.#hydrate(row) : null
  }

  /**
   * By name, because the CLI addresses funnels that way: `UNIQUE (project_id,
   * name)` makes it unambiguous, and an operator running a weekly report
   * should not have to remember that signup is funnel 3.
   */
  async getByName(projectId: number, name: string): Promise<StoredFunnel | null> {
    const r = await this.pool.query<Row>(
      `SELECT id, name, definition_version, steps, window_seconds, segment_id,
              last_entered, last_converted, last_evaluated_at, created_at, updated_at
         FROM funnels WHERE project_id = $1 AND name = $2`,
      [projectId, name],
    )
    const row = r.rows[0]
    return row ? this.#hydrate(row) : null
  }

  async create(
    projectId: number,
    name: string,
    definition: FunnelDefinition,
  ): Promise<StoredFunnel> {
    try {
      const r = await this.pool.query<Row>(
        `INSERT INTO funnels (project_id, name, definition_version, steps, window_seconds, segment_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, definition_version, steps, window_seconds, segment_id,
                   last_entered, last_converted, last_evaluated_at, created_at, updated_at`,
        [
          projectId,
          name,
          FUNNEL_DEFINITION_VERSION,
          JSON.stringify(definition.steps),
          definition.window_seconds,
          definition.segment_id ?? null,
        ],
      )
      const row = r.rows[0]
      if (!row) throw new Error('INSERT ... RETURNING produced no row')
      return this.#hydrate(row)
    } catch (err) {
      if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
        throw new DuplicateFunnelNameError()
      }
      throw err
    }
  }

  /**
   * Changing any part of the DEFINITION clears the snapshot in the same
   * statement; renaming does not. A stored count describes the definition it
   * was computed from, so leaving it after an edit makes a list display a
   * confident number for a funnel that no longer exists.
   *
   * `segmentId` is `number | null | undefined` and the three mean different
   * things: a number sets it, `null` clears the restriction, and `undefined`
   * leaves it alone. Collapsing null and undefined would make "remove the
   * segment" unexpressible through PATCH.
   */
  async update(
    projectId: number,
    id: number,
    patch: {
      name?: string
      steps?: FunnelStep[]
      windowSeconds?: number
      segmentId?: number | null
    },
  ): Promise<StoredFunnel | null> {
    const touchesDefinition =
      patch.steps !== undefined ||
      patch.windowSeconds !== undefined ||
      patch.segmentId !== undefined
    try {
      const r = await this.pool.query<Row>(
        `UPDATE funnels SET
           name              = COALESCE($3, name),
           steps             = COALESCE($4::jsonb, steps),
           window_seconds    = COALESCE($5, window_seconds),
           segment_id        = CASE WHEN $6 THEN $7 ELSE segment_id END,
           last_entered      = CASE WHEN $8 THEN NULL ELSE last_entered END,
           last_converted    = CASE WHEN $8 THEN NULL ELSE last_converted END,
           last_evaluated_at = CASE WHEN $8 THEN NULL ELSE last_evaluated_at END,
           updated_at        = now()
         WHERE project_id = $1 AND id = $2
         RETURNING id, name, definition_version, steps, window_seconds, segment_id,
                   last_entered, last_converted, last_evaluated_at, created_at, updated_at`,
        [
          projectId,
          id,
          patch.name ?? null,
          patch.steps ? JSON.stringify(patch.steps) : null,
          patch.windowSeconds ?? null,
          patch.segmentId !== undefined,
          patch.segmentId ?? null,
          touchesDefinition,
        ],
      )
      const row = r.rows[0]
      return row ? this.#hydrate(row) : null
    } catch (err) {
      if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
        throw new DuplicateFunnelNameError()
      }
      throw err
    }
  }

  async remove(projectId: number, id: number): Promise<boolean> {
    const r = await this.pool.query('DELETE FROM funnels WHERE project_id = $1 AND id = $2', [
      projectId,
      id,
    ])
    return (r.rowCount ?? 0) > 0
  }

  /**
   * Writes the last-run snapshot. A cache, not a fact: nothing recomputes it,
   * and it is always rendered alongside `lastEvaluatedAt` rather than as a
   * bare number.
   */
  async recordRun(
    projectId: number,
    id: number,
    run: { entered: number; converted: number; at: Date },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE funnels SET last_entered = $3, last_converted = $4, last_evaluated_at = $5
         WHERE project_id = $1 AND id = $2`,
      [projectId, id, run.entered, run.converted, run.at.toISOString()],
    )
  }
}
