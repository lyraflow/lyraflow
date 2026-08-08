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

  /**
   * `upsert`, fanned out over a whole set of ids at once — one row per id,
   * all carrying the same boundary instant `at`, in a single statement.
   *
   * Why a set at all: `resolvedPersonExpr` (the read-side identity
   * resolution every ClickHouse query goes through) only reaches a person's
   * CANONICAL id through the `identity_bindings`/`person_aliases`
   * dictionaries — and the purge's final step deletes exactly those rows.
   * Once it has run, an id merged away before the deletion, or a device that
   * was never bound to anyone else, has no dictionary path back to the
   * canonical any more: an event recorded under that id resolves to ITSELF
   * (dictGetOrDefault's fallback), not to the canonical. A suppression row
   * keyed only on the canonical therefore misses it. Writing a row for every
   * id the deletion request actually covers — canonical, every id merged
   * into it, and every device — means each of those self-fallback
   * resolutions still lands on a row that is there, with no dictionary hop
   * required. See `deletion-store.ts`'s `request` for the caller that
   * assembles that set.
   *
   * Same GREATEST-not-overwrite behaviour as `upsert`, applied per id
   * independently: an id that already carried a LATER boundary from an
   * earlier, unrelated deletion (e.g. a device since reused and suppressed
   * again under a different person) keeps its own later value rather than
   * being rewound by this write.
   *
   * Returns the stored boundary for every id, keyed by id, so a caller that
   * needs one particular id's value (the canonical's, for the API response)
   * can read it out of the map without a second round trip.
   *
   * Takes a `Pool` as well as a `PoolClient` for the same reason `upsert`
   * does: `DeletionStore.request` runs this inside the transaction that also
   * writes the `deletion_requests` row.
   *
   * `personIds` is deduplicated before it reaches SQL: a PostgreSQL
   * `INSERT ... ON CONFLICT DO UPDATE` errors ("ON CONFLICT DO UPDATE
   * command cannot affect row a second time") if the same conflict target
   * appears twice in one statement's affected rows. `PersonScope.ids` is
   * already deduplicated by its own contract, but this method has its own
   * caller-facing contract to keep regardless of what any particular caller
   * guarantees.
   */
  async upsertMany(
    client: Pool | PoolClient,
    projectId: number,
    personIds: string[],
    at: Date,
  ): Promise<Map<string, Date>> {
    const ids = Array.from(new Set(personIds))
    if (ids.length === 0) return new Map()
    const r = await client.query<{ person_id: string; suppressed_at: Date }>(
      `INSERT INTO suppressed_persons (project_id, person_id, suppressed_at)
       SELECT $1, unnest($2::text[]), $3::timestamptz
       ON CONFLICT (project_id, person_id)
       DO UPDATE SET suppressed_at = GREATEST(suppressed_persons.suppressed_at, EXCLUDED.suppressed_at)
       RETURNING person_id, suppressed_at`,
      [projectId, ids, at],
    )
    return new Map(r.rows.map((row) => [row.person_id, row.suppressed_at]))
  }
}
