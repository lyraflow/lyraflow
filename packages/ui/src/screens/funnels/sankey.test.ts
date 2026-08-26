import { describe, expect, it } from 'vitest'
import type { StepResult } from '../../api/types.js'
import { sankeyModel } from './sankey.js'

const step = (o: Partial<StepResult> & { index: number; event: string }): StepResult =>
  ({ people: 0, from_previous: 1, from_start: 1, ...o }) as StepResult

const LINEAR: StepResult[] = [
  step({ index: 1, event: 'a', people: 100, from_previous: 1, from_start: 1 }),
  step({ index: 2, event: 'b', people: 80, from_previous: 0.8, from_start: 0.8 }),
  step({ index: 3, event: 'c', people: 40, from_previous: 0.5, from_start: 0.4 }),
]

// a -> [b optional] -> c.  60 reached b, 50 carried on, 40 converted.
const BRANCHED: StepResult[] = [
  step({ index: 1, event: 'a', people: 100, from_previous: 1, from_start: 1 }),
  step({
    index: 2,
    event: 'b',
    people: 60,
    from_previous: 0.6,
    from_start: 0.6,
    optional: true,
    skipped: 40,
    continued: 50,
  }),
  step({ index: 3, event: 'c', people: 70, from_previous: 0.7, from_start: 0.7 }),
]

describe('sankeyModel', () => {
  it('gives a linear funnel one node per step and one link per pair', () => {
    const m = sankeyModel(LINEAR, 100)
    expect(m.nodes).toHaveLength(3)
    expect(m.links).toHaveLength(2)
    expect(m.links.every((l) => l.kind === 'chain')).toBe(true)
    expect(m.links[0]).toMatchObject({ from: 0, to: 1, people: 80 })
    expect(m.links[1]).toMatchObject({ from: 1, to: 2, people: 40 })
  })

  it('puts every node of a linear funnel on one centre line', () => {
    const m = sankeyModel(LINEAR, 100)
    const centres = m.nodes.map((n) => n.y + n.height / 2)
    expect(new Set(centres.map((c) => Math.round(c)))).toHaveLength(1)
  })

  it('forks and rejoins around an optional step', () => {
    const m = sankeyModel(BRANCHED, 100)
    const kinds = m.links.map((l) => l.kind).sort()
    expect(kinds).toEqual(['branch', 'bypass', 'continue'])
    expect(m.links.find((l) => l.kind === 'branch')).toMatchObject({ from: 0, to: 1, people: 60 })
    expect(m.links.find((l) => l.kind === 'continue')).toMatchObject({ from: 1, to: 2, people: 50 })
    // 70 reached c, 50 of them through b.
    expect(m.links.find((l) => l.kind === 'bypass')).toMatchObject({ from: 0, to: 2, people: 20 })
  })

  it('offsets an optional node off the centre line the required ones share', () => {
    const m = sankeyModel(BRANCHED, 100)
    const required = m.nodes.filter((n) => !n.optional).map((n) => n.y + n.height / 2)
    const optional = m.nodes.find((n) => n.optional)
    expect(new Set(required.map((c) => Math.round(c)))).toHaveLength(1)
    expect(Math.round(optional?.y ?? 0)).toBeLessThan(Math.round(required[0] as number))
  })

  it('fills each node exactly with the links that touch it', () => {
    // THE CONSERVATION RULE. Widths always add up; the counts are what carry
    // the truth. Checked at BOTH ends, because a link may taper.
    const m = sankeyModel(BRANCHED, 100)
    for (const [i, node] of m.nodes.entries()) {
      const out = m.links.filter((l) => l.from === i)
      const into = m.links.filter((l) => l.to === i)
      if (out.length > 0) {
        expect(out.reduce((t, l) => t + l.w0, 0)).toBeCloseTo(node.height, 5)
      }
      if (into.length > 0) {
        expect(into.reduce((t, l) => t + l.w1, 0)).toBeCloseTo(node.height, 5)
      }
    }
  })

  it('prints the true counts even where the widths were scaled', () => {
    const m = sankeyModel(BRANCHED, 100)
    expect(m.links.find((l) => l.kind === 'branch')?.people).toBe(60)
    expect(m.links.find((l) => l.kind === 'bypass')?.people).toBe(20)
    // 60 + 20 = 80, not 100 -- the widths were scaled, the numbers were not.
    const out = m.links.filter((l) => l.from === 0)
    expect(out.reduce((t, l) => t + l.people, 0)).toBe(80)
  })

  it('names the overlap when the legs out of a node exceed it', () => {
    // Someone did the optional step AFTER the next required one, so they are
    // on the branch leg and on the bypass leg both.
    const overlapping: StepResult[] = [
      step({ index: 1, event: 'a', people: 60, from_previous: 1, from_start: 1 }),
      step({
        index: 2,
        event: 'b',
        people: 30,
        from_previous: 0.5,
        from_start: 0.5,
        optional: true,
        skipped: 30,
        continued: 25,
      }),
      step({ index: 3, event: 'c', people: 60, from_previous: 1, from_start: 1 }),
    ]
    const m = sankeyModel(overlapping, 60)
    // out of a: 30 (branch) + 35 (bypass) = 65 against a node of 60.
    expect(m.nodes[0]?.overlap).toBe(5)
    expect(m.nodes[2]?.overlap).toBe(0)
  })

  it('clamps bypass at zero, which skipped is deliberately never', () => {
    // Two optional steps between one pair can BOTH claim the same person, so
    // the inflows can exceed the node and bypass has nowhere to go but zero.
    // `skipped` is exact by construction and is not clamped anywhere -- these
    // two rules must not be made to match.
    const twin: StepResult[] = [
      step({ index: 1, event: 'a', people: 100, from_previous: 1, from_start: 1 }),
      step({
        index: 2,
        event: 'b',
        people: 90,
        from_previous: 0.9,
        from_start: 0.9,
        optional: true,
        skipped: 10,
        continued: 80,
      }),
      step({
        index: 3,
        event: 'c',
        people: 90,
        from_previous: 0.9,
        from_start: 0.9,
        optional: true,
        skipped: 10,
        continued: 80,
      }),
      step({ index: 4, event: 'd', people: 100, from_previous: 1, from_start: 1 }),
    ]
    const m = sankeyModel(twin, 100)
    expect(m.links.find((l) => l.kind === 'bypass')?.people).toBe(0)
    expect(m.nodes[3]?.overlap).toBe(60)
  })

  it("gives an optional node its branch point's ramp step, not the next one", () => {
    const m = sankeyModel(BRANCHED, 100)
    const branchPoint = m.nodes[0]
    const optional = m.nodes.find((n) => n.optional)
    expect(optional?.ramp).toBe(branchPoint?.ramp)
  })

  it('reports zeroes rather than NaN on a funnel nobody entered', () => {
    const m = sankeyModel(LINEAR, 0)
    expect(m.links.every((l) => Number.isFinite(l.rate))).toBe(true)
    expect(m.links.every((l) => Number.isFinite(l.w0) && Number.isFinite(l.w1))).toBe(true)
    expect(m.nodes.every((n) => Number.isFinite(n.height))).toBe(true)
  })
})
