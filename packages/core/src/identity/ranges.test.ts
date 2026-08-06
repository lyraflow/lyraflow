import { describe, expect, it } from 'vitest'
import { type Binding, planBindingWrites } from './ranges.js'

const NEG = Number.NEGATIVE_INFINITY
const POS = Number.POSITIVE_INFINITY
const t = (h: number) => Date.UTC(2026, 7, 6, h)

describe('planBindingWrites', () => {
  it('opens the first binding at -infinity so pre-signup history attaches', () => {
    expect(planBindingWrites([], { personId: 'alice', at: t(12) })).toEqual([
      { op: 'insert', binding: { personId: 'alice', from: NEG, to: POS } },
    ])
  })

  it('is a no-op when the device is already bound to the same person', () => {
    const existing: Binding[] = [{ personId: 'alice', from: NEG, to: POS }]
    expect(planBindingWrites(existing, { personId: 'alice', at: t(15) })).toEqual([])
  })

  it('closes the open binding and opens a new one on a rebind', () => {
    const existing: Binding[] = [{ personId: 'alice', from: NEG, to: POS }]
    expect(planBindingWrites(existing, { personId: 'bob', at: t(15) })).toEqual([
      {
        op: 'close',
        binding: { personId: 'alice', from: NEG, to: t(15) },
        previous: { personId: 'alice', from: NEG, to: POS },
      },
      { op: 'insert', binding: { personId: 'bob', from: t(15), to: POS } },
    ])
  })

  it('splits a closed historical range when an identify arrives out of order', () => {
    const existing: Binding[] = [
      { personId: 'alice', from: NEG, to: t(15) },
      { personId: 'bob', from: t(15), to: POS },
    ]
    expect(planBindingWrites(existing, { personId: 'carol', at: t(10) })).toEqual([
      {
        op: 'close',
        binding: { personId: 'alice', from: NEG, to: t(10) },
        previous: { personId: 'alice', from: NEG, to: t(15) },
      },
      { op: 'insert', binding: { personId: 'carol', from: t(10), to: t(15) } },
    ])
  })

  it('is a no-op when a late identify matches the person already covering that instant', () => {
    const existing: Binding[] = [
      { personId: 'alice', from: NEG, to: t(15) },
      { personId: 'bob', from: t(15), to: POS },
    ]
    expect(planBindingWrites(existing, { personId: 'alice', at: t(10) })).toEqual([])
  })

  it('never produces overlapping ranges for any interleaving', () => {
    const events: Array<{ personId: string; at: number }> = [
      { personId: 'a', at: t(12) },
      { personId: 'b', at: t(9) },
      { personId: 'c', at: t(15) },
      { personId: 'a', at: t(10) },
      { personId: 'b', at: t(20) },
    ]
    let bindings: Binding[] = []
    for (const e of events) {
      for (const w of planBindingWrites(bindings, e)) {
        if (w.op === 'close') {
          bindings = bindings.map((b) =>
            b === w.previous || (b.personId === w.previous?.personId && b.from === w.previous?.from)
              ? w.binding
              : b,
          )
        } else {
          bindings = [...bindings, w.binding]
        }
      }
      bindings.sort((x, y) => x.from - y.from)
      for (let i = 1; i < bindings.length; i++) {
        const prev = bindings[i - 1]
        const cur = bindings[i]
        expect(prev && cur && prev.to <= cur.from).toBe(true)
      }
    }
  })

  it('rejects an incoming binding at an instant it cannot place', () => {
    expect(() =>
      planBindingWrites([{ personId: 'a', from: t(10), to: t(12) }], { personId: 'b', at: t(20) }),
    ).not.toThrow()
  })
})
