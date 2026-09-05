export const SHARED_RUNS_PER_WINDOW = 120
export const SHARED_RUN_WINDOW_MS = 60_000
export const SHARED_MAX_IN_FLIGHT = 3
export const SHARED_CACHE_TTL_MS = 60_000
export const SHARED_CACHE_MAX_ENTRIES = 4096

/** Runs executing per key right now. Mirrors the UI's RunQueue cap so an
 *  unmodified client never sees it and a modified one cannot fan twelve
 *  retention grids at ClickHouse at once. Keys are only ever tokens that
 *  resolved to a dashboard, so the map is bounded by the number of shares. */
export class InFlightCap {
  #held = new Map<string, number>()
  constructor(private readonly limit: number = SHARED_MAX_IN_FLIGHT) {}
  acquire(key: string): boolean {
    const n = this.#held.get(key) ?? 0
    if (n >= this.limit) return false
    this.#held.set(key, n + 1)
    return true
  }
  release(key: string): void {
    const n = this.#held.get(key) ?? 0
    if (n <= 1) this.#held.delete(key)
    else this.#held.set(key, n - 1)
  }
  held(key: string): number {
    return this.#held.get(key) ?? 0
  }
}

/** Insertion-ordered TTL cache. `Map` keeps insertion order, and every
 *  `set` deletes before inserting so a refreshed key moves to the end;
 *  the first key in iteration order is therefore always the oldest write. */
export class ResultCache<T> {
  #entries = new Map<string, { value: T; expiresAt: number }>()
  readonly #ttlMs: number
  readonly #maxEntries: number
  readonly #now: () => number
  constructor(opts: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}) {
    this.#ttlMs = opts.ttlMs ?? SHARED_CACHE_TTL_MS
    this.#maxEntries = opts.maxEntries ?? SHARED_CACHE_MAX_ENTRIES
    this.#now = opts.now ?? Date.now
  }
  get(key: string): T | undefined {
    const e = this.#entries.get(key)
    if (!e) return undefined
    if (e.expiresAt <= this.#now()) {
      this.#entries.delete(key)
      return undefined
    }
    return e.value
  }
  set(key: string, value: T): void {
    this.#entries.delete(key)
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs })
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next()
      if (oldest.done) break
      this.#entries.delete(oldest.value)
    }
  }
  get size(): number {
    return this.#entries.size
  }
}
