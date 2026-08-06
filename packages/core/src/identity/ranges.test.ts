import { describe, expect, it } from 'vitest'
import { type BindEvent, type Binding, type BindingWrite, planBindingWrites } from './ranges.js'

const NEG = Number.NEGATIVE_INFINITY
const POS = Number.POSITIVE_INFINITY
const t = (h: number) => Date.UTC(2026, 7, 6, h)

/**
 * Applies writes the way a real store would: delete `previous` if present, then
 * upsert `binding`. Upserting is idempotent, which matters because several
 * `close` writes in one batch may legitimately target the same `binding` when
 * multiple old rows collapse into one (see ranges.ts's doc comment).
 */
function applyWrites(bindings: Binding[], writes: BindingWrite[]): Binding[] {
  let result = bindings
  for (const w of writes) {
    if (w.op === 'close' && w.previous) {
      const previous = w.previous
      result = result.filter((b) => !(b.personId === previous.personId && b.from === previous.from))
    }
    const alreadyPresent = result.some(
      (b) =>
        b.personId === w.binding.personId && b.from === w.binding.from && b.to === w.binding.to,
    )
    if (!alreadyPresent) result = [...result, w.binding]
  }
  return result
}

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

describe('planBindingWrites', () => {
  it('opens the first binding at -infinity so pre-signup history attaches', () => {
    expect(planBindingWrites([], { personId: 'alice', boundAt: t(12) })).toEqual([
      { op: 'insert', binding: { personId: 'alice', boundAt: t(12), from: NEG, to: POS } },
    ])
  })

  it('is a no-op when the device is already bound to the same person', () => {
    const existing: Binding[] = [{ personId: 'alice', boundAt: t(12), from: NEG, to: POS }]
    expect(planBindingWrites(existing, { personId: 'alice', boundAt: t(15) })).toEqual([])
  })

  it('closes the open binding and opens a new one on a rebind', () => {
    const existing: Binding[] = [{ personId: 'alice', boundAt: t(12), from: NEG, to: POS }]
    expect(planBindingWrites(existing, { personId: 'bob', boundAt: t(15) })).toEqual([
      {
        op: 'close',
        binding: { personId: 'alice', boundAt: t(12), from: NEG, to: t(15) },
        previous: { personId: 'alice', boundAt: t(12), from: NEG, to: POS },
      },
      { op: 'insert', binding: { personId: 'bob', boundAt: t(15), from: t(15), to: POS } },
    ])
  })

  it('splits a closed historical range when an identify arrives out of order', () => {
    const existing: Binding[] = [
      { personId: 'alice', boundAt: t(2), from: NEG, to: t(15) },
      { personId: 'bob', boundAt: t(15), from: t(15), to: POS },
    ]
    expect(planBindingWrites(existing, { personId: 'carol', boundAt: t(10) })).toEqual([
      {
        op: 'close',
        binding: { personId: 'alice', boundAt: t(2), from: NEG, to: t(10) },
        previous: { personId: 'alice', boundAt: t(2), from: NEG, to: t(15) },
      },
      { op: 'insert', binding: { personId: 'carol', boundAt: t(10), from: t(10), to: t(15) } },
    ])
  })

  it('is a no-op when a late identify matches the person already covering that instant', () => {
    const existing: Binding[] = [
      { personId: 'alice', boundAt: t(2), from: NEG, to: t(15) },
      { personId: 'bob', boundAt: t(15), from: t(15), to: POS },
    ]
    expect(planBindingWrites(existing, { personId: 'alice', boundAt: t(10) })).toEqual([])
  })

  it('never produces overlapping or zero-width ranges for any interleaving', () => {
    const events: BindEvent[] = [
      { personId: 'a', boundAt: t(12) },
      { personId: 'b', boundAt: t(9) },
      { personId: 'c', boundAt: t(15) },
      { personId: 'a', boundAt: t(10) },
      { personId: 'b', boundAt: t(20) },
    ]
    let bindings: Binding[] = []
    for (const e of events) {
      bindings = applyWrites(bindings, planBindingWrites(bindings, e))
      bindings = [...bindings].sort((x, y) => x.from - y.from)

      // No zero-width ranges — a valid_range this thin fails Postgres's
      // NOT isempty() check, so a genuine identify would be rejected outright.
      for (const b of bindings) {
        expect(b.from < b.to).toBe(true)
      }
      // No gaps, no overlaps.
      for (let i = 1; i < bindings.length; i++) {
        const prev = bindings[i - 1]
        const cur = bindings[i]
        expect(prev && cur && prev.to <= cur.from).toBe(true)
      }
    }
  })

  it('places two people colliding on the identical instant into a valid, non-empty tiling', () => {
    const existing: Binding[] = [
      { personId: 'alice', boundAt: t(10), from: NEG, to: t(15) },
      { personId: 'bob', boundAt: t(15), from: t(15), to: POS },
    ]
    // carol's identify lands exactly on bob's own boundAt/from — the instant a
    // naive "close the covering row at incoming.at" rule would zero-width bob's
    // range ({ from: t(15), to: t(15) }), which Postgres would reject outright.
    const writes = planBindingWrites(existing, { personId: 'carol', boundAt: t(15) })

    for (const w of writes) {
      expect(w.binding.from < w.binding.to).toBe(true)
    }

    const bindings = applyWrites(existing, writes).sort((x, y) => x.from - y.from)
    expect(bindings).toEqual([
      { personId: 'alice', boundAt: t(10), from: NEG, to: t(15) },
      { personId: 'carol', boundAt: t(15), from: t(15), to: POS },
    ])
  })

  it('converges to the same final tiling regardless of arrival order', () => {
    const events: BindEvent[] = [
      { personId: 'p1', boundAt: t(8) },
      { personId: 'p2', boundAt: t(14) },
      { personId: 'p3', boundAt: t(11) },
    ]

    const expected = [
      { personId: 'p1', boundAt: t(8), from: NEG, to: t(11) },
      { personId: 'p3', boundAt: t(11), from: t(11), to: t(14) },
      { personId: 'p2', boundAt: t(14), from: t(14), to: POS },
    ]

    for (const order of permutations(events)) {
      let bindings: Binding[] = []
      for (const e of order) {
        bindings = applyWrites(bindings, planBindingWrites(bindings, e))
      }
      bindings = [...bindings].sort((x, y) => x.from - y.from)
      expect(bindings).toEqual(expected)
    }
  })
})
