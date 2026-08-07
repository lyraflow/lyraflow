import type { BindEvent } from '@lyraflow/core'
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
 * Nothing else absorbs the repeat page load either — it is a known,
 * documented cost, not a mitigated one. See the GROWTH CHARACTERISTIC note on
 * IdentityBindings below, and BIND_SQL's docstring for the write-side
 * suppression that was tried and reverted.
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
 * WHY THERE IS NO WRITE-SIDE DEDUPLICATION HERE, and why adding one is
 * harder than it looks. Read this before trying again.
 *
 * Every identified page load writes a row (see GROWTH CHARACTERISTIC on the
 * class below for what that costs). The obvious mitigation is to skip the
 * insert when the person "already in force" on the device at this event's
 * instant is the one being bound — such an event tiles as a boundary between
 * two tiles owned by the same person, so at the moment of the write it is
 * genuinely invisible to every lookup.
 *
 * That was implemented, reviewed, and reverted. It is not order-invariant,
 * and order-invariance is the entire reason this table stores bind events
 * rather than ranges (see 003_identity.sql, and the class docstring below).
 * "Invisible now" is not "invisible later": a subsequent insert can split the
 * very tile whose interior the suppressed event was sitting in, and the
 * suppressed event is no longer there to reclaim the far side. Reachable
 * through the public /v1/identify endpoint, with no unusual input:
 *
 *   1. identify(alice) @10:00        -> written.        rows: alice@10
 *   2. identify(alice) @20:00        -> alice in force  rows: alice@10
 *                                       at 20:00, so
 *                                       SUPPRESSED.
 *   3. identify(bob)   @15:00 (late) -> bob != alice    rows: alice@10, bob@15
 *                                       at 15:00, so
 *                                       written.
 *
 * Tiling: alice[-inf,15), bob[15,+inf). Every event from 20:00 onward now
 * resolves to bob — permanently, silently, and with no row anywhere recording
 * that alice ever took the device back. With step 2 stored, the tiling is
 * alice[-inf,15), bob[15,20), alice[20,+inf), which is correct.
 *
 * This is the exact mirror of the hazard that (correctly) ruled out the even
 * cheaper "compare against the device's most recent bind" variant. Any future
 * attempt must be order-invariant under arbitrary later inserts, which a
 * point-in-time comparison at write time cannot be. Deduplicating downstream
 * — collapsing adjacent same-person tiles inside
 * identity_bindings_dict_src, where the whole event set is visible at once —
 * is the direction that can work; the derivation there already sees every
 * event, so it cannot be surprised by a later one.
 */
// Only actually rewrites (and returns) the row when the conflict resolution
// changes something: a repeat identify for the person already bound at this
// instant is a genuine no-op, but a colliding *different* person at the same
// instant always re-resolves via LEAST, even on the rare occasion that
// re-resolution happens to land back on the value already stored. Postgres
// omits a row from RETURNING when its DO UPDATE ... WHERE evaluates false,
// which is exactly how `bind()` below tells 'written' from 'noop' without a
// second round trip.
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
  VALUES ($1, $2, $3, date_trunc('millisecond', $4::timestamptz))
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
 * and no read-modify-write race to guard against. Nothing in this class may
 * decide what to write by inspecting what is already there — that is exactly
 * what reintroduces order-dependence, and it is what sank the write-side
 * suppression documented on BIND_SQL.
 *
 * GROWTH CHARACTERISTIC, unmitigated and deliberately so. Every identify()
 * carrying an anonymous_id writes a row, including the repeat identify a
 * logged-in browser sends on every page load. A client that omits
 * `timestamp` gets server receipt time, so those repeats never collide on
 * (device, instant) and never deduplicate. At 100k identified pageviews/day
 * that is 100k rows/day, growing without bound, and each row is carried
 * through identity_bindings_dict_src's window function and into every
 * dictionary reload — which LIFETIME(MIN 5 MAX 15) performs every 5-15
 * seconds, rebuilding the whole range-hashed layout each time. Operators
 * sending high identified volume should expect this table to be the fastest
 * growing thing in their Postgres, and should watch dictionary reload time
 * alongside it. Mitigating it safely means collapsing adjacent same-person
 * tiles in the derivation, where the full event set is visible; see
 * BIND_SQL's docstring for why the write-side version is not an option.
 */
export class IdentityBindings {
  // Keyed on (project, device, instant) → the person last confirmed bound at
  // that exact triple. The instant is part of the key, not just the device,
  // because a different instant is a genuinely different bind event that
  // must always reach Postgres — the memo may only skip a write when the
  // *same* person is already bound at the *same* instant, which is the only
  // claim that stays true no matter what else is written afterwards.
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
    // longer holds it. When no row comes back, the WHERE guard has already
    // confirmed the stored value equals `personId`, so that is safe to cache
    // directly.
    //
    // Both branches share the property that makes this memo safe at all: the
    // cached value describes a row that DOES exist, at the exact instant in
    // the key. A memo entry recording "this person would be the answer here"
    // for an instant with no row behind it would not be — "the person in
    // force at t" changes when a bind lands between the cached instant and
    // t, so a later hit could return a stale 'noop' while the SQL would
    // actually write. That is one of the reasons the reverted write-side
    // suppression (see BIND_SQL) could not simply be cached through.
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

  /**
   * Every bind event on each of the given devices, ordered, keyed by device.
   *
   * Deliberately returns binds to ALL people, not only the caller's person.
   * A device's windows are defined by its whole bind sequence: the bind that
   * hands it to someone else is exactly what closes the previous owner's
   * window. Filtering to one person would leave every window open to
   * infinity, which is the union behaviour this exists to replace.
   *
   * `boundAt` is epoch milliseconds, matching @lyraflow/core's BindEvent, so
   * the result can be handed to deriveTiling unchanged.
   */
  async bindEventsForDevices(
    projectId: number,
    anonymousIds: string[],
  ): Promise<Map<string, BindEvent[]>> {
    const out = new Map<string, BindEvent[]>()
    if (anonymousIds.length === 0) return out
    const r = await this.pool.query<{ anonymous_id: string; person_id: string; bound_at: Date }>(
      `SELECT anonymous_id, person_id, bound_at FROM identity_bindings
        WHERE project_id = $1 AND anonymous_id = ANY($2)
        ORDER BY anonymous_id ASC, bound_at ASC, person_id ASC`,
      [projectId, anonymousIds],
    )
    for (const row of r.rows) {
      const list = out.get(row.anonymous_id) ?? []
      list.push({ personId: row.person_id, boundAt: row.bound_at.getTime() })
      out.set(row.anonymous_id, list)
    }
    return out
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
