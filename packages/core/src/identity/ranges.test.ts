import { describe, expect, it } from 'vitest'
import { type BindEvent, type Binding, coalesceContiguous, deriveTiling } from './ranges.js'

const NEG = Number.NEGATIVE_INFINITY
const POS = Number.POSITIVE_INFINITY
const t = (h: number) => Date.UTC(2026, 7, 6, h)

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()]
  const result: T[][] = []
  for (let i = 0; i < items.length; i++) {
    const pivot = items[i]
    if (pivot === undefined) continue
    const rest = [...items.slice(0, i), ...items.slice(i + 1)]
    for (const perm of permutations(rest)) result.push([pivot, ...perm])
  }
  return result
}

/** Runs every arrival order of `events` through `deriveTiling` and asserts
 * they all converge to the identical `expected` tiling. */
function assertOrderIndependent(events: BindEvent[], expected: Binding[]) {
  for (const order of permutations(events)) {
    expect(deriveTiling(order)).toEqual(expected)
  }
}

describe('deriveTiling', () => {
  it('opens the earliest event at -infinity so pre-signup history attaches', () => {
    expect(deriveTiling([{ personId: 'alice', boundAt: t(12) }])).toEqual([
      { personId: 'alice', from: NEG, to: POS },
    ])
  })

  it('retroactively attaches everything before the earliest known event to that event’s person', () => {
    // bob is bound first (chronologically speaking, in terms of when this
    // call runs), but alice's identify proves she owned the device long
    // before bob ever touched it.
    const events: BindEvent[] = [
      { personId: 'bob', boundAt: t(20) },
      { personId: 'alice', boundAt: t(5) },
    ]
    expect(deriveTiling(events)[0]).toEqual({ personId: 'alice', from: NEG, to: t(20) })
  })

  it('tiles three distinct people with no gaps or overlaps', () => {
    const events: BindEvent[] = [
      { personId: 'alice', boundAt: t(8) },
      { personId: 'bob', boundAt: t(14) },
      { personId: 'carol', boundAt: t(11) },
    ]
    expect(deriveTiling(events)).toEqual([
      { personId: 'alice', from: NEG, to: t(11) },
      { personId: 'carol', from: t(11), to: t(14) },
      { personId: 'bob', from: t(14), to: POS },
    ])
  })

  it('resolves a same-instant tie between two people to the lexicographically smaller personId', () => {
    const events: BindEvent[] = [
      { personId: 'zed', boundAt: t(10) },
      { personId: 'amy', boundAt: t(10) },
    ]
    expect(deriveTiling(events)).toEqual([{ personId: 'amy', from: NEG, to: POS }])
  })

  it('leaves adjacent same-person events uncollapsed, harmlessly', () => {
    // Two identify() calls for the same person both survive as distinct
    // tiles — nothing merges them — but the derived shape is unaffected,
    // since both resolve to the same person regardless.
    const events: BindEvent[] = [
      { personId: 'alice', boundAt: t(5) },
      { personId: 'alice', boundAt: t(9) },
      { personId: 'bob', boundAt: t(15) },
    ]
    expect(deriveTiling(events)).toEqual([
      { personId: 'alice', from: NEG, to: t(9) },
      { personId: 'alice', from: t(9), to: t(15) },
      { personId: 'bob', from: t(15), to: POS },
    ])
  })

  it('satisfies the tiling invariants for a mixed event set: full coverage, no gaps, no overlaps, no zero-width', () => {
    const events: BindEvent[] = [
      { personId: 'a', boundAt: t(12) },
      { personId: 'b', boundAt: t(9) },
      { personId: 'c', boundAt: t(15) },
      { personId: 'a', boundAt: t(10) },
      { personId: 'b', boundAt: t(20) },
    ]
    const tiling = deriveTiling(events)

    expect(tiling[0]?.from).toBe(NEG)
    expect(tiling[tiling.length - 1]?.to).toBe(POS)
    for (const b of tiling) expect(b.from < b.to).toBe(true)
    for (let i = 1; i < tiling.length; i++) {
      const prev = tiling[i - 1]
      const cur = tiling[i]
      expect(prev && cur && prev.to === cur.from).toBe(true)
    }
  })

  it('converges to the same tiling for every arrival order: repeated same-person then a late out-of-order identify', () => {
    // The exact shape that diverged under an incremental, order-sensitive
    // derivation: A identifies twice, then a late B arrives out of order.
    assertOrderIndependent(
      [
        { personId: 'A', boundAt: t(1) },
        { personId: 'B', boundAt: t(2) },
        { personId: 'A', boundAt: t(3) },
      ],
      [
        { personId: 'A', from: NEG, to: t(2) },
        { personId: 'B', from: t(2), to: t(3) },
        { personId: 'A', from: t(3), to: POS },
      ],
    )
  })

  it('converges to the same tiling for every arrival order: repeated same-person events', () => {
    assertOrderIndependent(
      [
        { personId: 'p', boundAt: t(1) },
        { personId: 'p', boundAt: t(5) },
        { personId: 'q', boundAt: t(9) },
      ],
      [
        { personId: 'p', from: NEG, to: t(5) },
        { personId: 'p', from: t(5), to: t(9) },
        { personId: 'q', from: t(9), to: POS },
      ],
    )
  })

  it('converges to the same tiling for every arrival order: a same-instant tie', () => {
    assertOrderIndependent(
      [
        { personId: 'zed', boundAt: t(10) },
        { personId: 'amy', boundAt: t(10) },
        { personId: 'bob', boundAt: t(15) },
      ],
      [
        { personId: 'amy', from: NEG, to: t(15) },
        { personId: 'bob', from: t(15), to: POS },
      ],
    )
  })
})

describe('coalesceContiguous', () => {
  it('merges repeat-identify tiles for one person on one device into a single window', () => {
    // The exact shape a logged-in browser produces: N `identify()` calls for
    // the same person, none of them collapsed by deriveTiling itself (see
    // its own docstring), tiling the timeline as N boundary-touching tiles
    // that all resolve to the same person.
    const tiling = deriveTiling([
      { personId: 'alice', boundAt: t(1) },
      { personId: 'alice', boundAt: t(2) },
      { personId: 'alice', boundAt: t(3) },
    ])
    expect(coalesceContiguous(tiling)).toEqual([{ personId: 'alice', from: NEG, to: POS }])
  })

  it('does not merge across a genuine rebind to a different person', () => {
    const tiling = deriveTiling([
      { personId: 'alice', boundAt: t(1) },
      { personId: 'bob', boundAt: t(5) },
    ])
    expect(coalesceContiguous(tiling)).toEqual([
      { personId: 'alice', from: NEG, to: t(5) },
      { personId: 'bob', from: t(5), to: POS },
    ])
  })

  it('merges only the contiguous run, leaving a later different-person tile separate', () => {
    const tiling = deriveTiling([
      { personId: 'alice', boundAt: t(1) },
      { personId: 'alice', boundAt: t(2) },
      { personId: 'alice', boundAt: t(3) },
      { personId: 'bob', boundAt: t(9) },
    ])
    expect(coalesceContiguous(tiling)).toEqual([
      { personId: 'alice', from: NEG, to: t(9) },
      { personId: 'bob', from: t(9), to: POS },
    ])
  })

  it('reunites a person who left and came back, as two separate windows either side of the gap', () => {
    // alice -> bob -> alice again: the two alice tiles are NOT adjacent to
    // each other (bob's tile sits between them), so this must stay three
    // tiles, not collapse the two alice ones together across bob's.
    const tiling = deriveTiling([
      { personId: 'alice', boundAt: t(1) },
      { personId: 'bob', boundAt: t(5) },
      { personId: 'alice', boundAt: t(9) },
    ])
    expect(coalesceContiguous(tiling)).toEqual(tiling)
  })

  it('is a no-op on a single tile', () => {
    const tiling = deriveTiling([{ personId: 'alice', boundAt: t(1) }])
    expect(coalesceContiguous(tiling)).toEqual(tiling)
  })
})
