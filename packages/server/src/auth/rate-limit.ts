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
  // Map iterates in insertion order, so the first key is always the oldest.
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
    if (kept.length === 0) this.#hits.delete(key)
    else this.#hits.set(key, kept)
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
