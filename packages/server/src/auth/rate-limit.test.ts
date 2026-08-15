import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AttemptLimiter } from './rate-limit.js'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('AttemptLimiter', () => {
  it('allows up to the limit and refuses the next', () => {
    const l = new AttemptLimiter(3, 60_000)
    for (let i = 0; i < 3; i++) {
      expect(l.check(['ip:1'])).toBe(true)
      l.record(['ip:1'])
    }
    expect(l.check(['ip:1'])).toBe(false)
  })

  it('refuses when ANY key is over, not only the first', () => {
    const l = new AttemptLimiter(2, 60_000)
    l.record(['email:a@example.test'])
    l.record(['email:a@example.test'])
    // A fresh IP, an exhausted email: an attacker rotating IPs against one
    // account must still be stopped.
    expect(l.check(['ip:9.9.9.9', 'email:a@example.test'])).toBe(false)
  })

  it('forgets attempts once the window passes', () => {
    const l = new AttemptLimiter(1, 60_000)
    l.record(['ip:1'])
    expect(l.check(['ip:1'])).toBe(false)
    vi.advanceTimersByTime(60_001)
    expect(l.check(['ip:1'])).toBe(true)
  })

  it('reset clears a key, so a successful login does not count against the next', () => {
    const l = new AttemptLimiter(1, 60_000)
    l.record(['ip:1'])
    expect(l.check(['ip:1'])).toBe(false)
    l.reset(['ip:1'])
    expect(l.check(['ip:1'])).toBe(true)
  })

  // The login endpoint is unauthenticated and internet-facing, so the key
  // space is attacker-chosen: every distinct source IP and every distinct
  // submitted email creates an entry. Unbounded, that is an OOM.
  it('is bounded, evicting the oldest key rather than growing forever', () => {
    const l = new AttemptLimiter(10, 60_000, 4)
    for (let i = 0; i < 50; i++) l.record([`ip:${i}`])
    expect(l.size).toBeLessThanOrEqual(4)
  })

  // Eviction must be by recency, not by first-ever-insertion. Otherwise a
  // blocked IP can erase its own block from a single machine: keep hitting
  // the endpoint with disposable emails, and once the map fills, the
  // blocked IP -- pinned at the front of the order since it was inserted
  // first and never "moved" -- would be the first thing evicted.
  it('keeps a blocked key blocked through a flood of unrelated keys', () => {
    const l = new AttemptLimiter(1, 60_000, 4)
    l.record(['ip:victim'])
    expect(l.check(['ip:victim'])).toBe(false)
    // A blocked caller keeps hitting the endpoint, so `check` keeps getting
    // called against it -- but a request already refused by `check` is
    // never recorded again, so `record` never touches ip:victim past this
    // point. Only `check`'s own LRU refresh can keep it from aging out.
    for (let i = 0; i < 50; i++) {
      l.record([`ip:filler-${i}`])
      expect(l.check(['ip:victim'])).toBe(false)
    }
    expect(l.check(['ip:victim'])).toBe(false)
  })

  // Companion to the above: a key that is NOT touched during the flood
  // must still get evicted, so the previous test cannot pass simply
  // because nothing was ever evicted.
  it('evicts a key that is never touched again during the same flood', () => {
    const l = new AttemptLimiter(1, 60_000, 4)
    l.record(['ip:doomed'])
    expect(l.check(['ip:doomed'])).toBe(false)
    for (let i = 0; i < 50; i++) l.record([`ip:filler-${i}`])
    // ip:doomed was never touched again, so it is the least recently used
    // key throughout the flood and must be the one evicted -- its block
    // is gone, which is the only way to observe eviction actually happened.
    expect(l.check(['ip:doomed'])).toBe(true)
  })

  // CRITICAL: an ip: flood must not be able to spend an email: entry's
  // eviction budget, and vice versa -- the two namespaces are bounded, and
  // hold entries, SEPARATELY. Deliberately uses UNBLOCKED entries (one
  // attempt each, well under the limit of 10) so this pins namespace
  // separation on its own, independent of #evict's blocked-entry
  // protection -- a merged shared map would still cap total size at 4
  // regardless of that other guard.
  it('keeps each namespace bounded independently, not sharing one budget', () => {
    const l = new AttemptLimiter(10, 60_000, 4)
    // Fill the email namespace to exactly its own cap first.
    for (let i = 0; i < 4; i++) l.record([`email:e${i}@example.test`])
    // Then flood the ip namespace far past its own cap.
    for (let i = 0; i < 50; i++) l.record([`ip:${i}`])
    // Separate maps: the email namespace's 4 entries are untouched by the
    // ip flood, and the ip namespace caps at its own 4 -- 8 total. A single
    // shared map capped at 4 would have evicted every email entry to make
    // room for the ip flood, leaving 4.
    expect(l.size).toBe(8)
  })

  // CRITICAL, the core of the finding: a flood of distinct (ip, email)
  // pairs -- cheap for an attacker who spoofs X-Forwarded-For, since
  // trustProxy makes req.ip whatever they claim -- must never free a
  // blocked victim email. Unlike "keeps a blocked key blocked through a
  // flood of unrelated keys" above, this never touches the victim's key
  // again after it blocks: the attacker has no reason to guess it, and the
  // whole point of the finding is that nothing does that touching for them.
  it('a flood of distinct (ip, email) pairs does not free a blocked email', () => {
    const l = new AttemptLimiter(10, 60_000, 4096)
    const victim = 'email:victim@example.test'
    for (let i = 0; i < 10; i++) l.record(['ip:attacker', victim])
    expect(l.check([victim])).toBe(false)

    // Far more than maxKeys distinct (ip, email) pairs, every one of them
    // a single, unblocked attempt -- the cheap flood the finding describes,
    // not the maxKeys*maxAttempts one needed to reach the last-resort
    // fallback in #evict.
    for (let i = 0; i < 20_000; i++) {
      l.record([`ip:flood-${i}`, `email:flood-${i}@example.test`])
    }

    expect(l.check([victim])).toBe(false)
    // Pin the bound too: neither namespace's map grew past its cap under
    // the flood.
    expect(l.size).toBeLessThanOrEqual(4096 * 2)
  })

  // Companion to the flood test: an attacker who drives every key in a
  // namespace over the limit -- not just touches them once -- can still
  // only bound that namespace's map at maxKeys, never grow it further.
  // maxAttempts=1 means every single record() call blocks its key
  // immediately, so this reliably forces the "every entry is blocked"
  // fallback in #evict on every insertion past the fourth, rather than
  // leaving open the possibility that a not-yet-blocked entry was always
  // available to evict instead.
  it('is bounded even when every entry in a namespace is blocked', () => {
    const l = new AttemptLimiter(1, 60_000, 4)
    for (let i = 0; i < 50; i++) l.record([`email:e${i}@example.test`])
    expect(l.size).toBeLessThanOrEqual(4)
  })
})
