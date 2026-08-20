import {
  FUNNEL_DEFINITION_VERSION,
  type FunnelDefinition,
  FunnelStep,
  type WherePredicate,
} from '@lyraflow/core'
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
  /** The window the cached counts were computed over, or null for a row that
   *  never ran -- or one summarised before migration 016, which genuinely does
   *  not know. Both bounds or neither (#91). */
  lastRange: { since: string; until: string } | null
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
  /** The window the cached counts were computed over, or null for a row that
   *  never ran -- or one summarised before migration 016, which genuinely does
   *  not know. Both bounds or neither (#91). */
  lastRange: { since: string; until: string } | null
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

/**
 * Structural equality for two `where` predicate values. A predicate's `value`
 * is either a scalar or a two-element tuple (`between`); comparing by field
 * rather than by JSON string keeps this independent of how each value was
 * constructed.
 */
function valueEqual(a: WherePredicate['value'], b: WherePredicate['value']): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i])
    )
  }
  return a === b
}

/**
 * Field-by-field, not `JSON.stringify` equality: a value parsed from the
 * incoming request and a value round-tripped through Postgres jsonb are not
 * guaranteed to serialise their object keys in the same order even when
 * every field agrees, and a key-order-sensitive comparison would silently
 * keep today's bug while looking fixed. `where` order IS significant here —
 * it is compared positionally, same as `steps` order — because this compares
 * two definitions for exact equality, not for equivalence.
 */
function stepsEqual(a: FunnelStep[], b: FunnelStep[]): boolean {
  if (a.length !== b.length) return false
  return a.every((stepA, i) => {
    const stepB = b[i]
    if (!stepB || stepA.event !== stepB.event) return false
    const whereA = stepA.where ?? []
    const whereB = stepB.where ?? []
    if (whereA.length !== whereB.length) return false
    return whereA.every((p, j) => {
      const q = whereB[j]
      return (
        !!q &&
        p.property === q.property &&
        p.operator === q.operator &&
        valueEqual(p.value, q.value)
      )
    })
  })
}

/**
 * Whether `patch` actually changes the stored definition — as opposed to
 * merely CARRYING the fields that make up the definition, which is what the
 * PATCH body always does because the UI sends the whole definition on every
 * save. A field patch.foo === undefined means "leave it alone" and is never
 * a change; a field present with exactly its current value is present but
 * not a change either. `segmentId` additionally distinguishes an explicit
 * `null` (clear the filter) from omission (leave it) — both handled by the
 * `!== undefined` checks below, since `null !== undefined`.
 */
function definitionChanged(
  patch: { steps?: FunnelStep[]; windowSeconds?: number; segmentId?: number | null },
  current: { steps: FunnelStep[] | null; windowSeconds: number; segmentId: number | null },
): boolean {
  if (patch.steps !== undefined) {
    // `current.steps` is null only when the stored row failed to parse
    // (StoredDefinitionError territory) — there is nothing to compare
    // against, so err toward the old, safe behaviour and treat it as changed.
    if (current.steps === null || !stepsEqual(patch.steps, current.steps)) return true
  }
  if (patch.windowSeconds !== undefined && patch.windowSeconds !== current.windowSeconds)
    return true
  if (patch.segmentId !== undefined && patch.segmentId !== current.segmentId) return true
  return false
}

/**
 * The two range columns as one value, or null.
 *
 * Both or neither, enforced here rather than trusted: a half-known range is
 * not a range, and a caller that could receive `since` without `until` would
 * have to invent the missing half or render something incomplete. NULL is the
 * honest answer for a row summarised before migration 016, which genuinely
 * does not know what it ran over.
 */
function lastRangeOf(row: Row): { since: string; until: string } | null {
  if (row.last_range_since == null || row.last_range_until == null) return null
  return { since: iso(row.last_range_since), until: iso(row.last_range_until) }
}

const iso = (v: Date | string): string => (v instanceof Date ? v.toISOString() : v)

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
  // `Date`, not `string`. node-postgres parses `timestamptz` into a JS Date,
  // and the sibling columns above are DECLARED `string | null` while actually
  // arriving as Dates -- harmless on the wire, because JSON.stringify turns a
  // Date into the same ISO string, but the declaration is not true. Rather
  // than inherit that, these two say what arrives and are normalised below.
  last_range_since: Date | string | null
  last_range_until: Date | string | null
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
      lastRange: lastRangeOf(row),
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
      lastRange: lastRangeOf(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  async list(projectId: number): Promise<ListedFunnel[]> {
    const r = await this.pool.query<Row>(
      `SELECT id, name, definition_version, steps, window_seconds, segment_id,
              last_entered, last_converted, last_evaluated_at,
              last_range_since, last_range_until, created_at, updated_at
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
              last_entered, last_converted, last_evaluated_at,
              last_range_since, last_range_until, created_at, updated_at
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
              last_entered, last_converted, last_evaluated_at,
              last_range_since, last_range_until, created_at, updated_at
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
                   last_entered, last_converted, last_evaluated_at,
              last_range_since, last_range_until, created_at, updated_at`,
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
   * Changing what the definition actually MEASURES clears the snapshot in
   * the same transaction; renaming does not — and, critically, neither does
   * re-sending fields that merely carry the same value they already had.
   * The web UI always sends the whole definition on every save, so "did the
   * patch mention `steps`" is not the same question as "did `steps` change",
   * and only the second one should ever discard a summary that is still
   * accurate. See `definitionChanged` for the comparison itself.
   *
   * That comparison needs the row as it stands right now, so this reads it
   * with `FOR UPDATE` inside the same transaction as the write — otherwise a
   * concurrent PATCH could be diffed against a definition that is no longer
   * current by the time this one writes.
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
    const client = await this.pool.connect()
    try {
      // Plain BEGIN, not SERIALIZABLE. The row lock from `FOR UPDATE` below
      // is already enough: it makes a second concurrent PATCH block until
      // the first commits, then re-read the now-current row, which is
      // exactly the guarantee `definitionChanged` needs. SERIALIZABLE adds
      // nothing on top of that here — only a 40001 serialization_failure
      // that the route does not special-case, so it surfaces as a 503. That
      // was measured: 8 concurrent PATCHes to one funnel returned 67/80
      // 503s under SERIALIZABLE, and 80/80 200s under plain BEGIN, across
      // repeated trials.
      await client.query('BEGIN')

      const existing = await client.query<Row>(
        `SELECT id, name, definition_version, steps, window_seconds, segment_id,
                last_entered, last_converted, last_evaluated_at,
              last_range_since, last_range_until, created_at, updated_at
           FROM funnels WHERE project_id = $1 AND id = $2 FOR UPDATE`,
        [projectId, id],
      )
      const existingRow = existing.rows[0]
      if (!existingRow) {
        await client.query('ROLLBACK')
        return null
      }

      const parsedCurrentSteps = StoredSteps.safeParse(existingRow.steps)
      const resetsSummary = definitionChanged(patch, {
        steps: parsedCurrentSteps.success ? parsedCurrentSteps.data : null,
        windowSeconds: existingRow.window_seconds,
        segmentId: existingRow.segment_id === null ? null : Number(existingRow.segment_id),
      })

      const r = await client.query<Row>(
        `UPDATE funnels SET
           name              = COALESCE($3, name),
           steps             = COALESCE($4::jsonb, steps),
           window_seconds    = COALESCE($5, window_seconds),
           segment_id        = CASE WHEN $6 THEN $7 ELSE segment_id END,
           last_entered      = CASE WHEN $8 THEN NULL ELSE last_entered END,
           last_converted    = CASE WHEN $8 THEN NULL ELSE last_converted END,
           last_evaluated_at = CASE WHEN $8 THEN NULL ELSE last_evaluated_at END,
           -- Cleared with the counts, never separately. A stored range
           -- describes the definition it was computed from exactly as much as
           -- the counts do (012's own note), so leaving it behind would put a
           -- precise-looking window on numbers that no longer exist -- which
           -- reads MORE authoritative than the bare stale number this clause
           -- already exists to prevent.
           last_range_since  = CASE WHEN $8 THEN NULL ELSE last_range_since END,
           last_range_until  = CASE WHEN $8 THEN NULL ELSE last_range_until END,
           updated_at        = now()
         WHERE project_id = $1 AND id = $2
         RETURNING id, name, definition_version, steps, window_seconds, segment_id,
                   last_entered, last_converted, last_evaluated_at,
              last_range_since, last_range_until, created_at, updated_at`,
        [
          projectId,
          id,
          patch.name ?? null,
          patch.steps ? JSON.stringify(patch.steps) : null,
          patch.windowSeconds ?? null,
          patch.segmentId !== undefined,
          patch.segmentId ?? null,
          resetsSummary,
        ],
      )
      await client.query('COMMIT')
      const row = r.rows[0]
      return row ? this.#hydrate(row) : null
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* connection is already gone */
      }
      if ((err as { code?: string } | null)?.code === UNIQUE_VIOLATION) {
        throw new DuplicateFunnelNameError()
      }
      throw err
    } finally {
      client.release()
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
  /**
   * `range` is REQUIRED, not optional, and that is the whole of #91: the
   * summary used to be written after every run regardless of what it ran over,
   * so a list rendering the rate beside its timestamp was answering a question
   * nobody could see. A caller that has counts necessarily has the range that
   * produced them, so there is no case where making this optional would help
   * and one where it would let the defect back in.
   */
  async recordRun(
    projectId: number,
    id: number,
    run: { entered: number; converted: number; at: Date; range: { since: Date; until: Date } },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE funnels SET last_entered = $3, last_converted = $4, last_evaluated_at = $5,
                          last_range_since = $6, last_range_until = $7
         WHERE project_id = $1 AND id = $2`,
      [
        projectId,
        id,
        run.entered,
        run.converted,
        run.at.toISOString(),
        run.range.since.toISOString(),
        run.range.until.toISOString(),
      ],
    )
  }
}
