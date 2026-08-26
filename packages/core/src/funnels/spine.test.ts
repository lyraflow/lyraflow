import { describe, expect, it } from 'vitest'
import type { FunnelStep } from './ast.js'
import { funnelSpine } from './spine.js'

const req = (event: string): FunnelStep => ({ event })
const opt = (event: string): FunnelStep => ({ event, optional: true })

describe('funnelSpine', () => {
  it('treats every step as spine when none is optional', () => {
    const s = funnelSpine([req('a'), req('b'), req('c')])
    expect(s.required).toEqual([0, 1, 2])
    expect(s.optional).toEqual([])
    expect(s.placements.map((p) => p.spineRank)).toEqual([1, 2, 3])
    expect(s.placements.every((p) => p.branch === undefined)).toBe(true)
  })

  it('gives an optional step the rank of the required step it branches off', () => {
    // a b [c] d -- c branches off b, which is spine rank 2.
    const s = funnelSpine([req('a'), req('b'), opt('c'), req('d')])
    expect(s.required).toEqual([0, 1, 3])
    expect(s.optional).toEqual([2])
    expect(s.placements[2]?.spineRank).toBe(2)
    expect(s.placements[2]?.branch).toEqual({ index: 0, level: 3 })
  })

  it('does not let an optional step shift the ranks of the steps after it', () => {
    // THE off-by-one this module exists for. `d` is at definition position 3
    // and spine rank 3, not 4 -- reading `atLeast[]` by position would give
    // it the wrong count, and only once an optional step sits before it.
    const s = funnelSpine([req('a'), req('b'), opt('c'), req('d')])
    expect(s.placements[3]?.spineRank).toBe(3)
    expect(s.required.length).toBe(3)
  })

  it('branches two adjacent optional steps off the same required step', () => {
    const s = funnelSpine([req('a'), opt('b'), opt('c'), req('d')])
    expect(s.optional).toEqual([1, 2])
    expect(s.placements[1]?.branch).toEqual({ index: 0, level: 2 })
    expect(s.placements[2]?.branch).toEqual({ index: 1, level: 2 })
    expect(s.placements[1]?.spineRank).toBe(1)
    expect(s.placements[2]?.spineRank).toBe(1)
  })

  it('numbers branches in definition order, independent of which step they hang off', () => {
    const s = funnelSpine([req('a'), opt('b'), req('c'), opt('d'), req('e')])
    expect(s.placements[1]?.branch?.index).toBe(0)
    expect(s.placements[3]?.branch?.index).toBe(1)
    expect(s.placements[3]?.branch?.level).toBe(3)
  })

  it('is defined for an optional first step even though validation refuses one', () => {
    // A pure function over whatever it is handed. `validateFunnel` is what
    // makes this unreachable; a throw here would put the same rule in two
    // places and let them disagree.
    const s = funnelSpine([opt('a'), req('b')])
    expect(s.placements[0]?.spineRank).toBe(0)
    expect(s.placements[0]?.branch).toEqual({ index: 0, level: 1 })
  })

  it('marks optionality on every placement', () => {
    const s = funnelSpine([req('a'), opt('b'), req('c')])
    expect(s.placements.map((p) => p.optional)).toEqual([false, true, false])
    expect(s.placements.map((p) => p.position)).toEqual([0, 1, 2])
  })
})
