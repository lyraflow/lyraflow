import { describe, expect, it } from 'vitest'
import { isOverQuota } from './quota.js'

describe('isOverQuota', () => {
  it('is false for an unlimited project, whatever the counts', () => {
    // NULL means unlimited and is the default after migration 011. An
    // unlimited project must also never pay for a usage read -- the caller
    // short-circuits on null, and this is the value that lets it.
    expect(isOverQuota(0, 0, null)).toBe(false)
    expect(isOverQuota(Number.MAX_SAFE_INTEGER, 1_000_000, null)).toBe(false)
  })

  it('is false at exactly the quota, and true one past it', () => {
    // The quota is the number of events a project may accept. Accepting the
    // 100th event of a 100 quota is within it; the 101st is not.
    expect(isOverQuota(99, 0, 100)).toBe(false)
    expect(isOverQuota(100, 0, 100)).toBe(true)
  })

  it('counts pending against the quota, not only what Postgres has', () => {
    // The flush interval is 1s. Ignoring pending would let a burst inside
    // one interval pass unbounded -- the overshoot would be a whole flush
    // of traffic wide open rather than merely delayed.
    expect(isOverQuota(90, 9, 100)).toBe(false)
    expect(isOverQuota(90, 10, 100)).toBe(true)
  })

  it('is true when pending alone crosses the line from zero persisted', () => {
    expect(isOverQuota(0, 100, 100)).toBe(true)
  })

  it('refuses a quota that is not a positive integer, rather than guessing', () => {
    // The column is CHECK (monthly_event_quota > 0), so these are unreachable
    // through Postgres -- but this function is also called with values a
    // future admin path might supply, and a NaN quota compares false against
    // everything, which would silently disable enforcement.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5]) {
      expect(() => isOverQuota(0, 0, bad)).toThrow(/quota/i)
    }
  })

  it('refuses undefined too, not just null, when a caller bypasses the type', () => {
    // The declared signature (`number | null`) already keeps `undefined` out
    // of every call site TypeScript checks -- but the value on the wire (a
    // partial DB row, a JSON body, a future admin path) is not type-checked
    // at runtime. A loose `== null` check would treat a missing quota the
    // same as an explicit null and silently grant unlimited traffic instead
    // of refusing to guess; the strict `=== null` check must not. Bypassing
    // the type deliberately here proves the runtime guard, not just the
    // compiler, catches it.
    expect(() => isOverQuota(0, 0, undefined as unknown as number)).toThrow(/quota/i)
  })

  it('refuses a persisted count that is not finite and non-negative, rather than failing open', () => {
    // `Number(row?.count)` on a Postgres read for a project's first event of
    // a month -- before any counter row exists -- yields exactly NaN.
    // `NaN >= quota` is false, so an unguarded function would silently
    // report "not over quota": the fail-open direction this file exists to
    // prevent, for every project until its counters are first flushed.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -100]) {
      expect(() => isOverQuota(bad, 0, 100)).toThrow(/quota/i)
    }
    // Zero remains legal: it is the ordinary state of a project that has
    // accepted nothing yet, not a malformed read.
    expect(isOverQuota(0, 0, 100)).toBe(false)
  })

  it('refuses a pending count that is not finite and non-negative, rather than failing open', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -100]) {
      expect(() => isOverQuota(0, bad, 100)).toThrow(/quota/i)
    }
    expect(isOverQuota(0, 0, 100)).toBe(false)
  })
})
