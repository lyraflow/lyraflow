import { describe, expect, it } from 'vitest'
import { toWindowSeconds } from './WindowField.js'

describe('toWindowSeconds', () => {
  it('converts days to seconds', () => {
    expect(toWindowSeconds(7, 'days')).toBe(604800)
  })
  it('rejects a non-safe integer -- Number.isInteger(1e20) is true and 1e20 reaches Postgres as a bigint bind', () => {
    expect(toWindowSeconds(1e20, 'days')).toBeNull()
  })
  it('rejects zero and negatives: window_seconds is a positive int', () => {
    expect(toWindowSeconds(0, 'days')).toBeNull()
    expect(toWindowSeconds(-1, 'days')).toBeNull()
  })
  it('rejects a fractional value rather than silently flooring it', () => {
    expect(toWindowSeconds(1.5, 'days')).toBeNull()
  })
  it('rejects a product that overflows the safe range even when the input is safe', () => {
    // 2^53-1 days is a safe integer; times 86400 it is not.
    expect(toWindowSeconds(Number.MAX_SAFE_INTEGER, 'days')).toBeNull()
  })
})

// Invented beyond the brief's given tests, from the stub check and the
// mutation exercise: two mutations that are each individually invisible to
// the tests above, so each gets its own pin.
describe('toWindowSeconds -- invented mutations', () => {
  it('rejects the smallest safe integer in minutes at the boundary, not just MAX_SAFE_INTEGER in days', () => {
    // A mutation that special-cases `unit === 'days'` (e.g. only re-checking
    // the product for the days branch, since that's the only branch the
    // brief's own test exercises) passes every given test but fails this
    // one: Number.MAX_SAFE_INTEGER minutes * 60 also overflows.
    expect(toWindowSeconds(Number.MAX_SAFE_INTEGER, 'minutes')).toBeNull()
  })

  it('accepts the boundary itself -- a safe-integer product must not be rejected', () => {
    // Guards against a mutation that flips the overflow check to `>=` some
    // approximate threshold instead of `Number.isSafeInteger`: 100000 hours
    // is comfortably a safe integer (3.6e8), so a correct implementation
    // must return it, not null.
    expect(toWindowSeconds(100000, 'hours')).toBe(360000000)
  })
})
