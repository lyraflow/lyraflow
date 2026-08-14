export const LOGIN_MAX_ATTEMPTS = 10
export const LOGIN_WINDOW_MS = 15 * 60_000
/**
 * THREAT: `POST /v1/auth/login` is unauthenticated and, on any install with
 * a domain, internet-facing. Both of its keys are attacker-chosen -- the
 * source IP and the submitted email -- so an unbounded map here is an OOM
 * reachable by anyone who can reach the port, which is the same reasoning
 * ProjectCache's negative-entry bound is built on. Oldest-first eviction is
 * acceptable precisely because an attacker who evicts their own entry gains
 * nothing but the attempts they would have had anyway a window later.
 */
export const LOGIN_MAX_KEYS = 4096

/**
 * In-memory, per-process, and gone on restart -- correct for a
 * single-container product and stated as a limit rather than discovered as
 * one. It slows a password guesser; it is not a defence against a
 * distributed one, and the honest control for that is the password's own
 * entropy, which the installer generates.
 */
export class AttemptLimiter {
  // Every read and write below deletes a key before re-inserting it, so the
  // first key in iteration order is always the least recently used -- not
  // merely the first one ever recorded (the same guarantee ProjectCache's
  // #read/#store keep). That distinction is load-bearing: without it, a
  // blocked key that keeps getting re-recorded from a single IP would stay
  // pinned at the *front* of the order (its original insertion point) and
  // become the first thing evicted once the map fills, letting that IP
  // erase its own block just by continuing to hammer the endpoint. With it,
  // every re-record moves the key to the protected end, and escaping the
  // limit genuinely requires rotating source IPs, not just retrying.
  #hits = new Map<string, number[]>()

  constructor(
    private readonly maxAttempts: number = LOGIN_MAX_ATTEMPTS,
    private readonly windowMs: number = LOGIN_WINDOW_MS,
    private readonly maxKeys: number = LOGIN_MAX_KEYS,
  ) {}

  get size(): number {
    return this.#hits.size
  }

  #live(key: string): number[] {
    const cutoff = Date.now() - this.windowMs
    const kept = (this.#hits.get(key) ?? []).filter((t) => t > cutoff)
    // Delete before conditionally re-inserting: a key with live attempts
    // must move to the end of the iteration order on every read, exactly
    // as ProjectCache#read does, so a repeatedly-checked key is never the
    // "oldest" one evicted.
    this.#hits.delete(key)
    if (kept.length > 0) this.#hits.set(key, kept)
    return kept
  }

  /** False when ANY key is at or over the limit. */
  check(keys: readonly string[]): boolean {
    return keys.every((k) => this.#live(k).length < this.maxAttempts)
  }

  record(keys: readonly string[]): void {
    for (const key of keys) {
      const kept = this.#live(key)
      kept.push(Date.now())
      // Bounded by the same limit `check` enforces: a key already over the
      // limit that keeps getting recorded (a blocked IP that keeps
      // retrying) would otherwise grow this array for the rest of the
      // window. Only the most recent `maxAttempts` timestamps are ever
      // relevant to `check`, so older ones are dropped as soon as they are.
      if (kept.length > this.maxAttempts) kept.splice(0, kept.length - this.maxAttempts)
      // Delete before set again: #live() already refreshed the position
      // when there were live attempts, but when the key had fully expired
      // #live() deleted it outright, so this insert is what lands the
      // newly recorded key at the end of the order.
      this.#hits.delete(key)
      this.#hits.set(key, kept)
      while (this.#hits.size > this.maxKeys) {
        const oldest = this.#hits.keys().next().value
        if (oldest === undefined) break
        this.#hits.delete(oldest)
      }
    }
  }

  reset(keys: readonly string[]): void {
    for (const key of keys) this.#hits.delete(key)
  }
}
