/** One row of a member page. Context fields are added dynamically by field name. */
export interface MemberRow {
  person_id: string
  first_seen: string
  last_seen: string
  /** The person's traits, split by type exactly as `person_traits` stores
   * them, and capped at `TRAITS_PER_MEMBER_MAX` keys each. */
  traits: Record<string, string>
  traits_num: Record<string, number>
  /** How many traits the person actually has, which is not the size of the
   * two maps above when the cap bit. See `boundedTraitMap` in core. */
  trait_total: number
  /** The context columns `memberProjection` selects -- one per
   * `CONTEXT_FIELDS` entry. The record types are here only because an index
   * signature must cover every named member above it. */
  [field: string]: string | number | Record<string, string> | Record<string, number>
}

export interface CachedResult {
  count: number
  members: MemberRow[]
  /** The instant the underlying query described. Every page of one walk shares it. */
  asOf: string
}

export const CACHE_MAX_ENTRIES = 200
/**
 * The bound that actually holds memory down. The entry cap alone does not:
 * 200 entries at a full 1000-row window each is ~200k rows resident, and the
 * app container runs under a 512MB limit. Plan 1's OOM came from precisely
 * this shape — a meticulously bounded ingest buffer sitting behind an
 * unbounded project cache, where exhausting the cache caused the kill the
 * buffer's bound existed to prevent.
 */
export const CACHE_MAX_ROWS = 50_000
export const CACHE_TTL_MS = 30_000

interface Entry {
  value: CachedResult
  expiresAt: number
}

/**
 * In-process LRU with a TTL, bounded on entries AND on total member rows.
 *
 * Per-instance by design. This is a single-container self-hosted product; a
 * shared cache would mean a table, a reaper job, and a write on a read path
 * for a deployment that runs exactly one instance. Cloud revisits it when
 * there is a second.
 *
 * Its purpose is snapshot consistency more than speed: ten pages served from
 * ten separate aggregations can disagree with each other, while ten pages
 * served from one cached snapshot cannot. It stores no errors, and a hit must
 * be indistinguishable from a miss in the response body.
 */
export class SegmentCache {
  readonly #entries = new Map<string, Entry>()
  #rows = 0
  // One counter per project that has ever had `clearProject()` called on it
  // — bounded by the number of DISTINCT projects a deletion has ever run
  // against, the same shape (and the same "stays small for a self-hosted,
  // one-tenant-per-project product" argument) as every other per-project
  // in-memory map in this codebase (e.g. ProjectCache's own entries). See
  // `set()`'s docstring for what this guards.
  readonly #generations = new Map<number, number>()

  get size(): number {
    return this.#entries.size
  }

  get rows(): number {
    return this.#rows
  }

  /**
   * The project's current generation — 0 until `clearProject()` has run for
   * it at least once. A caller about to issue the query behind a cache MISS
   * captures this BEFORE issuing it (`routes.ts`'s `runTree`), and passes it
   * back to `set()` once the query resolves — see `set()`'s own docstring
   * for why that round trip is what closes the race `clearProject()` alone
   * cannot.
   */
  generation(projectId: number): number {
    return this.#generations.get(projectId) ?? 0
  }

  get(key: string): CachedResult | undefined {
    const hit = this.#entries.get(key)
    if (!hit) return undefined
    if (hit.expiresAt <= Date.now()) {
      this.#drop(key)
      return undefined
    }
    // Re-insert to move it to the most-recent end: Map iterates in insertion
    // order, so the first key is always the least recently used.
    this.#entries.delete(key)
    this.#entries.set(key, hit)
    return hit.value
  }

  /**
   * `projectId`/`generation` are not optional bookkeeping — they are what
   * stops a query that started BEFORE a `clearProject()` call from
   * re-poisoning the cache by finishing and calling `set()` AFTER it.
   * `clearProject()` alone only handles entries that already exist at the
   * instant it runs; it cannot reach into a `runTree()` call that is still
   * mid-flight against ClickHouse, computing a count/member page against the
   * pre-deletion world, whose OWN `set()` call is still to come. Without this
   * check, that in-flight write lands after the clear and reinstates the
   * erased person's row for a fresh 30-second TTL — the exact failure
   * `clearProject()` exists to prevent, just arriving one request later.
   *
   * The caller captures `cache.generation(projectId)` before it issues its
   * query (a plain number, copied by value — there is nothing further to
   * keep in sync) and passes that same value back here. If `clearProject()`
   * has run for this project in between, the current generation has moved on
   * and this write is silently discarded: a result computed against a world
   * that no longer exists simply is not cached, rather than being cached for
   * the next 30 seconds regardless of the deletion that has already been
   * accepted.
   */
  set(key: string, value: CachedResult, projectId: number, generation: number): void {
    if (generation !== this.generation(projectId)) return
    this.#drop(key)
    // An entry bigger than the whole budget can never be stored without
    // violating the bound, so it is simply not cached. Refusing to store is
    // correct; evicting everything else to make room for it is not.
    if (value.members.length > CACHE_MAX_ROWS) return
    this.#entries.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    this.#rows += value.members.length
    this.#evict()
  }

  #drop(key: string): void {
    const existing = this.#entries.get(key)
    if (!existing) return
    this.#rows -= existing.value.members.length
    this.#entries.delete(key)
  }

  #evict(): void {
    while (this.#entries.size > CACHE_MAX_ENTRIES || this.#rows > CACHE_MAX_ROWS) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#drop(oldest.value)
    }
  }

  /**
   * Drops every entry for one project, regardless of TTL, AND bumps its
   * generation so a `set()` still in flight from before this call cannot
   * land afterward — see `set()`'s own docstring for that half. Called after
   * a deletion request is accepted (privacy/routes.ts), so a preview served
   * from cache can never hand back a person's row within the 30-second TTL
   * after the API has already promised — via the `202` — that their data
   * stops appearing immediately. Without the entry drop, `get()`'s own TTL
   * would be the only thing standing between a `DELETE` and a stale hit, and
   * without the generation bump a query racing that exact `DELETE` could
   * still reinstate one; 30 seconds of "stopped appearing" that in fact
   * still shows the erased person's own `first_seen`/`last_seen`/context row
   * is not a stale number, it is their personal data served back out after
   * the API said it would not be.
   *
   * Entry drop is project-scoped by key prefix, not a full clear: every key
   * this cache ever stores is `${projectId}:...` (both `countKey` and
   * `pageKey` in routes.ts), so a prefix match is exactly "every entry this
   * project could have written" with no separate per-entry project id to
   * maintain. Keys are snapshotted into an array before dropping any of them
   * — deleting the CURRENT key mid-iteration over a live `Map` iterator is
   * documented-safe, but taking a copy first removes any doubt without
   * relying on that.
   *
   * Two callers today, both wired in app.ts, both following the same rule:
   * call this the instant a project's underlying data actually changes in a
   * way a cached preview could disagree with, never speculatively. `DELETE
   * /v1/persons/:id` (privacy/routes.ts) calls it once a deletion is
   * accepted. The retention worker's `onDrop` hook calls it once a partition
   * is REALLY gone — never for a project whose sweep dropped nothing, so a
   * quiet run costs nothing. Anyone adding a third path that changes what a
   * segment preview could return should call this too, at the point that
   * change becomes real, not merely requested.
   */
  clearProject(projectId: number): void {
    this.#generations.set(projectId, this.generation(projectId) + 1)
    const prefix = `${projectId}:`
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#drop(key)
    }
  }
}
