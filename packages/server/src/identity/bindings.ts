import type { Pool } from '@lyraflow/db'

/**
 * Cap on the device→person memo. identify() runs on every page load, so this
 * absorbs the repeat case without touching Postgres — but anonymous_id
 * arrives through an endpoint authenticated by a write key that is public by
 * design, so the memo must be bounded like everything else reachable from
 * ingest (see ProjectCache's MAX_NEGATIVE_ENTRIES for the same reasoning
 * applied to a different cache).
 */
export const MAX_CACHED_BINDINGS = 10_000

/**
 * The one and only place this conflict resolution is expressed, and the
 * single source of truth every write goes through.
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
  -- comparable at all.
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
    const settled = result.rows[0]?.person_id ?? personId
    this.#remember(key, settled)
    return result.rows.length > 0 ? 'written' : 'noop'
  }

  /**
   * Every id that resolves to this person — the canonical id plus each bound
   * device. Single-person reads use this instead of the ClickHouse dictionary
   * (which is refreshed on a schedule), so they see the effect of an
   * identify() immediately rather than after the next refresh.
   *
   * Deliberately ignorant of person_aliases: this class owns identity_bindings
   * only. A caller who needs the full alias-merged group (every id that was
   * ever merged INTO `personId` via PersonAliases, not just devices bound
   * directly to it) must resolve that group first and pass every member's id
   * through {@link devicesForAny} — see identity/person.ts's read route,
   * which is the one place that composes the two. `personId` here is treated
   * as a single opaque id, not necessarily a canonical: this method makes no
   * assumption about aliasing either way.
   */
  async personIdsFor(projectId: number, personId: string): Promise<string[]> {
    const r = await this.pool.query<{ anonymous_id: string }>(
      `SELECT DISTINCT anonymous_id FROM identity_bindings
        WHERE project_id = $1 AND person_id = $2`,
      [projectId, personId],
    )
    return [personId, ...r.rows.map((x) => x.anonymous_id)]
  }

  /**
   * The plural counterpart to {@link personIdsFor}: every device bound to
   * *any* of the given person ids, in one round trip. Exists for a caller
   * that already has more than one person id in hand — e.g. a whole
   * alias-merged group (a canonical plus every id merged into it) — and
   * wants their combined device set without one personIdsFor call per
   * member. Does not prefix the input ids onto the result the way
   * personIdsFor does; the caller already has them.
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
