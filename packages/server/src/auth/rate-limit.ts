export const LOGIN_MAX_ATTEMPTS = 10
export const LOGIN_WINDOW_MS = 15 * 60_000

/**
 * THREAT: `POST /v1/auth/login` is unauthenticated and, on any install with
 * a domain, internet-facing. Both of its keys are attacker-chosen -- the
 * source IP (spoofable by anyone when the app trusts a reverse proxy; see
 * `req.ip` below) and the submitted email -- so an unbounded map here is an
 * OOM reachable by anyone who can reach the port, which is the same
 * reasoning ProjectCache's negative-entry bound is built on.
 *
 * This is a PER-NAMESPACE cap, not a shared budget across `ip:` and
 * `email:` keys -- see `#namespaceOf` below. A trusted-proxy deployment
 * (`trustProxy: true` in app.ts) makes `req.ip` whatever the caller's own
 * `X-Forwarded-For` claims, so an attacker has an unlimited supply of `ip:`
 * keys for free. Sharing one map meant flooding it with disposable `ip:`
 * entries could evict a targeted account's `email:` entry once it was
 * blocked -- the map has no way to tell "this attacker's own throwaway
 * key" apart from "the victim's key that happens to be the oldest right
 * now". Splitting the map by namespace means an `ip:` flood can only ever
 * evict other `ip:` entries, never an `email:` one, and vice versa.
 *
 * Namespace separation alone is not sufficient on its own, though: an
 * attacker can flood the `email:` namespace directly, with cheap
 * one-request-each throwaway addresses, and ordinary oldest-first LRU
 * eviction would still walk a blocked victim entry out the door once it
 * ages to the front -- exactly as it would in a single shared map. See
 * `#evict` for the second half of the fix: an entry currently at or over
 * the limit is never evicted while a NOT-yet-blocked entry in the same
 * namespace is available to evict instead, so a blocked key survives any
 * volume of traffic that doesn't ALSO drive every other key in its
 * namespace over the limit first -- which costs `maxAttempts` requests per
 * key, not one, and is bounded by `maxKeys` regardless (see `#evict`'s own
 * comment for why that still cannot grow the map past its cap).
 *
 * Per-email is therefore the limit that actually protects an account here:
 * `req.ip` is spoofable the moment a proxy is trusted, so the per-IP limit
 * slows a single dumb script and nothing more. The per-email limit is what
 * survives a botnet, because forging a *new IP* is free but the attacker
 * still only gets one guess per ten attempts against a given email before
 * that email's own entry blocks them -- and, per the above, that entry
 * cannot be evicted out from under them by unrelated traffic.
 */
export const LOGIN_MAX_KEYS = 4096

/**
 * Everything up to (not including) the first `:` -- `ip:1.2.3.4` and
 * `email:a@b.test` land in separate namespaces, `ip` and `email`. A key
 * with no `:` at all is its own one-key namespace; nothing in this codebase
 * constructs one, but there is no reason to throw on it rather than just
 * caging it too.
 */
function namespaceOf(key: string): string {
  const i = key.indexOf(':')
  return i === -1 ? key : key.slice(0, i)
}

/**
 * In-memory, per-process, and gone on restart -- correct for a
 * single-container product and stated as a limit rather than discovered as
 * one. It slows a password guesser; it is not a defence against a
 * distributed one, and the honest control for that is the password's own
 * entropy, which the installer generates.
 */
export class AttemptLimiter {
  // One inner Map per key namespace (see `#namespaceOf`), each bounded
  // independently at `maxKeys`. Every read and write below deletes a key
  // before re-inserting it into its namespace's map, so the first key in
  // that map's iteration order is always the least recently used -- not
  // merely the first one ever recorded (the same guarantee ProjectCache's
  // #read/#store keep).
  #hits = new Map<string, Map<string, number[]>>()

  constructor(
    private readonly maxAttempts: number = LOGIN_MAX_ATTEMPTS,
    private readonly windowMs: number = LOGIN_WINDOW_MS,
    private readonly maxKeys: number = LOGIN_MAX_KEYS,
  ) {}

  /** Total entries across every namespace -- for tests and diagnostics. */
  get size(): number {
    let total = 0
    for (const ns of this.#hits.values()) total += ns.size
    return total
  }

  #namespace(key: string): Map<string, number[]> {
    const name = namespaceOf(key)
    let ns = this.#hits.get(name)
    if (!ns) {
      ns = new Map()
      this.#hits.set(name, ns)
    }
    return ns
  }

  #live(key: string): number[] {
    const ns = this.#namespace(key)
    const cutoff = Date.now() - this.windowMs
    const kept = (ns.get(key) ?? []).filter((t) => t > cutoff)
    // Delete before conditionally re-inserting: a key with live attempts
    // must move to the end of its namespace's iteration order on every
    // read, exactly as ProjectCache#read does, so a repeatedly-checked key
    // is never the "oldest" one evicted.
    ns.delete(key)
    if (kept.length > 0) ns.set(key, kept)
    return kept
  }

  /** False when ANY key is at or over the limit. */
  check(keys: readonly string[]): boolean {
    return keys.every((k) => this.#live(k).length < this.maxAttempts)
  }

  record(keys: readonly string[]): void {
    for (const key of keys) {
      const ns = this.#namespace(key)
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
      ns.delete(key)
      ns.set(key, kept)
      this.#evict(ns)
    }
  }

  /**
   * Keeps one namespace's map at or under `maxKeys`, preferring to evict an
   * entry that is NOT currently blocked (`attempts.length < maxAttempts`)
   * over one that is -- oldest first among whichever group it picks from.
   *
   * This is what makes a blocked key survive a flood of unrelated ones: as
   * long as at least one entry in the namespace is still under the limit,
   * that is what gets evicted, never the blocked victim, regardless of
   * which key the flood keeps refreshing.
   *
   * The map still cannot grow without bound: only when EVERY entry in the
   * namespace is blocked does this fall back to evicting the oldest one
   * outright, so `ns.size` never exceeds `maxKeys` no matter what arrives.
   * Reaching that fallback at all requires an attacker to drive `maxKeys`
   * distinct keys in this namespace over the limit -- `maxKeys *
   * maxAttempts` requests at minimum, not the `maxKeys` requests the old
   * shared-map eviction took -- and even then it evicts whichever blocked
   * entry has gone longest untouched, not preferentially the newest
   * (freshly-blocked) one, since every read/write already moves a touched
   * entry to the end of the order.
   */
  #evict(ns: Map<string, number[]>): void {
    while (ns.size > this.maxKeys) {
      let victim: string | undefined
      for (const [k, attempts] of ns) {
        if (attempts.length < this.maxAttempts) {
          victim = k
          break
        }
      }
      if (victim === undefined) victim = ns.keys().next().value
      if (victim === undefined) break
      ns.delete(victim)
    }
  }

  reset(keys: readonly string[]): void {
    for (const key of keys) this.#namespace(key).delete(key)
  }
}
