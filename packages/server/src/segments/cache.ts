/** One row of a member page. Context fields are added dynamically by field name. */
export interface MemberRow {
  person_id: string
  first_seen: string
  last_seen: string
  [field: string]: string | number
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

  get size(): number {
    return this.#entries.size
  }

  get rows(): number {
    return this.#rows
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

  set(key: string, value: CachedResult): void {
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
   * Drops every entry for one project, regardless of TTL. Called after a
   * deletion request is accepted (privacy/routes.ts), so a preview served
   * from cache can never hand back a person's row within the 30-second TTL
   * after the API has already promised — via the `202` — that their data
   * stops appearing immediately. Without this, `get()`'s own TTL is the only
   * thing standing between a `DELETE` and a stale hit, and 30 seconds of
   * "stopped appearing" that in fact still shows the erased person's own
   * `first_seen`/`last_seen`/context row is not a stale number, it is their
   * personal data served back out after the API said it would not be.
   *
   * Project-scoped by key prefix, not a full clear: every key this cache
   * ever stores is `${projectId}:...` (both `countKey` and `pageKey` in
   * routes.ts), so a prefix match is exactly "every entry this project could
   * have written" with no separate per-entry project id to maintain. Keys
   * are snapshotted into an array before dropping any of them — deleting the
   * CURRENT key mid-iteration over a live `Map` iterator is documented-safe,
   * but taking a copy first removes any doubt without relying on that.
   */
  clearProject(projectId: number): void {
    const prefix = `${projectId}:`
    for (const key of [...this.#entries.keys()]) {
      if (key.startsWith(prefix)) this.#drop(key)
    }
  }
}
