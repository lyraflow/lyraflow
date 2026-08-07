import type { Pool, PoolClient } from '@lyraflow/db'

/**
 * The Postgres-side boundary derivation, for the read paths that must not go
 * through the ClickHouse dictionary at all.
 *
 * `GET /v1/persons/:id` and the export deliberately bypass the dictionaries
 * for zero identity lag (Plan 2's decision — a profile opened seconds after
 * identify() must be right). Routing their suppression check through a
 * dictionary with a 1-5s LIFETIME would put that lag straight back, on the
 * one path where the answer is a person's own data. Reading Postgres directly
 * also means a just-deleted person becomes invisible IMMEDIATELY, with no
 * reload and no sleep.
 */
export class SuppressionStore {
  constructor(private readonly pool: Pool) {}

  /**
   * The strictest boundary any member of this alias group carries, or null if
   * none does.
   *
   * MIN, not MAX. A group is a canonical plus every id merged into it, and
   * each could have been deleted at a different time; the earliest instant
   * hides everything every one of those requests asked to hide. MAX would
   * quietly reveal events an earlier request had already erased — and the
   * whole point of resolving to the canonical at request time is that a merge
   * cannot undo a deletion.
   *
   * Both parameters are bound: `personIds` traces back to a caller-supplied
   * URL path segment through alias resolution.
   */
  async boundaryFor(projectId: number, personIds: string[]): Promise<Date | null> {
    if (personIds.length === 0) return null
    const r = await this.pool.query<{ boundary: Date | null }>(
      `SELECT min(suppressed_at) AS boundary
         FROM suppressed_persons
        WHERE project_id = $1 AND person_id = ANY($2)`,
      [projectId, personIds],
    )
    return r.rows[0]?.boundary ?? null
  }

  /**
   * Writes or advances a person's boundary, returning the value now stored.
   *
   * Takes a `PoolClient` as well as a `Pool` so the deletion route can run it
   * inside the same transaction as the deletion_requests insert — the two
   * rows land together or not at all.
   *
   * GREATEST, so a repeat deletion moves the boundary FORWARD and an
   * out-of-order write cannot rewind it. A plain `DO UPDATE SET suppressed_at
   * = EXCLUDED.suppressed_at` would let a retried or delayed request un-hide
   * data the newer one had already hidden.
   *
   * The row is never deleted, including after the purge finishes — see
   * 005_suppression.sql for why (restoring an older backup of the event store
   * must not resurrect a deleted person).
   */
  async upsert(
    client: Pool | PoolClient,
    projectId: number,
    personId: string,
    at: Date,
  ): Promise<Date> {
    const r = await client.query<{ suppressed_at: Date }>(
      `INSERT INTO suppressed_persons (project_id, person_id, suppressed_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (project_id, person_id)
       DO UPDATE SET suppressed_at = GREATEST(suppressed_persons.suppressed_at, EXCLUDED.suppressed_at)
       RETURNING suppressed_at`,
      [projectId, personId, at],
    )
    // The RETURNING row always exists: ON CONFLICT DO UPDATE returns the
    // updated row, unlike DO NOTHING, which returns none.
    return r.rows[0]?.suppressed_at as Date
  }
}
