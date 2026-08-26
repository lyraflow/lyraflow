import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { FunnelRunResult, FunnelStep, StepResult } from '../../api/types.js'
import { FunnelFlow } from './FunnelFlow.js'

const step = (over: Partial<StepResult> & { index: number }): StepResult => ({
  event: `e${over.index}`,
  people: 0,
  from_previous: 1,
  from_start: 1,
  ...over,
})

function result(over: Partial<FunnelRunResult> = {}): FunnelRunResult {
  return {
    entered: 100,
    converted: 25,
    conversion_rate: 0.25,
    partial_window_entrants: 0,
    steps: [
      step({ index: 1, event: '$page', people: 100, from_previous: 1, from_start: 1 }),
      step({ index: 2, event: 'docs_search', people: 25, from_previous: 0.25, from_start: 0.25 }),
    ],
    range: { since: '2026-08-15T00:00:00Z', until: '2026-08-22T00:00:00Z' },
    as_of: '2026-08-22T00:00:00Z',
    warnings: [],
    ...over,
  } as FunnelRunResult
}

// Step 3 of four is optional: it branches off step 2 and step 4 follows
// step 2 on the spine. 30 of step 2's 80 took the branch, 50 did not, 24 of
// the 30 went on to step 4, and step 4 has 40 -- deliberately unrelated
// numbers, so a rendering that confuses the branch with the chain shows it.
const BRANCHED = result({
  entered: 100,
  converted: 40,
  conversion_rate: 0.4,
  steps: [
    step({ index: 1, event: 'signup', people: 100, from_previous: 1, from_start: 1 }),
    step({ index: 2, event: 'onboarded', people: 80, from_previous: 0.8, from_start: 0.8 }),
    step({
      index: 3,
      event: 'video_submitted',
      people: 30,
      from_previous: 0.375,
      from_start: 0.3,
      optional: true,
      skipped: 50,
      continued: 24,
    }),
    step({ index: 4, event: 'purchase', people: 40, from_previous: 0.5, from_start: 0.4 }),
  ],
})

// Two optional steps hanging off ONE required step, which is the shape
// that pushes the plot past the height a single bar can reach: the second
// branch stacks above the first, above the required centre line.
const TWO_BRANCHES = result({
  entered: 100,
  converted: 40,
  conversion_rate: 0.4,
  steps: [
    step({ index: 1, event: 'a', people: 100, from_previous: 1, from_start: 1 }),
    step({ index: 2, event: 'b', people: 80, from_previous: 0.8, from_start: 0.8 }),
    step({
      index: 3,
      event: 'c',
      people: 30,
      from_previous: 0.375,
      from_start: 0.3,
      optional: true,
      skipped: 50,
      continued: 20,
    }),
    step({
      index: 4,
      event: 'd',
      people: 20,
      from_previous: 0.25,
      from_start: 0.2,
      optional: true,
      skipped: 60,
      continued: 10,
    }),
    step({ index: 5, event: 'e', people: 40, from_previous: 0.5, from_start: 0.4 }),
  ],
})

// Every link `TWO_BRANCHES` produces, in the model's own order: chain 1->2,
// branch 2->3, continue 3->5, branch 2->4, continue 4->5, bypass 2->5.
// Three leave node 2 and three arrive at node 5, which is what makes this
// the fixture that can see both edges of a node at once.
const TWO_BRANCH_LINKS: [number, number][] = [
  [1, 2],
  [2, 3],
  [3, 5],
  [2, 4],
  [4, 5],
  [2, 5],
]

// Every link `BRANCHED` produces, in the model's own order: chain 1->2,
// branch 2->3, continue 3->4, bypass 2->4. The one-optional shape is the one
// the product actually ships, so the invariant below is asserted on it too
// rather than living only on the five-node fixture.
const BRANCHED_LINKS: [number, number][] = [
  [1, 2],
  [2, 3],
  [3, 4],
  [2, 4],
]

/**
 * All four endpoints of a band, recovered from its `d`.
 *
 * `bandPath` writes `M x0 y0 C mid y0, mid y1, x1 y1 L x1 y1+w1 C mid y1+w1,
 * mid y0+w0, x0 y0+w0 Z`, so dropping the command letters leaves sixteen
 * numbers with every endpoint among them. Reading the SOURCE side alone --
 * which is all this file used to do -- leaves `y1` and `w1` unread, and a
 * band that arrives at the wrong place or the wrong thickness looks
 * identical from here.
 */
function band(from: number, to: number) {
  const d = screen.getByTestId(`flow-link-${from}-${to}`).getAttribute('d') ?? ''
  const n = d
    .trim()
    .split(/[\s,]+/)
    .filter((t) => t !== '' && !Number.isNaN(Number(t)))
    .map(Number)
  expect(n).toHaveLength(16)
  const at = (i: number) => n[i] as number
  return {
    from,
    to,
    x0: at(0),
    y0: at(1),
    w0: at(15) - at(1),
    x1: at(6),
    y1: at(7),
    w1: at(9) - at(7),
  }
}

/** A node's drawn rectangle. */
function box(index: number) {
  const el = screen.getByTestId(`flow-node-${index}`)
  const num = (name: string) => Number(el.getAttribute(name) ?? Number.NaN)
  return { x: num('x'), y: num('y'), width: num('width'), height: num('height') }
}

/** The viewBox `width height` pair of an `<svg>`. */
function viewBox(svg: Element | null): { width: number; height: number } {
  const parts = (svg?.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/)
  return { width: Number(parts[2]), height: Number(parts[3]) }
}

/**
 * The tiling invariant, on BOTH edges of every node of the funnel currently
 * rendered.
 *
 * A band is a quadrilateral between two node edges, and on either side of a
 * node the bands touching it are disjoint and together span that node
 * exactly -- no gap, no overlap, nothing spilling past.
 *
 * **The edges are walked in the model's LINK order and deliberately not
 * sorted by offset.** Sorting throws the stacking order away, and an
 * invariant satisfied by any permutation is not the invariant `sankeyModel`
 * step 4 promises -- it stacks the links "in link order". Reversing that
 * iteration leaves every band still tiling its node, and sends the branch
 * out of the BOTTOM of a node it is lifted above, crossing the bypass that
 * should sit under it. `links` arrives here in the order the model emits, so
 * walking it pins the order in the same loop that pins the tiling.
 */
function tilesEveryNodeEdge(links: readonly [number, number][], nodeCount: number) {
  const bands = links.map(([from, to]) => band(from, to))
  expect(screen.getAllByTestId(/^flow-link-/)).toHaveLength(bands.length)

  // The literal 16, not the module's own `LINK_GAP`. Asserting against the
  // constant would keep passing if the constant moved, which is how a test
  // that names a value stops pinning it.
  const GAP = 16
  /** Bands stack DOWN FROM a node's top edge, disjoint, one gap apart.
   *
   * They no longer end at the node's bottom, and that is the design: a band
   * is drawn at its own people count on the plot's single scale, so the space
   * left under them is the drop-off and any excess is a genuine double-count.
   * What this walk still owns is that the renderer lays the model out
   * faithfully -- start at the top, no overlap, one gap between. The scale
   * itself is pinned in `sankey.test.ts`, against the people counts. */
  const spans = (edges: { start: number; thickness: number }[], node: ReturnType<typeof box>) => {
    let cursor = node.y
    for (const edge of edges) {
      // A zero-thickness band would let two of them claim one offset and
      // still stack, so the disjointness this walk asserts would mean nothing.
      expect(edge.thickness).toBeGreaterThan(0)
      expect(edge.start).toBeCloseTo(cursor, 1)
      cursor += edge.thickness + GAP
    }
  }

  for (let index = 1; index <= nodeCount; index++) {
    const node = box(index)
    const out = bands.filter((b) => b.from === index)
    const into = bands.filter((b) => b.to === index)
    if (out.length > 0) {
      spans(
        out.map((b) => ({ start: b.y0, thickness: b.w0 })),
        node,
      )
    }
    if (into.length > 0) {
      spans(
        into.map((b) => ({ start: b.y1, thickness: b.w1 })),
        node,
      )
    }
  }
  return bands
}

describe('FunnelFlow', () => {
  it('draws one node per step, sized against the entrant count', () => {
    render(<FunnelFlow result={result()} />)
    // Pinned by VALUE, not by shape: 100/100 is the full scale and 25/100 a
    // quarter of it. A test asserting only "has a height" would pass against
    // a chart that drew every node the same.
    expect(screen.getByTestId('flow-node-1')).toHaveAttribute('height', '280')
    expect(screen.getByTestId('flow-node-2')).toHaveAttribute('height', '70')
  })

  it('labels each step with from_start, not from_previous', () => {
    // THE MUTATION THIS FILE EXISTS FOR. The two rates differ only once a
    // funnel has three steps and both are plausible on screen, so swapping
    // them is invisible to a reader and to any test that checks "a
    // percentage is shown". Step 3 below is 40% of the previous step and 20%
    // of the start; the label must be the latter.
    render(
      <FunnelFlow
        result={result({
          entered: 100,
          converted: 20,
          conversion_rate: 0.2,
          steps: [
            step({ index: 1, event: 'a', people: 100, from_previous: 1, from_start: 1 }),
            step({ index: 2, event: 'b', people: 50, from_previous: 0.5, from_start: 0.5 }),
            step({ index: 3, event: 'c', people: 20, from_previous: 0.4, from_start: 0.2 }),
          ],
        })}
      />,
    )
    const third = screen.getByTestId('flow-step-3')
    expect(within(third).getByText('20.0%')).toBeInTheDocument()
    expect(within(third).queryByText('40.0%')).not.toBeInTheDocument()
  })

  it('names the biggest leak by the step that lost the most', () => {
    render(
      <FunnelFlow
        result={result({
          entered: 100,
          converted: 18,
          conversion_rate: 0.18,
          steps: [
            step({ index: 1, event: 'sessions', people: 100, from_previous: 1, from_start: 1 }),
            step({ index: 2, event: 'paywall', people: 80, from_previous: 0.8, from_start: 0.8 }),
            step({ index: 3, event: 'checkout', people: 20, from_previous: 0.25, from_start: 0.2 }),
            step({ index: 4, event: 'purchase', people: 18, from_previous: 0.9, from_start: 0.18 }),
          ],
        })}
      />,
    )
    const leak = screen.getByTestId('funnel-biggest-leak')
    expect(leak).toHaveTextContent('checkout')
    expect(leak).toHaveTextContent('75.0%')
  })

  it('says nothing about leaks when no step loses anyone', () => {
    render(
      <FunnelFlow
        result={result({
          entered: 10,
          converted: 10,
          conversion_rate: 1,
          steps: [
            step({ index: 1, event: 'a', people: 10, from_previous: 1, from_start: 1 }),
            step({ index: 2, event: 'b', people: 10, from_previous: 1, from_start: 1 }),
          ],
        })}
      />,
    )
    expect(screen.queryByTestId('funnel-biggest-leak')).not.toBeInTheDocument()
  })

  it('shows a step’s where clause, and only against the step it belongs to', () => {
    const definition: FunnelStep[] = [
      { event: '$page', where: [{ property: 'path', operator: '=', value: '/docs' }] },
      { event: 'docs_search' },
    ]
    render(<FunnelFlow result={result()} definition={definition} />)
    expect(screen.getByTestId('flow-step-1-where')).toHaveTextContent('/docs')
    expect(screen.queryByTestId('flow-step-2-where')).not.toBeInTheDocument()
  })

  it('renders no where clause when the definition and the result may not correspond', () => {
    // Two independent requests produced these. A narrowing shown against the
    // wrong step would have an operator act on a population the screen never
    // measured, and that failure is silent -- so position agreement is not
    // enough, the event name has to match too.
    const stale: FunnelStep[] = [
      { event: 'something_else', where: [{ property: 'path', operator: '=', value: '/docs' }] },
      { event: 'docs_search' },
    ]
    render(<FunnelFlow result={result()} definition={stale} />)
    expect(screen.queryByTestId('flow-step-1-where')).not.toBeInTheDocument()
  })

  it('bounds the plot PER STAGE, so two steps do not bridge and eight do not compress', () => {
    // Both bounds answer a rendering finding. The ceiling: uncapped, two
    // steps across a wide card put ~700px of band between them and read as
    // a bridge. The floor: capping the WHOLE plot at 200px a stage pinned a
    // three-stage funnel to 600px on any screen -- reported as squeezed.
    // Per stage, both can hold. Literals, so a moved constant fails here.
    render(<FunnelFlow result={result()} />)
    expect(screen.getByTestId('funnel-flow').querySelector('[style*="max-width"]')).toHaveStyle({
      minWidth: '290px',
      maxWidth: '640px',
    })
  })

  it('keeps every step inside the seven colours the stylesheet defines', () => {
    // An eight-step funnel is legal (MAX_FUNNEL_STEPS) and the validated ramp
    // has seven steps. A `--chart-funnel-8` would resolve to nothing and the
    // node would render with no fill at all.
    const eight = Array.from({ length: 8 }, (_, i) =>
      step({
        index: i + 1,
        event: `e${i + 1}`,
        people: 100 - i * 10,
        from_start: (100 - i * 10) / 100,
      }),
    )
    const { container } = render(
      <FunnelFlow result={result({ entered: 100, converted: 30, steps: eight })} />,
    )
    expect(container.innerHTML).not.toContain('--chart-funnel-8')
    expect(container.innerHTML).toContain('--chart-funnel-7')
  })

  it('sizes the viewBox from the model’s own height rather than a constant', () => {
    // The one thing a constant cannot do. Two optional steps stack ABOVE the
    // required centre line, so the plot has to be taller than any single
    // node -- 228 units against a 180-unit full-height node. A hardcoded
    // height clips the upper branch off the top, which is invisible to every
    // assertion that only reads attributes on the nodes.
    render(<FunnelFlow result={TWO_BRANCHES} />)
    const svg = screen.getByRole('img')
    const box = (svg.getAttribute('viewBox') ?? '').split(' ')
    const height = Number(box[3])
    const lowest = Math.max(
      ...[1, 2, 3, 4, 5].map((i) => {
        const n = screen.getByTestId(`flow-node-${i}`)
        return Number(n.getAttribute('y') ?? 0) + Number(n.getAttribute('height') ?? 0)
      }),
    )
    expect(height).toBeGreaterThanOrEqual(lowest)
    expect(height).toBeGreaterThan(180)
    // And the pixel height matches the viewBox height, which is what makes a
    // model y a CSS offset for the label layer with no conversion.
    expect(svg.getAttribute('height')).toBe(String(height))
  })
})

describe('FunnelFlow selection', () => {
  it("calls onSelectStep with the step's 1-indexed index when its node is clicked", async () => {
    const user = userEvent.setup()
    const onSelectStep = vi.fn()
    render(<FunnelFlow result={result()} onSelectStep={onSelectStep} />)
    await user.click(screen.getByTestId('flow-step-2-select'))
    expect(onSelectStep).toHaveBeenCalledTimes(1)
    expect(onSelectStep).toHaveBeenCalledWith(2)
  })

  it('marks only the selected step as pressed, via aria-pressed rather than colour alone', () => {
    render(<FunnelFlow result={result()} selectedStep={2} onSelectStep={() => {}} />)
    expect(screen.getByTestId('flow-step-1-select')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('flow-step-2-select')).toHaveAttribute('aria-pressed', 'true')
  })

  it('names each step button with what it does and which step it means -- the event name alone is ambiguous when two steps share it', () => {
    render(<FunnelFlow result={result()} onSelectStep={() => {}} />)
    expect(screen.getByTestId('flow-step-2-select')).toHaveAccessibleName(
      'Show people at step 2: docs_search',
    )
  })

  it('renders no selection buttons, and nothing focusable, without onSelectStep -- the builder preview has no funnel id to list people for', () => {
    render(<FunnelFlow result={result()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('puts the click target on the NODE, not across the whole slot', () => {
    // A slot-wide target covers the bands crossing that slot as well, and
    // clicking a band to select the step it merely passes is a lie about
    // what was clicked. The target is centred on the node it selects, and
    // grown only so a node at the floor height is still hittable.
    render(<FunnelFlow result={BRANCHED} onSelectStep={() => {}} />)
    const node = screen.getByTestId('flow-node-3')
    const y = Number(node.getAttribute('y') ?? 0)
    const height = Number(node.getAttribute('height') ?? 0)
    const button = screen.getByTestId('flow-step-3-select')
    const top = Number.parseFloat(button.style.top)
    const buttonHeight = Number.parseFloat(button.style.height)
    // Pinned to the node's OWN extent, not merely "the node's centre is
    // somewhere inside it" -- a target spanning the whole plot satisfies
    // that and is exactly the mutation this exists to catch. This node is
    // 54 units tall, comfortably past the floor the target is grown to.
    expect(height).toBeGreaterThan(24)
    expect(top).toBeCloseTo(y, 5)
    expect(buttonHeight).toBeCloseTo(height, 5)
    // And a node's width, not a slot's -- a slot is 100 viewBox units and
    // would be a percentage, not a fixed handful of pixels.
    expect(button.style.width).toBe('28px')
  })

  it('has no ancestor that disables pointer events -- any such ancestor makes the button permanently unclickable in a real browser, even though jsdom cannot detect that from a click alone', () => {
    // A structural check that a button merely sits OUTSIDE the label overlay
    // is a proxy for this, not the invariant itself: it is defeated by
    // `pointer-events-none` landing on the new layer's OWN wrapper, which is
    // still "outside" the label overlay yet still swallows every click. The
    // real rule is about the whole ancestor chain, not one named container.
    render(<FunnelFlow result={result()} onSelectStep={() => {}} />)
    const button = screen.getByTestId('flow-step-1-select')
    let node: Element | null = button.parentElement
    let disabledBy: Element | null = null
    while (node) {
      if (/pointer-events-none/.test(node.className)) {
        disabledBy = node
        break
      }
      node = node.parentElement
    }
    expect(disabledBy).toBeNull()
  })
})

describe('FunnelFlow with an optional step', () => {
  it('draws one node per step and one link per model link', () => {
    // BRANCHED is signup -> onboarded -> [video_submitted] -> purchase, so
    // the spine is signup, onboarded, purchase and the links are:
    // signup->onboarded (chain), onboarded->video (branch),
    // video->purchase (continue), onboarded->purchase (bypass). FOUR.
    render(<FunnelFlow result={BRANCHED} />)
    expect(screen.getAllByTestId(/^flow-node-/)).toHaveLength(4)
    expect(screen.getAllByTestId(/^flow-link-/)).toHaveLength(4)
  })

  it('labels every link with its own true count and rate', () => {
    // `flow-link-{from.index}-{to.index}`, using StepResult.index, which is
    // 1-based. onboarded is index 2 and video_submitted index 3.
    render(<FunnelFlow result={BRANCHED} />)
    const branch = screen.getByTestId('flow-link-2-3')
    expect(branch).toHaveTextContent('37.5%')
    expect(branch).toHaveTextContent('30')
  })

  it('draws that same count and rate ON the band, not only in its tooltip', () => {
    // The `<title>` above is the hover text; this is the label a reader sees
    // without hovering, and a chart whose numbers exist only on hover has
    // not drawn them. Both are asserted so neither can be deleted quietly.
    render(<FunnelFlow result={BRANCHED} />)
    const label = screen.getByTestId('flow-rate-2-3')
    expect(label).toHaveTextContent('30')
    expect(label).toHaveTextContent('37.5%')
    // The bypass carries its OWN numbers, against its own source: 16 of
    // onboarded's 80 reached purchase without the branch.
    expect(screen.getByTestId('flow-rate-2-4')).toHaveTextContent('16')
    expect(screen.getByTestId('flow-rate-2-4')).toHaveTextContent('20.0%')
  })

  it('tints a link from its SOURCE node, so a band says which stage it left', () => {
    render(<FunnelFlow result={BRANCHED} />)
    const link = screen.getByTestId('flow-link-2-3')
    expect(link.getAttribute('fill')).toContain('--chart-funnel-')
  })

  it('tints by the source even where that DISAGREES with the destination', () => {
    // The mutation the assertion above cannot catch: tinting every band by
    // where it LANDS also puts `--chart-funnel-` in the attribute, and paints
    // two bands arriving at one node identically at exactly the point a
    // reader is trying to tell them apart. Three spine stages here, so the
    // ramp runs 1, 2, 3 and the branch borrows 2 -- the continue link runs
    // 2 -> 3 and must carry its source's 2, never its destination's 3.
    render(<FunnelFlow result={BRANCHED} />)
    expect(screen.getByTestId('flow-link-1-2')).toHaveAttribute('fill', 'var(--chart-funnel-1)')
    expect(screen.getByTestId('flow-link-3-4')).toHaveAttribute('fill', 'var(--chart-funnel-2)')
  })

  it('tiles both edges of every node with the bands that touch it, and lays them out on the model’s x axis', () => {
    // ONE test for a class of mutation, not one per mutation. The previous
    // version of this read `y0` and `w0` off a single node's outgoing side,
    // which pinned exactly the mutation it was written for and left the
    // destination edge and the whole horizontal axis unread -- so `y1 -> y0`,
    // `w1 -> w0`, a `nodeLeft` that ignores `node.x` and a constant viewBox
    // width all passed the entire suite.
    //
    // The invariant instead, in `tilesEveryNodeEdge`: on EITHER side of a
    // node the bands touching it are disjoint, stack in the model's own link
    // order and together span that node exactly. That is the property
    // `sankeyModel` computes `w0/y0` and `w1/y1` separately to provide, so
    // any component that drops one of them breaks it somewhere.
    //
    // TWO_BRANCHES on purpose: three bands leave node 2, three arrive at
    // node 5, and no band has y0 == y1 or w0 == w1. A fixture whose two
    // axes coincide lets a swapped axis through, which is how the survivor
    // survived.
    // Both shapes: the one-optional funnel is what the product ships today,
    // and it goes first so the five-node fixture cannot be the only place
    // this invariant is ever checked.
    const branched = render(<FunnelFlow result={BRANCHED} />)
    tilesEveryNodeEdge(BRANCHED_LINKS, 4)
    branched.unmount()

    render(<FunnelFlow result={TWO_BRANCHES} />)
    const bands = tilesEveryNodeEdge(TWO_BRANCH_LINKS, 5)
    expect(bands.filter((b) => b.from === 2)).toHaveLength(3)
    expect(bands.filter((b) => b.to === 5)).toHaveLength(3)

    // The horizontal axis, which nothing read at all. Every band runs from
    // its source node's right edge to its destination node's left edge.
    for (const b of bands) {
      expect(b.x0).toBeCloseTo(box(b.from).x + box(b.from).width, 5)
      expect(b.x1).toBeCloseTo(box(b.to).x, 5)
      expect(b.x1).toBeGreaterThan(b.x0)
    }
    // And the nodes are spread evenly across the plot rather than sharing
    // one slot -- which the per-band check above cannot see, because a
    // `nodeLeft` that ignores `node.x` satisfies it with all five stacked in
    // the same place.
    const xs = [1, 2, 3, 4, 5].map((i) => box(i).x)
    const pitch = (xs[1] as number) - (xs[0] as number)
    expect(pitch).toBeGreaterThan(0)
    for (let i = 1; i < xs.length; i++) {
      expect((xs[i] as number) - (xs[i - 1] as number)).toBeCloseTo(pitch, 5)
    }

    // The viewBox is as wide as the layout it holds, with the same margin on
    // both sides.
    const width = viewBox(screen.getByRole('img')).width
    const last = box(5)
    expect(width - (last.x + last.width)).toBeCloseTo(xs[0] as number, 5)
    // And a constant that happens to fit five steps is still a constant --
    // exactly how a hardcoded HEIGHT survived the first round of this file.
    // A shorter funnel gets a proportionally narrower viewBox.
    const two = render(<FunnelFlow result={result()} />)
    const narrower = viewBox(two.container.querySelector('svg')).width
    expect(narrower).toBeLessThan(width)
    expect(width / narrower).toBeCloseTo(5 / 2, 5)
  })

  it('puts each band’s label at that band’s own midpoint', () => {
    // The chip's TEXT was pinned and its placement was not: replacing the
    // inline `left`/`top` with `0%` and `0px` stacks all six labels in the
    // corner and the suite stays green. Each expected position is derived
    // here from that chip's OWN band, so a chip with no position and a chip
    // borrowing its neighbour's midpoint both fail.
    render(<FunnelFlow result={TWO_BRANCHES} />)
    const width = viewBox(screen.getByRole('img')).width
    const seen = new Set<string>()
    for (const [from, to] of TWO_BRANCH_LINKS) {
      const b = band(from, to)
      const chip = screen.getByTestId(`flow-rate-${from}-${to}`)
      // The band's midpoint needs no sampling: both edges are cubics whose
      // control points sit at the horizontal midpoint, so at the centre each
      // edge is exactly the mean of its two ends.
      const midY = (b.y0 + b.w0 / 2 + (b.y1 + b.w1 / 2)) / 2
      expect(Number.parseFloat(chip.style.top)).toBeCloseTo(midY, 1)
      expect(Number.parseFloat(chip.style.left)).toBeCloseTo(((b.x0 + b.x1) / 2 / width) * 100, 5)
      seen.add(`${chip.style.left}|${chip.style.top}`)
    }
    // Six bands, six distinct positions -- the fixture cannot make the
    // assertions above pass by coincidence.
    expect(seen.size).toBe(TWO_BRANCH_LINKS.length)
  })

  it('gives an optional node its branch point’s ramp step rather than one of its own', () => {
    render(<FunnelFlow result={BRANCHED} />)
    expect(screen.getByTestId('flow-node-3').getAttribute('fill')).toContain('--chart-funnel-2')
  })

  it('paints the stages after a branch as though the branch were not there', () => {
    // A branch that consumed a ramp step would repaint every later stage, so
    // adding a side path would change the colour of stages it did not touch.
    const { container } = render(<FunnelFlow result={BRANCHED} />)
    expect(screen.getByTestId('flow-node-2')).toHaveAttribute('fill', 'var(--chart-funnel-2)')
    expect(screen.getByTestId('flow-node-4')).toHaveAttribute('fill', 'var(--chart-funnel-3)')
    expect(container.innerHTML).not.toContain('--chart-funnel-4')
  })

  it('lifts the optional node clear of the line the required nodes share', () => {
    // The offset IS the marking now. The bars this replaced needed a dashed
    // outline because everything stood on one baseline; here a node that is
    // not on the chain is not on the chain's line, and a rendering that put
    // it back would say a branch is a stage.
    render(<FunnelFlow result={BRANCHED} />)
    const centre = (id: string) => {
      const n = screen.getByTestId(id)
      return Number(n.getAttribute('y') ?? 0) + Number(n.getAttribute('height') ?? 0) / 2
    }
    expect(centre('flow-node-2')).toBeCloseTo(centre('flow-node-4'), 5)
    const optional = screen.getByTestId('flow-node-3')
    const bottom =
      Number(optional.getAttribute('y') ?? 0) + Number(optional.getAttribute('height') ?? 0)
    expect(bottom).toBeLessThan(centre('flow-node-2'))
    expect(optional).toHaveAttribute('data-optional', 'true')
  })

  it('gives the optional step all three of its counts, each with its own verb', () => {
    // 30 did it, 50 did not, 24 of the 30 carried on. Those 50 are still in
    // the funnel; a reader who takes them for a drop-off has the story
    // backwards, which is why the counts never share a separator.
    render(<FunnelFlow result={BRANCHED} />)
    const cell = screen.getByTestId('flow-step-3')
    expect(cell).toHaveTextContent('30 did')
    expect(screen.getByTestId('flow-step-3-skipped')).toHaveTextContent('50 skipped')
    expect(screen.getByTestId('flow-step-3-continued')).toHaveTextContent('24 carried on')
    // `from_previous`, not `from_start`: 37.5% of the step it branches off,
    // not 30.0% of the entrants. Both are true; only one shares a
    // denominator with the words beside it.
    expect(cell).toHaveTextContent('37.5%')
    expect(cell).not.toHaveTextContent('30.0%')
  })

  it('names the branch point beside the branch percentage, so the row has one denominator per number', () => {
    render(<FunnelFlow result={BRANCHED} />)
    expect(screen.getByTestId('flow-step-3-of')).toHaveTextContent('of onboarded')
    // The step it branches OFF, not the slot beside it. Step 3 sits next to
    // step 4, and naming step 4 would be a plausible-looking lie.
    expect(screen.getByTestId('flow-step-3-of')).not.toHaveTextContent('purchase')
    expect(screen.queryByTestId('flow-step-4-of')).not.toBeInTheDocument()
    expect(screen.queryByTestId('flow-step-2-of')).not.toBeInTheDocument()
  })

  it('never names the branch as the biggest leak, even when it is the steepest number on screen', () => {
    // The branch loses 62.5% of its branch point and step 4 loses 50%. The
    // branch is not in the chain, so it is not in the comparison -- naming
    // it would tell an operator to go fix a side path nobody was expected
    // to take.
    render(<FunnelFlow result={BRANCHED} />)
    const leak = screen.getByTestId('funnel-biggest-leak')
    expect(leak).toHaveTextContent('purchase')
    expect(leak).not.toHaveTextContent('video_submitted')
  })

  it('renders as the RESULT says and shows no narrowing when the definition disagrees about optionality', () => {
    // Same rule as the event-name check, and for the same reason: these
    // arrive from two independent requests. The numbers were computed from
    // the definition the RUN used, so the result wins -- and a clause that
    // may belong to a different shape of step is not shown at all.
    const stale: FunnelStep[] = [
      { event: 'signup' },
      { event: 'onboarded' },
      {
        event: 'video_submitted',
        where: [{ property: 'kind', operator: '=', value: 'intro' }],
      },
      { event: 'purchase' },
    ]
    render(<FunnelFlow result={BRANCHED} definition={stale} />)
    expect(screen.queryByTestId('flow-step-3-where')).not.toBeInTheDocument()
    // Still drawn as a branch, because that is what the numbers are.
    expect(screen.getByTestId('flow-node-3')).toHaveAttribute('data-optional', 'true')
    expect(screen.getByTestId('flow-step-3-optional')).toBeInTheDocument()
    expect(screen.getByTestId('flow-link-2-4')).toBeInTheDocument()
  })

  it('keeps a clause on a step the definition DOES agree about', () => {
    // The guard is per position, not a whole-chart switch.
    const definition: FunnelStep[] = [
      { event: 'signup', where: [{ property: 'plan', operator: '=', value: 'pro' }] },
      { event: 'onboarded' },
      { event: 'video_submitted', optional: true },
      { event: 'purchase' },
    ]
    render(<FunnelFlow result={BRANCHED} definition={definition} />)
    expect(screen.getByTestId('flow-step-1-where')).toHaveTextContent('pro')
  })

  it('draws two adjacent branches off the SAME required step, both rejoining at the next one', () => {
    // Both hang off step 2; the second does NOT hang off the first. So the
    // links are chain 1->2, branch 2->3, branch 2->4, continue 3->5,
    // continue 4->5 and bypass 2->5 -- and nothing runs 3->4.
    render(<FunnelFlow result={TWO_BRANCHES} />)
    expect(screen.getAllByTestId(/^flow-link-/)).toHaveLength(6)
    for (const id of ['flow-link-2-3', 'flow-link-2-4', 'flow-link-3-5', 'flow-link-4-5']) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
    expect(screen.queryByTestId('flow-link-3-4')).not.toBeInTheDocument()
    // Stacked, not overlapping: the second branch sits clear above the first.
    const top = (id: string) => Number(screen.getByTestId(id).getAttribute('y') ?? 0)
    const bottom = (id: string) =>
      top(id) + Number(screen.getByTestId(id).getAttribute('height') ?? 0)
    expect(bottom('flow-node-4')).toBeLessThan(top('flow-node-3'))
  })
})

describe('FunnelFlow on the shapes that are not a fork', () => {
  // Someone did the optional step AFTER the last one, so the legs out of
  // step 1 sum to 65 against a node of 60.
  const OVERLAPPING = result({
    entered: 60,
    converted: 60,
    conversion_rate: 1,
    steps: [
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
    ],
  })

  const PLAIN = result({
    entered: 100,
    converted: 40,
    conversion_rate: 0.4,
    steps: [
      step({ index: 1, event: 'a', people: 100, from_previous: 1, from_start: 1 }),
      step({ index: 2, event: 'b', people: 80, from_previous: 0.8, from_start: 0.8 }),
      step({ index: 3, event: 'c', people: 40, from_previous: 0.5, from_start: 0.4 }),
    ],
  })

  // A brand-new project's first run. Every rate is 0 and every height is the
  // floor; nothing may reach the DOM as NaN.
  const EMPTY = result({
    entered: 0,
    converted: 0,
    conversion_rate: 0,
    steps: [
      step({ index: 1, event: 'a', people: 0, from_previous: 0, from_start: 0 }),
      step({
        index: 2,
        event: 'b',
        people: 0,
        from_previous: 0,
        from_start: 0,
        optional: true,
        skipped: 0,
        continued: 0,
      }),
      step({ index: 3, event: 'c', people: 0, from_previous: 0, from_start: 0 }),
    ],
  })

  it('names the overlap on the node where the legs exceed it', () => {
    render(<FunnelFlow result={OVERLAPPING} />)
    expect(screen.getByTestId('flow-node-1')).toHaveTextContent(/also reached/i)
  })

  it('says the overlap in the row of numbers too, on a REQUIRED step', () => {
    // The widths cannot show a double count -- they are scaled to fit -- so
    // the only place it can be said is in words. And it is said on whichever
    // step it happens at, which here is a required one: a rule that only
    // covered optional steps would be silent on exactly this funnel.
    render(<FunnelFlow result={OVERLAPPING} />)
    expect(screen.getByTestId('flow-step-1-overlap')).toHaveTextContent('5')
    expect(screen.queryByTestId('flow-step-3-overlap')).not.toBeInTheDocument()
  })

  it('renders a funnel with no optional steps as a straight chain', () => {
    // This is every funnel in the product today, so it is the case that must
    // not regress.
    render(<FunnelFlow result={PLAIN} />)
    expect(screen.getAllByTestId(/^flow-link-/)).toHaveLength(2)
    for (const node of screen.getAllByTestId(/^flow-node-/)) {
      expect(node).not.toHaveAttribute('data-optional')
    }
  })

  it('still reads as a funnel: one line, narrowing, each band the size of what survived', () => {
    // A Sankey of a funnel with no branches has to be the funnel. Every node
    // on one centre line, each smaller than the last, and the band between
    // two of them the width of the step it lands on.
    render(<FunnelFlow result={PLAIN} />)
    const height = (id: string) => Number(screen.getByTestId(id).getAttribute('height') ?? 0)
    const centre = (id: string) =>
      Number(screen.getByTestId(id).getAttribute('y') ?? 0) + height(id) / 2
    expect(centre('flow-node-1')).toBeCloseTo(centre('flow-node-2'), 5)
    expect(centre('flow-node-2')).toBeCloseTo(centre('flow-node-3'), 5)
    expect(height('flow-node-1')).toBeGreaterThan(height('flow-node-2'))
    expect(height('flow-node-2')).toBeGreaterThan(height('flow-node-3'))
    expect(screen.getByTestId('flow-rate-1-2')).toHaveTextContent('80.0%')
    expect(screen.getByTestId('flow-rate-2-3')).toHaveTextContent('50.0%')
  })

  it('draws no NaN into the SVG on a funnel nobody entered', () => {
    render(<FunnelFlow result={EMPTY} />)
    expect(document.body.innerHTML).not.toContain('NaN')
  })

  it('still draws every node and link on a funnel nobody entered', () => {
    // A guard that returns early on `entered === 0` also passes the NaN
    // check above while drawing nothing at all. A brand-new project's first
    // run must show the funnel it defined, at the floor.
    render(<FunnelFlow result={EMPTY} />)
    expect(screen.getAllByTestId(/^flow-node-/)).toHaveLength(3)
    expect(screen.getAllByTestId(/^flow-link-/)).toHaveLength(3)
  })
})
