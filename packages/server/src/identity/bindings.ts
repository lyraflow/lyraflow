import type { Pool } from '@lyraflow/db'

/**
 * Cap on the device→person memo.
 *
 * NOT what absorbs the repeat page load, despite what this comment used to
 * claim. The memo is keyed on (project, device, *instant*), and `bind()`'s
 * instant is the event's own timestamp — which, for the overwhelmingly
 * common client that omits `timestamp`, is server receipt time and therefore
 * distinct on every single request. So the memo misses by construction for
 * exactly the case it was described as covering. What it does still cover is
 * a genuinely identical bind event submitted twice: a retry of a request
 * that carried an explicit `timestamp`, or a replayed batch.
 *
 * The repeat page load is suppressed one layer down instead, in Postgres —
 * see BIND_SUPPRESSION_CLAUSE.
 *
 * Bounded regardless of how often it hits: anonymous_id arrives through an
 * endpoint authenticated by a write key that is public by design, so any map
 * keyed on it must be capped like everything else reachable from ingest (see
 * ProjectCache's MAX_NEGATIVE_ENTRIES for the same reasoning applied to a
 * different cache).
 */
export const MAX_CACHED_BINDINGS = 10_000

/**
 * The single source of truth every write in this package goes through.
 *
 * Not the only place the clause's text appears, and it cannot be: it is also
 * quoted in 003_identity.sql's comment on the UNIQUE constraint it depends
 * on, and restated as executable SQL in packages/db's schema-identity.test.ts.
 * packages/db cannot import packages/server — the TypeScript project
 * reference runs server→db, and reversing it would be a cycle `tsc -b`
 * rejects — so that duplication is structural rather than an oversight. Treat
 * the DB-side test as an independent restatement of the same resolution: it
 * pins the clause against the schema without this module, and drifting apart
 * from it is what it exists to catch.
 *
 * `LEAST` is `min`: commutative and idempotent, so two persons colliding on
 * the same instant converge to the same stored row whichever order they
 * arrive — the property two rounds of review spent fixing at the schema
 * level (see 003_identity.sql and `deriveTiling`'s tie-break in
 * @lyraflow/core, which mirrors this exact resolution). Swapping this for
 * `DO NOTHING` (first-writer-wins) or `person_id = EXCLUDED.person_id`
 * (last-writer-wins) would silently reintroduce that order-dependence, and
 * nothing in the schema itself would catch it — only this module's tests do
 * (see bindings.test.ts, "resolves a same-instant collision...").
 */
export const BIND_CONFLICT_CLAUSE = `ON CONFLICT (project_id, anonymous_id, bound_at)
DO UPDATE SET person_id = LEAST(identity_bindings.person_id, EXCLUDED.person_id)`

/**
 * Keeps identity_bindings from growing one row per identify() call forever.
 *
 * Without it, every identified page load writes a row: the memo above cannot
 * help (its key contains the instant, which differs per request), and nothing
 * else deduplicates. 100k identified pageviews/day is 100k rows/day in the
 * table, in identity_bindings_dict_src's window function, and in every
 * dictionary reload — and LIFETIME(MIN 5 MAX 15) reloads the whole thing into
 * a range-hashed layout every 5-15 seconds.
 *
 * The suppression rule is: skip the insert when the person ALREADY IN FORCE
 * on this device at this event's own instant is the person being bound.
 * Correct because `deriveTiling` (and the SQL view mirroring it) would tile
 * such an event as a boundary between two tiles owned by the SAME person —
 * the split is invisible to every lookup, so the row buys nothing.
 *
 * "In force at this instant", not "the device's most recent bind" — that
 * cheaper-sounding version is wrong for a late, out-of-order identify. With
 * bob bound at 10:00 and alice at 20:00, a late identify placing alice at
 * 15:00 must be written: it is genuinely new information (alice, not bob,
 * held the device from 15:00), and comparing against the most recent bind
 * (alice) would drop it and leave those five hours attributed to bob. See
 * bindings.test.ts's "writes a late, out-of-order identify whose instant
 * belongs to a different person".
 *
 * An event EARLIER than every stored bind is never suppressed by this clause
 * (the subquery finds no row and `IS DISTINCT FROM NULL` is true). That is
 * one redundant row in the rare case where the earliest stored bind is
 * already the same person; correctness is unaffected either way, and it keeps
 * the clause a single indexed lookup rather than a two-sided search.
 */
const BIND_SUPPRESSION_CLAUSE = `$3::text IS DISTINCT FROM (
    SELECT prev.person_id
      FROM identity_bindings prev
     WHERE prev.project_id = $1::bigint
       AND prev.anonymous_id = $2::text
       AND prev.bound_at <= date_trunc('millisecond', $4::timestamptz)
     ORDER BY prev.bound_at DESC
     LIMIT 1
  )`

// INSERT ... SELECT ... WHERE rather than VALUES, so BIND_SUPPRESSION_CLAUSE
// can gate the insert without a second round trip.
//
// The ON CONFLICT below only actually rewrites (and returns) the row when the
// conflict resolution changes something: a repeat identify for the person
// already bound at this instant is a genuine no-op, but a colliding
// *different* person at the same instant always re-resolves via LEAST, even
// on the rare occasion that re-resolution happens to land back on the value
// already stored. Postgres omits a row from RETURNING when its
// DO UPDATE ... WHERE evaluates false — and equally when the SELECT above
// produced no row at all — which is how `bind()` below tells 'written' from
// 'noop' without asking again.
const BIND_SQL = `
  INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
  -- bound_at truncated to millisecond precision explicitly: Bound (in
  -- @lyraflow/core) is epoch milliseconds, but timestamptz carries
  -- microsecond precision. Anything that ever fed this column a value with a
  -- non-zero microsecond remainder would be storing a row deriveTiling could
  -- never produce, since its ms-resolution Bound can't represent the
  -- difference — truncating here is what keeps the two derivations
  -- comparable at all. 003_identity.sql carries the same rule as a CHECK, so
  -- a backfill or a SQL-level import cannot bypass this statement and desync
  -- the two.
  SELECT $1::bigint, $2::text, $3::text, date_trunc('millisecond', $4::timestamptz)
  WHERE ${BIND_SUPPRESSION_CLAUSE}
  ${BIND_CONFLICT_CLAUSE}
  WHERE identity_bindings.person_id <> EXCLUDED.person_id
  RETURNING person_id
`

/**
 * Records bind events and answers the identity-scoped reads the write path
 * itself needs to stay correct.
 *
 * Each `bind()` call is a single idempotent upsert — not a transaction that
 * reads existing rows, computes a diff, and applies it. That is the point of
 * storing bind events rather than ranges (see 003_identity.sql): a set of
 * events has no order, so there is nothing here for arrival order to disturb,
 * and no read-modify-write race to guard against.
 */
export class IdentityBindings {
  // Keyed on (project, device, instant) → the person last confirmed bound at
  // that exact triple. The instant is part of the key, not just the device,
  // because a different instant is a new bind event that must always reach
  // Postgres — the memo may only skip a write when the *same* person is
  // already bound at the *same* instant.
  #cache = new Map<string, string>()
  readonly #cacheMax: number

  constructor(
    private readonly pool: Pool,
    opts?: { cacheMax?: number },
  ) {
    // Validated rather than taken on trust, for the same reason
    // dictionaries.ts validates `port`: a NaN here does not fail loudly, it
    // fails silently and in the worst possible direction. `#remember`'s
    // eviction loop is `while (size >= this.#cacheMax)`, and `size >= NaN` is
    // always false — so a NaN cap disables eviction entirely and turns a
    // deliberately bounded cache, keyed on an id supplied through a public
    // write key, into an unbounded one. A zero or negative cap is rejected
    // too: it would evict on every write, leaving a cache that can never hold
    // anything.
    if (opts?.cacheMax !== undefined && (!Number.isInteger(opts.cacheMax) || opts.cacheMax < 1)) {
      throw new Error(
        `IdentityBindings: cacheMax must be a positive integer, got ${String(opts.cacheMax)}`,
      )
    }
    this.#cacheMax = opts?.cacheMax ?? MAX_CACHED_BINDINGS
  }

  get cacheSize(): number {
    return this.#cache.size
  }

  async bind(
    projectId: number,
    anonymousId: string,
    personId: string,
    at: Date,
  ): Promise<'noop' | 'written'> {
    const atMs = Math.trunc(at.getTime())
    const key = `${projectId}:${anonymousId}:${atMs}`
    if (this.#cache.get(key) === personId) return 'noop'

    const result = await this.pool.query<{ person_id: string }>(BIND_SQL, [
      projectId,
      anonymousId,
      personId,
      new Date(atMs),
    ])

    // A row comes back only when the upsert actually changed something. When
    // it did, cache the value Postgres actually settled on — which, on a
    // same-instant collision this call lost, is the *other* person's id, not
    // the one passed in. Caching the argument instead would let a later call
    // with the losing id read back a false 'noop' against a row that no
    // longer holds it.
    //
    // No row means one of the two no-op paths, and `personId` is the right
    // thing to cache on both: either the ON CONFLICT guard confirmed the row
    // at this instant already holds `personId`, or BIND_SUPPRESSION_CLAUSE
    // confirmed `personId` is the person in force at this instant. In both
    // cases an identical repeat of this call is a no-op again.
    const settled = result.rows[0]?.person_id ?? personId
    this.#remember(key, settled)
    return result.rows.length > 0 ? 'written' : 'noop'
  }

  /**
   * Given a DEVICE id, the person it currently belongs to, or null if this
   * id was never a device in this project — the inverse direction of
   * {@link devicesForAny}.
   *
   * Exists because `GET /v1/persons/:id` documents `:id` as "any id that has
   * ever pointed at this person — a device id, the current canonical id, or
   * an id since merged away", and every other lookup it composes
   * (canonicalFor, mergedFrom, devicesForAny) is keyed on person_id. Without
   * this, a device id resolved to itself and the route answered a
   * plausible-looking, silently wrong 200 for a person that does not exist.
   *
   * AMBIGUITY, decided and documented rather than left to Postgres's row
   * order: a device bound to several people over time (a shared laptop) has
   * no single right answer, so this returns the MOST RECENTLY bound one — the
   * device's current owner, which is what "who is using this browser" means
   * to a caller holding only a device id. 404, or the union of all of them,
   * would be defensible too, but not more so, and both are worse to consume.
   * `ORDER BY bound_at DESC` is already total for one device
   * (003_identity.sql's UNIQUE (project_id, anonymous_id, bound_at) admits
   * exactly one row per instant), so this is deterministic without a
   * tie-break; `person_id` is named as a secondary key anyway so that stays
   * true if that constraint is ever relaxed.
   *
   * Both parameters are bound, never interpolated: `anonymousId` traces back
   * to a caller-supplied URL path segment.
   */
  async mostRecentPersonFor(projectId: number, anonymousId: string): Promise<string | null> {
    const r = await this.pool.query<{ person_id: string }>(
      `SELECT person_id FROM identity_bindings
        WHERE project_id = $1 AND anonymous_id = $2
        ORDER BY bound_at DESC, person_id ASC
        LIMIT 1`,
      [projectId, anonymousId],
    )
    return r.rows[0]?.person_id ?? null
  }

  /**
   * Every device bound to *any* of the given person ids, in one round trip.
   * Takes a set rather than a single person because its only caller
   * (identity/person.ts's read route) always has a whole alias-merged group
   * in hand — a canonical plus every id merged into it — and needs their
   * combined device set without one query per member.
   *
   * Does not prefix the input ids onto the result; the caller already has
   * them, and treats them and the returned devices as one flat id set.
   *
   * Deliberately ignorant of person_aliases: this class owns
   * identity_bindings only. Resolving which ids belong in `personIds` is
   * PersonAliases' job, and identity/person.ts is the one place that
   * composes the two.
   */
  async devicesForAny(projectId: number, personIds: string[]): Promise<string[]> {
    if (personIds.length === 0) return []
    const r = await this.pool.query<{ anonymous_id: string }>(
      `SELECT DISTINCT anonymous_id FROM identity_bindings
        WHERE project_id = $1 AND person_id = ANY($2)`,
      [projectId, personIds],
    )
    return r.rows.map((x) => x.anonymous_id)
  }

  /** LRU insert: `Map` iterates in insertion order, and every write re-inserts
   * its key, so the first key is always the least recently written. */
  #remember(key: string, personId: string): void {
    this.#cache.delete(key)
    while (this.#cache.size >= this.#cacheMax) {
      const oldest = this.#cache.keys().next()
      if (oldest.done) break
      this.#cache.delete(oldest.value)
    }
    this.#cache.set(key, personId)
  }
}
