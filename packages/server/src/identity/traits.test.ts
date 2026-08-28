import { describe, expect, it } from 'vitest'
import { type TraitRow, mergeTraits, splitTraits } from './traits.js'

const row = (k: string, s: string, n: number, has: number): TraitRow => ({
  trait_key: k,
  value_str: s,
  value_num: n,
  has_num: has,
})

describe('mergeTraits', () => {
  it('keeps a numeric trait whose value is 0', () => {
    expect(mergeTraits([row('credits', '', 0, 1)])).toEqual({ credits: 0 })
  })
  it('reads a string trait from value_str, ignoring value_num', () => {
    expect(mergeTraits([row('plan', 'pro', 0, 0)])).toEqual({ plan: 'pro' })
  })
})

describe('splitTraits', () => {
  it('routes by has_num, not by the javascript type of value_num', () => {
    const out = splitTraits([row('plan', 'pro', 0, 0), row('seats', '', 12, 1)], 50)
    expect(out.traits).toEqual({ plan: 'pro' })
    expect(out.traits_num).toEqual({ seats: 12 })
    expect(out.trait_total).toBe(2)
  })
  it('keeps a numeric trait of 0 in traits_num rather than dropping it', () => {
    const out = splitTraits([row('credits', '', 0, 1)], 50)
    expect(out.traits_num).toEqual({ credits: 0 })
  })
  it('caps the returned keys but reports the real total', () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(`k${String(i).padStart(2, '0')}`, 'v', 0, 0),
    )
    const out = splitTraits(rows, 50)
    expect(Object.keys(out.traits)).toHaveLength(50)
    expect(out.trait_total).toBe(60)
  })
  it('caps a STABLE 50: the same rows in a different order yield the same keys', () => {
    // The cap without the sort returns whatever 50 ClickHouse grouped first,
    // so two reads of one person disagree. Reverse the input and the answer
    // must not move.
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(`k${String(i).padStart(2, '0')}`, 'v', 0, 0),
    )
    const a = splitTraits(rows, 50)
    const b = splitTraits([...rows].reverse(), 50)
    expect(Object.keys(a.traits)).toEqual(Object.keys(b.traits))
  })
  it('returns empty maps and a zero total for a person with no traits', () => {
    expect(splitTraits([], 50)).toEqual({ traits: {}, traits_num: {}, trait_total: 0 })
  })
})
