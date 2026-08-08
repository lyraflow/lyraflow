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
   * MAX, not MIN — and which one is "strictest" is the opposite of what it
   * looks like, so read the comparison before changing this. Every consumer
   * keeps events with `timestamp > boundary`. A LATER boundary therefore
   * hides MORE, and the earliest instant in the group is the most permissive
   * value available, not the safest one.
   *
   * A group is a canonical plus every id merged into it, and each could have
   * been deleted at a different time. `max` is the only value that honours
   * ALL of those requests at once: it hides everything at or before the most
   * recent of them, which necessarily includes everything the earlier ones
   * asked to hide. `min` honours only the oldest request and quietly hands
   * back every event the later ones erased.
   *
   * That was not hypothetical. With `min`, deleting alice at T1 and bob at
   * T2 > T1 and then merging alice into bob — an ordinary `/v1/alias` call,
   * with no relationship to either deletion — dropped bob's boundary from T2
   * to T1 and UN-DELETED him: `GET /v1/persons/bob` went from `404` back to
   * `200`, and the export streamed his erased events back to the caller. The
   * merge cannot undo a deletion, and `max` is what makes that true.
   *
   * `max` is also what makes the two derivations agree, which matters more
   * here than either one taken alone. The ClickHouse side (`notSuppressedExpr`
   * against the `suppressed_persons` dictionary, dictionaries.ts) looks up the
   * RESOLVED person's own row — bob's, at T2 — so under `min` the two halves
   * of suppression disagreed about the same event, with the segment paths
   * hiding it correctly and the person read and export leaking it. Two
   * derivations that disagree are worse than either being wrong on its own:
   * whichever one an operator checks, the other is still lying.
   *
   * Both parameters are bound: `personIds` traces back to a caller-supplied
   * URL path segment through alias resolution.
   *
   * A COUPLING THAT IS CURRENTLY LOAD-BEARING AND UNSTATED ANYWHERE ELSE:
   * `suppressed_persons.suppressed_at` is Postgres `timestamptz`, which
   * carries microsecond precision — but node-postgres parses it into a JS
   * `Date`, which cannot represent anything finer than a millisecond, and it
   * TRUNCATES the extra digits rather than rounding them. So the boundary
   * this method hands back is `floor_ms(T)`, not `T` itself. The
   * ClickHouse-dictionary path (`suppressed_persons` dictionary,
   * dictionaries.ts) reads the same column at its full `DateTime64(6)`
   * precision and compares against it exactly. Callers of this method
   * (person.ts, export.ts) then bind the truncated `Date` back into
   * ClickHouse as `DateTime64(3)` via `chDateTime` — so the Postgres-side
   * boundary used for comparison is `floor_ms(T)` and the ClickHouse-side one
   * is the exact `T`.
   *
   * That mismatch is harmless only because of two independent facts, both of
   * which must keep holding: `events.timestamp` is itself `DateTime64(3,
   * 'UTC')` (002_events.sql), so every event instant already IS a whole
   * millisecond — there is no sub-millisecond instant that could fall
   * strictly between `floor_ms(T)` and `T` for either path to disagree
   * about. If the events column ever gains sub-millisecond precision, or if
   * node-postgres (or a future driver) ever rounded a `timestamptz` instead
   * of truncating it, the two halves of suppression would disagree by up to
   * one millisecond again — exactly the class of bug Task 11 and the
   * `DateTime64(6)` dictionary attribute (dictionaries.ts) exist to close on
   * the ClickHouse side alone.
   */
  async boundaryFor(projectId: number, personIds: string[]): Promise<Date | null> {
    if (personIds.length === 0) return null
    const r = await this.pool.query<{ boundary: Date | null }>(
      `SELECT max(suppressed_at) AS boundary
         FROM suppressed_persons
        WHERE project_id = $1 AND person_id = ANY($2)`,
      [projectId, personIds],
    )
    return r.rows[0]?.boundary ?? null
  }

  /**
   * Writes or advances a single person's boundary, returning the value now
   * stored. A thin, single-id convenience wrapper around `upsertMany` — see
   * that method for the actual SQL, the GREATEST direction, and the
   * transaction-sharing `Pool | PoolClient` parameter, all of which apply
   * here unchanged. Kept as its own method because most callers (every test
   * in this file bar the `upsertMany`-specific ones, and any future caller
   * suppressing exactly one id) read more plainly against a single id than
   * against a one-element array.
   *
   * The row is never deleted, including after the purge finishes — see
   * 005_suppression.sql for why (restoring an older backup of the event store
   * must not resurrect a deleted person) and `upsertMany`'s own docstring for
   * the one case where that guarantee does not reach far enough.
   */
  async upsert(
    client: Pool | PoolClient,
    projectId: number,
    personId: string,
    at: Date,
  ): Promise<Date> {
    const result = await this.upsertMany(client, projectId, [personId], at)
    // Always present: a non-empty `personIds` array always returns exactly
    // one row per (deduplicated) id it was given — see `upsertMany`.
    return result.get(personId) as Date
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
   * resolutions lands on a row that is there, with no dictionary hop
   * required, FOR AS LONG AS THE FALLBACK ACTUALLY FIRES. See
   * `deletion-store.ts`'s `request` for the caller that assembles that set.
   *
   * That qualifier is load-bearing, not decorative: it does NOT cover a
   * device rebound to a different person after the purge, with a backup
   * restored afterwards. `identity_bindings_dict_src` (003_identity.sql)
   * gives a device's first REMAINING bind row a retroactive `valid_from` of
   * epoch — by design, the same rule that lets a genuinely pre-bind
   * anonymous session attribute correctly. Once the purge has deleted the
   * erased person's binding, a later bind to someone else becomes that first
   * row, and a restored anonymous event on that device resolves to the NEW
   * person, not to the bare device id — so nothing ever consults the device
   * id's suppression row again, even though it is still sitting right there.
   * The erased person's anonymous history comes back, attributed to whoever
   * holds the device now. This is not a regression this method introduces —
   * the canonical-only implementation it replaces had exactly the same hole,
   * for exactly the same events, it just couldn't be blamed on THIS
   * mechanism specifically. Closing it needs either the suppression check to
   * consult the raw `anonymous_id` directly, or the purge to persist the
   * erased device's boundary somewhere the resolver reaches ahead of the
   * identity dictionary — both are design changes, out of scope here. It
   * needs all three of: the purge to have completed, that device later bound
   * to a DIFFERENT person, and a backup predating the deletion restored
   * afterwards. Identified events are unaffected regardless — they carry
   * their own `user_id` and stay suppressed through their own row.
   *
   * Same GREATEST-not-overwrite behaviour as `upsert` (in fact `upsert` now
   * calls this), applied per id independently: an id that already carried a
   * LATER boundary from an earlier, unrelated deletion (e.g. a device since
   * reused and suppressed again under a different person) keeps its own
   * later value rather than being rewound by this write.
   *
   * Returns the stored boundary for every id, keyed by id, so a caller that
   * needs one particular id's value (the canonical's, for the API response)
   * can read it out of the map without a second round trip.
   *
   * Takes a `Pool` as well as a `PoolClient` so `DeletionStore.request` can
   * run this inside the transaction that also writes the `deletion_requests`
   * row.
   *
   * `personIds` is deduplicated before it reaches SQL: a PostgreSQL
   * `INSERT ... ON CONFLICT DO UPDATE` errors ("ON CONFLICT DO UPDATE
   * command cannot affect row a second time") if the same conflict target
   * appears twice in one statement's affected rows. `PersonScope.ids` is
   * already deduplicated by its own contract, but this method has its own
   * caller-facing contract to keep regardless of what any particular caller
   * guarantees.
   *
   * Unlike `resolvePersonScope`'s `windows` (capped by
   * `MAX_PERSON_RANGE_CLAUSES` and chunked by every caller that walks them),
   * `personIds` here is NOT capped, and every row it writes is permanent —
   * suppressed_persons rows are never deleted (see above). A customer that
   * rotates `anonymous_id` per session turns one deletion into one row per
   * session that person ever had, forever; and because
   * `suppressed_persons_dict_src`'s dictionary is `COMPLEX_KEY_HASHED` with
   * an `invalidate_query` keyed on `count(*)`/`max(suppressed_at)`
   * (005_suppression.sql, dictionaries.ts), any write that changes either —
   * which this one always does — reloads the WHOLE table, not just the new
   * rows. Both are accepted consequences of this design, not defects; this
   * comment is the only place either is written down.
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
