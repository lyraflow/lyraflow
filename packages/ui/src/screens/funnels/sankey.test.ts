import { describe, expect, it } from 'vitest'
import type { StepResult } from '../../api/types.js'
import { PEEL_DY, type SankeyLink, type SankeyNode, sankeyModel } from './sankey.js'

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

/** A plot width in CSS pixels, the way the component measures one. Any
 * value works -- the model divides it into equal slots -- so this is fixed
 * to keep the numbers in these tests readable. */
const WIDTH = 900
const SLOT = WIDTH / 3

describe('sankeyModel', () => {
  it('gives a linear funnel one node per step and one link per pair', () => {
    const m = sankeyModel(LINEAR, 100, WIDTH)
    expect(m.nodes).toHaveLength(3)
    expect(m.links).toHaveLength(2)
    expect(m.links.every((l) => l.kind === 'chain')).toBe(true)
    expect(m.links[0]).toMatchObject({ from: 0, to: 1, people: 80 })
    expect(m.links[1]).toMatchObject({ from: 1, to: 2, people: 40 })
    // 'chain' takes the server's own from_previous, unmodified.
    expect(m.links[0]?.rate).toBeCloseTo(0.8, 5)
    expect(m.links[1]?.rate).toBeCloseTo(0.5, 5)
  })

  it('puts every node of a linear funnel on one centre line', () => {
    const m = sankeyModel(LINEAR, 100, WIDTH)
    const centres = m.nodes.map((n) => n.y + n.height / 2)
    expect(new Set(centres.map((c) => Math.round(c)))).toHaveLength(1)
  })

  it('forks and rejoins around an optional step', () => {
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    const kinds = m.links.map((l) => l.kind).sort()
    expect(kinds).toEqual(['branch', 'bypass', 'continue'])
    expect(m.links.find((l) => l.kind === 'branch')).toMatchObject({ from: 0, to: 1, people: 60 })
    expect(m.links.find((l) => l.kind === 'continue')).toMatchObject({ from: 1, to: 2, people: 50 })
    // 70 reached c, 50 of them through b.
    expect(m.links.find((l) => l.kind === 'bypass')).toMatchObject({ from: 0, to: 2, people: 20 })
    // branch: 60/100 against a. continue: 50/60 against b. bypass: 20/100
    // against a -- the SOURCE, not the 70-person destination.
    expect(m.links.find((l) => l.kind === 'branch')?.rate).toBeCloseTo(0.6, 5)
    expect(m.links.find((l) => l.kind === 'continue')?.rate).toBeCloseTo(50 / 60, 5)
    expect(m.links.find((l) => l.kind === 'bypass')?.rate).toBeCloseTo(0.2, 5)
  })

  it("offsets an optional node's bottom BRANCH_GAP above the centre line the required nodes share", () => {
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    const required = m.nodes.filter((n) => !n.optional)
    const requiredCentre = (required[0]?.y ?? 0) + (required[0]?.height ?? 0) / 2
    for (const n of required) {
      expect(n.y + n.height / 2).toBeCloseTo(requiredCentre, 5)
    }
    const optional = m.nodes.find((n) => n.optional)
    expect(optional).toBeDefined()
    const optionalBottom = (optional?.y ?? 0) + (optional?.height ?? 0)
    // The gap is pinned to its literal value, not to whatever constant the
    // module happens to use internally -- a shrunk gap must fail this too.
    expect(requiredCentre - optionalBottom).toBeCloseTo(32, 5)
  })

  it('draws every band at ONE scale, so a thickness means the same people anywhere', () => {
    // THE POINT OF THE DESIGN. Bands used to be scaled to fill each node's
    // own edge, which made a width readable only against the one node it
    // touched and left a funnel that converts everyone as a solid rectangle
    // with no space in it. Now 2.8 units is one person everywhere on the
    // plot -- 280 of scale over 100 entrants. Literals, so a moved scale
    // fails here rather than passing quietly.
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    const branch = m.links.find((l) => l.kind === 'branch') as SankeyLink
    const carry = m.links.find((l) => l.kind === 'continue') as SankeyLink
    const bypass = m.links.find((l) => l.kind === 'bypass') as SankeyLink
    expect(branch.w0).toBeCloseTo(60 * 2.8, 5)
    expect(carry.w0).toBeCloseTo(50 * 2.8, 5)
    expect(bypass.w0).toBeCloseTo(20 * 2.8, 5)
    // The nodes are on that same scale, which is what makes a band and a
    // node comparable at a glance.
    expect((m.nodes[1] as SankeyNode).height).toBeCloseTo(60 * 2.8, 5)
  })

  it('gives a band one thickness, because it carries one quantity', () => {
    // No taper. A band that narrows between its ends says the number changed
    // on the way, and it did not.
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    for (const l of m.links) expect(l.w1).toBeCloseTo(l.w0, 5)
  })

  it('leaves the drop-off as space under a node rather than filling the edge', () => {
    // `a` holds 100 people and 80 leave on a leg, so 20 people's worth of its
    // edge is empty. That space IS the drop-off, and it is the first thing a
    // reader looks for.
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    const a = m.nodes[0] as SankeyNode
    const drawn = m.links.filter((l) => l.from === 0).reduce((t, l) => t + l.w0, 0)
    expect(drawn).toBeCloseTo(80 * 2.8, 5)
    expect(a.height - drawn).toBeCloseTo(20 * 2.8, 5)
  })

  it('lets the bands exceed a node where two paths claim the same person', () => {
    // The mirror of the drop-off case, and it must not be hidden: someone who
    // took the optional step out of order is genuinely on two legs, so the
    // stack genuinely runs past the node. These are funnel 6's real numbers.
    const overlapping: StepResult[] = [
      step({ index: 1, event: 'a', people: 51, from_previous: 1, from_start: 1 }),
      step({
        index: 2,
        event: 'b',
        people: 19,
        from_previous: 0.373,
        from_start: 0.373,
        optional: true,
        skipped: 32,
        continued: 16,
      }),
      step({ index: 3, event: 'c', people: 51, from_previous: 1, from_start: 1 }),
    ]
    const m = sankeyModel(overlapping, 51, WIDTH)
    const a = m.nodes[0] as SankeyNode
    const out = m.links.filter((l) => l.from === 0)
    expect(out.reduce((t, l) => t + l.people, 0)).toBe(54)
    expect(a.overlap).toBe(3)
    expect(out.reduce((t, l) => t + l.w0, 0)).toBeGreaterThan(a.height)
    // And the viewBox grows to hold it rather than clipping the very thing
    // the reader needs to see.
    expect(m.height).toBeGreaterThanOrEqual(Math.max(...m.links.map((l) => l.y0 + l.w0)))
  })

  it('prints the true counts even where the widths were scaled', () => {
    const m = sankeyModel(BRANCHED, 100, WIDTH)
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
    const m = sankeyModel(overlapping, 60, WIDTH)
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
    const m = sankeyModel(twin, 100, WIDTH)
    expect(m.links.find((l) => l.kind === 'bypass')?.people).toBe(0)
    expect(m.nodes[3]?.overlap).toBe(60)
  })

  it('reports overlap on the incoming side too, and keeps two branches off one step apart by BRANCH_GAP', () => {
    // a -> [b opt, c opt, both branching off a] -> d -> e. b and c both claim
    // the same people reaching d: a real 60-person double-count, even though
    // d ALSO has an outgoing (chain) link on to e. Whether that double-count
    // is visible must not depend on d happening to be the last node.
    const doubled: StepResult[] = [
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
      step({ index: 5, event: 'e', people: 90, from_previous: 0.9, from_start: 0.9 }),
    ]
    const m = sankeyModel(doubled, 100, WIDTH)
    expect(m.nodes[3]?.overlap).toBe(60)
    // b and c both hang off the same branch point (a). b is placed first,
    // sitting closer to the centre line; c stacks above it. The gap between
    // b's top and c's bottom is the SAME BRANCH_GAP that separates the
    // centre line from the first branch -- pinned to its literal value, not
    // to the module's own constant.
    const b = m.nodes[1] as SankeyNode
    const c = m.nodes[2] as SankeyNode
    expect(b.y - (c.y + c.height)).toBeCloseTo(32, 5)
  })

  it("gives each node its ramp step, with an optional taking its branch point's", () => {
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    expect(m.nodes.map((n) => n.ramp)).toEqual([1, 1, 2])
  })

  it('stacks the links leaving one node flush from its top edge', () => {
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    const a = m.nodes[0] as SankeyNode
    const out = m.links.filter((l) => l.from === 0).sort((x, y) => x.y0 - y.y0)
    expect(out).toHaveLength(2)
    const [first, second] = out as [SankeyLink, SankeyLink]
    expect(first.y0).toBeCloseTo(a.y, 5)
    // FLUSH, no gap. A gap made the stack's extent `people + gaps`, so two
    // bands covering all of a node's people still ran past its edge -- an
    // overflow that means "two paths claim one person" drawn where nothing
    // overlapped. Flush, the extent IS the people.
    expect(first.y0 + first.w0).toBeCloseTo(second.y0, 5)
  })

  it('stacks the links arriving at one node flush from its top edge', () => {
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    const c = m.nodes[2] as SankeyNode
    const into = m.links.filter((l) => l.to === 2).sort((x, y) => x.y1 - y.y1)
    expect(into).toHaveLength(2)
    const [first, second] = into as [SankeyLink, SankeyLink]
    expect(first.y1).toBeCloseTo(c.y, 5)
    expect(first.y1 + first.w1).toBeCloseTo(second.y1, 5)
  })

  it('sizes the model to the tallest extent reached, ribbons included', () => {
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    // Nothing drawn may fall outside the viewBox: the branch offset above
    // the centre line, and the drop-off ribbons, both reach past the nodes.
    const reach = [
      ...m.nodes.map((n) => n.y + n.height),
      ...m.links.map((l) => Math.max(l.y0 + l.w0, l.y1 + l.w1)),
      ...m.drops.map((d) => (d.up ? d.top + d.w : d.top + PEEL_DY + d.w)),
    ]
    expect(m.height).toBeCloseTo(Math.max(...reach), 5)
    // ...and nothing may fall above it either, which is what the ribbon
    // leaving a branch node upward would otherwise do.
    const top = [
      ...m.nodes.map((n) => n.y),
      ...m.links.map((l) => Math.min(l.y0, l.y1)),
      ...m.drops.map((d) => (d.up ? d.top - PEEL_DY : d.top)),
    ]
    expect(Math.min(...top)).toBeCloseTo(0, 5)
  })

  it('divides the measured width into one equal slot per step', () => {
    const m = sankeyModel(LINEAR, 100, WIDTH)
    expect(m.width).toBe(WIDTH)
    expect(m.slot).toBeCloseTo(SLOT, 5)
    m.nodes.forEach((n, i) => {
      expect(n.step).toBe(i)
      expect(n.x).toBeCloseTo(i * SLOT, 5)
    })
  })

  it('scales x with the measured width, so the model is in CSS pixels', () => {
    // The whole redesign rests on one model unit being one pixel on BOTH
    // axes -- that is what makes a round cap round and a fixed inset square.
    // A model that ignored its width argument would still pass every test
    // above, because they all use one width.
    const narrow = sankeyModel(LINEAR, 100, 300)
    const wide = sankeyModel(LINEAR, 100, 1200)
    expect(wide.slot).toBeCloseTo(narrow.slot * 4, 5)
    expect((wide.nodes[2] as SankeyNode).x).toBeCloseTo((narrow.nodes[2] as SankeyNode).x * 4, 5)
    // Heights are a scale over PEOPLE, not over the width, and must not move.
    expect((wide.nodes[1] as SankeyNode).height).toBeCloseTo(
      (narrow.nodes[1] as SankeyNode).height,
      5,
    )
  })

  it('gives every node that loses people a drop-off, counted from PEOPLE', () => {
    // BRANCHED: 100 entered, step 1 has 100, the branch has 40 of which 25
    // carried on, and step 3 has 60 -- so 35 bypassed and step 1 loses
    // 100 - 40 - 35 = 25.
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    const at = (i: number) => m.drops.find((d) => d.node === i)
    const outOf = (i: number) =>
      m.links.filter((l) => l.from === i).reduce((t, l) => t + l.people, 0)
    for (const d of m.drops) {
      const node = m.nodes[d.node] as SankeyNode
      expect(d.people).toBe(node.people - outOf(d.node))
    }
    expect(at(0)?.people).toBeGreaterThan(0)
  })

  it('never gives the last step a drop-off, and never a negative one', () => {
    // The last step has no outgoing links: nobody can fail to do a step that
    // does not exist. That is NOT the same as a step whose outgoing links
    // carry nobody, where everyone dropped and the ribbon has to say so --
    // the second case is covered below.
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    const last = BRANCHED.length - 1
    expect(m.drops.some((d) => d.node === last)).toBe(false)
    expect(m.drops.every((d) => d.people >= 0 && d.w > 0)).toBe(true)
  })

  it('draws a drop-off for a step everyone abandons', () => {
    const abandoned: StepResult[] = [
      step({ index: 1, event: 'a', people: 50 }),
      step({ index: 2, event: 'b', people: 0, from_previous: 0 }),
    ]
    const m = sankeyModel(abandoned, 50, WIDTH)
    const first = m.drops.find((d) => d.node === 0)
    expect(first?.people).toBe(50)
    expect(first?.w).toBeCloseTo((m.nodes[0] as SankeyNode).height, 5)
  })

  it('reports no drop-off where two paths double-count instead', () => {
    // Outgoing exceeds the node. That is an overlap, which `node.overlap`
    // names; it must not also surface as a negative or zero-width ribbon.
    const doubled: StepResult[] = [
      step({ index: 1, event: 'a', people: 50 }),
      step({ index: 2, event: 'b', people: 45, optional: true, skipped: 5, continued: 20 }),
      step({ index: 3, event: 'c', people: 50 }),
    ]
    const m = sankeyModel(doubled, 50, WIDTH)
    expect(m.drops.some((d) => d.node === 0)).toBe(false)
    expect((m.nodes[0] as SankeyNode).overlap).toBeGreaterThan(0)
  })

  it('peels a drop-off AWAY from the flow — down off a spine step, up off a branch', () => {
    // The direction rule, and it is the whole reason ribbons do not collide.
    // A branch node is lifted ABOVE the required line and its own flow leaves
    // below it, so peeling down would cross both its outgoing band and the
    // bypass band beneath. Rendered that way first; this pins the fix.
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    for (const d of m.drops) {
      expect(d.up).toBe((m.nodes[d.node] as SankeyNode).optional)
    }
    expect(m.drops.some((d) => d.up)).toBe(true)
    expect(m.drops.some((d) => !d.up)).toBe(true)
  })

  it('puts a drop-off on its node’s OUTWARD edge, with the flows on the other', () => {
    // Follows from the direction rule and is a separate claim: a ribbon that
    // leaves upward from the BOTTOM of a node still crosses the node. So a
    // branch node's drop takes its top edge and its outgoing bands start
    // below it, while a spine node's drop takes the bottom and its bands
    // start at the top.
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    for (const d of m.drops) {
      const node = m.nodes[d.node] as SankeyNode
      const out = m.links.filter((l) => l.from === d.node)
      const firstOut = Math.min(...out.map((l) => l.y0))
      if (d.up) {
        // Drop on top, bands below it.
        expect(d.top).toBeCloseTo(node.y, 5)
        expect(firstOut).toBeCloseTo(node.y + d.w, 5)
      } else {
        // Bands from the top, drop under them and flush with the node's foot.
        expect(firstOut).toBeCloseTo(node.y, 5)
        expect(d.top + d.w).toBeCloseTo(node.y + node.height, 5)
      }
    }
  })

  it('leaves no space between a node’s bands and its drop-off', () => {
    // Together they are the node: the ribbon starts exactly where the last
    // band ends. A gap here would be a population the chart draws and never
    // names, which is the defect this replaced.
    const m = sankeyModel(BRANCHED, 100, WIDTH)
    for (const d of m.drops) {
      const node = m.nodes[d.node] as SankeyNode
      const out = m.links.filter((l) => l.from === d.node)
      const bands = out.reduce((t, l) => t + l.w0, 0)
      expect(bands + d.w).toBeCloseTo(node.height, 5)
    }
  })

  it('reports zeroes rather than NaN on a funnel nobody entered', () => {
    const m = sankeyModel(LINEAR, 0, WIDTH)
    expect(m.links.every((l) => Number.isFinite(l.rate))).toBe(true)
    expect(m.links.every((l) => Number.isFinite(l.w0) && Number.isFinite(l.w1))).toBe(true)
    expect(m.nodes.every((n) => Number.isFinite(n.height))).toBe(true)
  })
})
