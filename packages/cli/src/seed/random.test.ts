import { describe, expect, it } from 'vitest'
import { MAX_SEED, floatBetween, intBetween, mulberry32, pick, weighted } from './random.js'

describe('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const a = mulberry32(12345)
    const b = mulberry32(12345)
    const left = Array.from({ length: 20 }, () => a())
    const right = Array.from({ length: 20 }, () => b())
    expect(left).toEqual(right)
  })

  // The whole reason `--seed` exists. A generator that ignored its argument
  // would satisfy the test above perfectly.
  it('produces a different sequence for a different seed', () => {
    const a = Array.from({ length: 20 }, mulberry32(12345))
    const b = Array.from({ length: 20 }, mulberry32(12346))
    expect(a).not.toEqual(b)
  })

  it('stays inside [0, 1)', () => {
    const rng = mulberry32(7)
    for (let i = 0; i < 5_000; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('accepts 0 and the largest representable seed', () => {
    expect(Number.isFinite(mulberry32(0)())).toBe(true)
    expect(Number.isFinite(mulberry32(MAX_SEED)())).toBe(true)
    expect(Array.from({ length: 5 }, mulberry32(0))).not.toEqual(
      Array.from({ length: 5 }, mulberry32(MAX_SEED)),
    )
  })
})

describe('intBetween', () => {
  it('is inclusive at both ends and never exceeds them', () => {
    const rng = mulberry32(99)
    const seen = new Set<number>()
    for (let i = 0; i < 5_000; i++) {
      const v = intBetween(rng, 3, 7)
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(3)
      expect(v).toBeLessThanOrEqual(7)
      seen.add(v)
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7])
  })
})

describe('floatBetween', () => {
  it('stays within [min, max)', () => {
    const rng = mulberry32(4)
    for (let i = 0; i < 2_000; i++) {
      const v = floatBetween(rng, -5, 5)
      expect(v).toBeGreaterThanOrEqual(-5)
      expect(v).toBeLessThan(5)
    }
  })
})

describe('pick', () => {
  it('only ever returns a member of the list', () => {
    const rng = mulberry32(11)
    const items = ['a', 'b', 'c'] as const
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) seen.add(pick(rng, items))
    expect([...seen].sort()).toEqual(['a', 'b', 'c'])
  })

  it('refuses an empty list rather than returning undefined', () => {
    expect(() => pick(mulberry32(1), [])).toThrow(/empty list/)
  })
})

describe('weighted', () => {
  // Not an exact distribution assertion -- a seeded generator makes the count
  // reproducible but not meaningful. What matters is that a weight of 8 is
  // clearly commoner than a weight of 1, which is the property the trait mix
  // relies on.
  it('honours the weights', () => {
    const rng = mulberry32(2026)
    const counts = { common: 0, rare: 0 }
    for (let i = 0; i < 10_000; i++) {
      counts[
        weighted(rng, [
          ['common', 8],
          ['rare', 1],
        ] as const)
      ]++
    }
    expect(counts.common).toBeGreaterThan(counts.rare * 5)
    expect(counts.rare).toBeGreaterThan(0)
  })

  it('rejects a non-positive weight instead of silently skipping it', () => {
    expect(() =>
      weighted(mulberry32(1), [
        ['a', 0],
        ['b', 1],
      ] as const),
    ).toThrow(/positive/)
  })
})
