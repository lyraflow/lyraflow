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
})
