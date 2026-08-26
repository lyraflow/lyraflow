import type { StepResult } from '../../api/types.js'
import {
  MIN_BAR_HEIGHT,
  SLOT_WIDTH,
  barHeight,
  branchSlots,
  plotWidth,
  rampIndexes,
  spineSlots,
} from './flowGeometry.js'

/** Vertical gap between the required centre line and an offset branch, and
 * between two branches stacked off the same step. */
const BRANCH_GAP = 24

export interface SankeyNode {
  step: number // 0-based index into result.steps
  people: number
  optional: boolean
  ramp: number // copper ramp step, 1-based
  x: number // left edge, viewBox units
  y: number // top edge, viewBox units
  height: number
  /**
   * How many people are counted twice on ONE side of this node -- outgoing
   * or incoming, whichever exceeds the node's own `people` -- or 0.
   *
   * Checked on both sides always, not only the side a node happens to have:
   * a node with outgoing links can still double-count on its incoming side
   * (two optional steps both claiming the same person on their way in), and
   * that must stay visible whether or not the node also sits last.
   */
  overlap: number
}

export interface SankeyLink {
  from: number // node index
  to: number
  people: number // TRUE count, printed
  rate: number // TRUE rate against the source's people, printed
  kind: 'chain' | 'branch' | 'continue' | 'bypass'
  w0: number // thickness at the SOURCE edge
  w1: number // thickness at the DESTINATION edge
  y0: number // top offset at the source edge
  y1: number // top offset at the destination edge
}

export interface SankeyModel {
  nodes: SankeyNode[]
  links: SankeyLink[]
  width: number
  height: number
}

/** A guarded ratio, used both for a link's width (against a node's height)
 * and for a rate (against a scale of 1). A zero-entrant funnel, or an
 * optional step nobody reached, is a real state -- this returns 0 rather
 * than the `NaN` that would otherwise reach an SVG attribute or a printed
 * percentage. */
function share(value: number, total: number, scale: number): number {
  return total <= 0 ? 0 : (value / total) * scale
}

export function sankeyModel(steps: readonly StepResult[], entered: number): SankeyModel {
  const ramp = rampIndexes(steps)
  const branches = branchSlots(steps)

  // 1. NODES. One per step; x by position; height by people over entrants.
  //    Required nodes share one centre line and optional nodes are lifted
  //    off it, stacking upward when two hang off the same required step.
  const heights = steps.map((s) => barHeight(s.people, entered))
  const tallest = Math.max(MIN_BAR_HEIGHT, ...heights)
  const centre = tallest / 2

  const nodes: SankeyNode[] = steps.map((s, i) => ({
    step: i,
    people: s.people,
    optional: s.optional === true,
    ramp: ramp[i] ?? 1,
    x: i * SLOT_WIDTH,
    y: 0,
    height: heights[i] ?? MIN_BAR_HEIGHT,
    overlap: 0,
  }))

  // Cursor per branch point: the bottom edge available for the NEXT optional
  // node stacked off it. Starts one gap above the centre line, and each
  // stacked node leaves the next cursor one gap above its own top.
  const branchCursor = new Map<number, number>()
  for (let i = 0; i < steps.length; i++) {
    const node = nodes[i]
    if (node == null) continue
    if (node.optional) {
      const key = branches[i] ?? -1
      const bottom = branchCursor.get(key) ?? centre - BRANCH_GAP
      node.y = bottom - node.height
      branchCursor.set(key, node.y - BRANCH_GAP)
    } else {
      node.y = centre - node.height / 2
    }
  }

  // Normalise so the highest point (an optional stack can go above 0) sits
  // at y = 0, keeping every coordinate in the model non-negative.
  const minY = nodes.length > 0 ? Math.min(...nodes.map((n) => n.y)) : 0
  for (const node of nodes) node.y -= minY

  // 2. LINKS, per consecutive pair of REQUIRED steps (r, n) with the
  //    optional steps between them. A required pair with none between takes
  //    one 'chain' link.
  const requiredIdx = spineSlots(steps)
  const links: SankeyLink[] = []

  for (let j = 0; j < requiredIdx.length - 1; j++) {
    const r = requiredIdx[j] as number
    const n = requiredIdx[j + 1] as number
    const rStep = steps[r] as StepResult
    const nStep = steps[n] as StepResult
    const ks: number[] = []
    for (let i = r + 1; i < n; i++) ks.push(i)

    if (ks.length === 0) {
      links.push({
        from: r,
        to: n,
        kind: 'chain',
        people: nStep.people,
        rate: nStep.from_previous,
        w0: 0,
        w1: 0,
        y0: 0,
        y1: 0,
      })
      continue
    }

    let continuedSum = 0
    for (const k of ks) {
      const kStep = steps[k] as StepResult
      const continued = kStep.continued ?? 0
      continuedSum += continued
      links.push({
        from: r,
        to: k,
        kind: 'branch',
        people: kStep.people,
        rate: kStep.from_previous,
        w0: 0,
        w1: 0,
        y0: 0,
        y1: 0,
      })
      links.push({
        from: k,
        to: n,
        kind: 'continue',
        people: continued,
        rate: share(continued, kStep.people, 1),
        w0: 0,
        w1: 0,
        y0: 0,
        y1: 0,
      })
    }

    // Clamped at zero: two optional steps between one pair can both claim
    // the same person, so `continuedSum` can exceed `n.people` and bypass
    // has nowhere to go but zero. `skipped` on a StepResult has no such
    // clamp -- it is exact by construction -- and this must not be made to
    // match it.
    const bypassPeople = Math.max(0, nStep.people - continuedSum)
    links.push({
      from: r,
      to: n,
      kind: 'bypass',
      people: bypassPeople,
      rate: share(bypassPeople, rStep.people, 1),
      w0: 0,
      w1: 0,
      y0: 0,
      y1: 0,
    })
  }

  // 3. THICKNESS. w0 fills the source, w1 fills the destination, so a link
  //    TAPERS where the two populations disagree. Geometry always adds up;
  //    the printed counts above are never scaled.
  const outTotals = new Map<number, number>()
  const inTotals = new Map<number, number>()
  for (const l of links) {
    outTotals.set(l.from, (outTotals.get(l.from) ?? 0) + l.people)
    inTotals.set(l.to, (inTotals.get(l.to) ?? 0) + l.people)
  }
  for (const l of links) {
    const src = nodes[l.from] as SankeyNode
    const dst = nodes[l.to] as SankeyNode
    l.w0 = share(l.people, outTotals.get(l.from) ?? 0, src.height)
    l.w1 = share(l.people, inTotals.get(l.to) ?? 0, dst.height)
  }

  // 4. y0 / y1 stack the links along each node's edge in link order, so two
  //    links leaving (or arriving at) one node do not overlap.
  const outCursor = new Map<number, number>()
  const inCursor = new Map<number, number>()
  for (const l of links) {
    const src = nodes[l.from] as SankeyNode
    const dst = nodes[l.to] as SankeyNode
    const y0 = outCursor.get(l.from) ?? src.y
    l.y0 = y0
    outCursor.set(l.from, y0 + l.w0)
    const y1 = inCursor.get(l.to) ?? dst.y
    l.y1 = y1
    inCursor.set(l.to, y1 + l.w1)
  }

  // 5. overlap = max(0, Σ(outgoing people) - people, Σ(incoming people) -
  //    people), checked on BOTH sides always. A node with outgoing links can
  //    still double-count on its incoming side -- whether a double-count is
  //    visible must not depend on whether the node happens to be last.
  for (const [i, node] of nodes.entries()) {
    const out = links.filter((l) => l.from === i)
    const into = links.filter((l) => l.to === i)
    const outSum = out.reduce((t, l) => t + l.people, 0)
    const inSum = into.reduce((t, l) => t + l.people, 0)
    node.overlap = Math.max(0, outSum - node.people, inSum - node.people)
  }

  // 6. height = the tallest extent any node reaches, so the caller sizes its
  //    own viewBox; width = plotWidth(steps.length).
  const height = nodes.length > 0 ? Math.max(...nodes.map((n) => n.y + n.height)) : 0

  return { nodes, links, width: plotWidth(steps.length), height }
}
