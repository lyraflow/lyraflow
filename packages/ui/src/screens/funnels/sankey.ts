import type { StepResult } from '../../api/types.js'
import {
  MIN_BAR_HEIGHT,
  barHeight,
  branchSlots,
  rampIndexes,
  scaleHeight,
  spineSlots,
} from './flowGeometry.js'

/** Vertical gap between the required centre line and an offset branch, and
 * between two branches stacked off the same step. */
const BRANCH_GAP = 32

/**
 * How far a drop-off ribbon displaces, away from the flow, before it has
 * faded out.
 *
 * Vertical, so it lives here rather than in the renderer: it is the reason
 * the plot is taller than its nodes, and a model that did not account for it
 * would have the renderer draw outside the viewBox and get the ribbon
 * clipped. The horizontal reach is the renderer's, because it changes
 * nothing about how much room the plot needs.
 */
export const PEEL_DY = 64

/* NO GAP BETWEEN BANDS AT A NODE'S EDGE, deliberately, and this was tried the
 * other way first.
 *
 * A 16-unit gap was added to stop bands merging into one mass. It did, and it
 * cost two things that matter more. The stack's extent became `people + gaps`,
 * so two bands accounting for every one of a node's people still ran past its
 * edge -- an overflow that means "two paths claim the same person" was being
 * drawn where nothing overlapped at all. And at a node with drop-off it split
 * the empty space in two: a gap between the bands and the real remainder
 * below, reading as two different quantities when only one exists.
 *
 * Flush, the stack's extent IS the sum of its people. Space under the bands is
 * exactly the drop-off, and anything past the edge is exactly a double-count.
 * What separates the bands instead is the drop-off itself where there is any,
 * and the weight and dash of the optional path where there is not. */

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

/**
 * The people who reached a step and went no further, as a quantity with a
 * place on the page.
 *
 * A drop-off used to be nothing at all -- the space under a node's bands, and
 * the reader was left to infer a number from an absence. It is a real
 * population, the same one `biggestLeak` names in a sentence, so it is drawn:
 * a ribbon leaving the node and fading out.
 *
 * `up` is which way it leaves, and the rule is that it always leaves AWAY
 * from the flow -- down off a required node, up off a branch node, because a
 * branch node is itself lifted above the required line and its flow is below
 * it. Peeling the same direction off both was the first attempt: a branch
 * node's ribbon then crossed its own outgoing band and the band beneath it,
 * which is the collision this redesign existed to remove.
 */
export interface SankeyDrop {
  node: number // node index
  people: number // TRUE count, printed
  top: number // top edge where the ribbon leaves the node
  w: number // thickness, on the same scale as every node and band
  up: boolean
}

export interface SankeyModel {
  nodes: SankeyNode[]
  links: SankeyLink[]
  drops: SankeyDrop[]
  /** One step's share of the plot's width, in pixels. */
  slot: number
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

export function sankeyModel(
  steps: readonly StepResult[],
  entered: number,
  /**
   * The plot's width IN PIXELS, measured from the element it is drawn into.
   *
   * Not a constant, and not a unit of its own: the SVG's viewBox is this
   * number, so one model unit is one CSS pixel on BOTH axes. Everything the
   * old stretched space made impossible follows from that -- a node with
   * round caps rather than oval ones, a stroke the same weight horizontally
   * and vertically, and a mark that can be inset by a fixed amount and come
   * out square. See `FunnelFlow`, which measures it.
   */
  width: number,
): SankeyModel {
  const ramp = rampIndexes(steps)
  const branches = branchSlots(steps)
  const slot = Math.max(1, width) / Math.max(1, steps.length)

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
    x: i * slot,
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

  // 3. THICKNESS -- ONE SCALE FOR THE WHOLE PLOT.
  //
  //    A band is drawn at its own people count through the same scale as
  //    every node, so `w0 === w1`: a band carries one quantity and has one
  //    thickness. It does not taper, and it is comparable to every other
  //    band and node on the chart.
  //
  //    This replaced scaling each node's bands to fill its edge exactly.
  //    That guaranteed the geometry always "added up", at the cost of the
  //    two things a flow diagram is read for: a width meant something only
  //    against the one node it touched, and a node's edge was always fully
  //    covered, so a funnel that converts everyone drew as a solid rectangle
  //    with no space anywhere in it. Reported from a real funnel.
  for (const l of links) {
    l.w0 = scaleHeight(l.people, entered)
    l.w1 = l.w0
  }

  // 4. DROP-OFF, before the bands are stacked, because it decides where the
  //    stack starts.
  //
  //    A node's drop-off is its height less everything that leaves it. It
  //    sits on the node's OUTWARD edge -- the bottom of a required node, the
  //    top of a branch node -- so the ribbon drawn from it always leaves away
  //    from the flow. For a branch node that means the continuing bands start
  //    BELOW its drop rather than at its top edge, which is the whole reason
  //    this is computed here and not in the renderer.
  //
  //    A node with no outgoing links at all is the funnel's last step: nobody
  //    can drop out of it, because there is nothing left to fail to do. That
  //    is not the same as a node whose outgoing links carry zero people --
  //    there, everyone dropped, and the ribbon says so.
  const outWidth = new Map<number, number>()
  const outPeople = new Map<number, number>()
  const hasOut = new Set<number>()
  for (const l of links) {
    hasOut.add(l.from)
    outWidth.set(l.from, (outWidth.get(l.from) ?? 0) + l.w0)
    outPeople.set(l.from, (outPeople.get(l.from) ?? 0) + l.people)
  }

  const drops: SankeyDrop[] = []
  const stackTop = new Map<number, number>()
  for (const [i, node] of nodes.entries()) {
    if (!hasOut.has(i)) continue
    const out = outWidth.get(i) ?? 0
    // Clamped, both of them: where two paths claim the same person the bands
    // genuinely exceed the node, and neither a negative thickness nor a
    // negative population is a quantity. `overlap` below is what names that
    // case, and it must stay the only place it is named.
    const lost = Math.max(0, node.height - out)
    if (node.optional) stackTop.set(i, node.y + lost)
    if (lost <= 0) continue
    drops.push({
      node: i,
      // Counted from PEOPLE, never from the widths. The widths are a
      // rendering of the counts and carry a floor (`MIN_BAR_HEIGHT`) and a
      // rounding; reading a printed population back out of them would put a
      // number on the screen that no query returned.
      people: Math.max(0, node.people - (outPeople.get(i) ?? 0)),
      top: node.optional ? node.y : node.y + out,
      w: lost,
      up: node.optional,
    })
  }

  // 5. y0 / y1 stack the links along each node's edge in link order, so two
  //    links leaving (or arriving at) one node do not overlap. Flush, with
  //    no gap: the stack's extent is then exactly the sum of its people, so
  //    the space beside it is exactly the drop-off and anything past the
  //    node's edge is exactly a double count.
  const outCursor = new Map<number, number>()
  const inCursor = new Map<number, number>()
  for (const l of links) {
    const src = nodes[l.from] as SankeyNode
    const dst = nodes[l.to] as SankeyNode
    const y0 = outCursor.get(l.from) ?? stackTop.get(l.from) ?? src.y
    l.y0 = y0
    outCursor.set(l.from, y0 + l.w0)
    const y1 = inCursor.get(l.to) ?? dst.y
    l.y1 = y1
    inCursor.set(l.to, y1 + l.w1)
  }

  // 6. overlap = max(0, Σ(outgoing people) - people, Σ(incoming people) -
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

  // 7. NORMALISE, over everything that is drawn -- nodes, bands AND the
  //    ribbons, whose upward reach is what usually sets the top of the plot.
  //    Sizing from the nodes alone clips exactly the thing the reader most
  //    needs to see, and clips it silently.
  const tops = [
    ...nodes.map((n) => n.y),
    ...links.map((l) => Math.min(l.y0, l.y1)),
    ...drops.map((d) => (d.up ? d.top - PEEL_DY : d.top)),
  ]
  const minY = tops.length > 0 ? Math.min(...tops) : 0
  for (const node of nodes) node.y -= minY
  for (const l of links) {
    l.y0 -= minY
    l.y1 -= minY
  }
  for (const d of drops) d.top -= minY

  const extents = [
    ...nodes.map((n) => n.y + n.height),
    ...links.map((l) => Math.max(l.y0 + l.w0, l.y1 + l.w1)),
    ...drops.map((d) => (d.up ? d.top + d.w : d.top + PEEL_DY + d.w)),
  ]
  const height = extents.length > 0 ? Math.max(...extents) : 0

  return { nodes, links, drops, slot, width: Math.max(1, width), height }
}
