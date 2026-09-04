import { useEffect, useId, useRef, useState } from 'react'
import type { FunnelRunResult, FunnelStep, StepResult } from '../../api/types.js'
import { wherePhrase } from '../segments/vocabulary.js'
import { biggestLeak, branchSlots, spineSteps } from './flowGeometry.js'
import { formatCount, formatPercent } from './format.js'
import {
  PEEL_DY,
  type SankeyDrop,
  type SankeyLink,
  type SankeyNode,
  sankeyModel,
} from './sankey.js'

/**
 * How wide a node stands in its slot, IN PIXELS.
 *
 * NARROW on purpose. In a Sankey the links carry the quantity and the node
 * is only the place they meet, so a node wide enough to read as a bar
 * re-tells the story the band beside it already told -- which is what the
 * bars this replaced did.
 *
 * A pixel count rather than a share of a slot, which is what it used to be.
 * The model is measured in pixels now, so a node is the same object at every
 * card width instead of a sliver on a narrow one and a slab on a wide one --
 * and a fixed width is what lets the cap below be a real radius.
 */
const NODE_WIDTH = 15

/** Fully rounded ends, which needs the width to be known in pixels -- under
 * the stretched space this replaced, a radius came out as an oval whose
 * eccentricity changed with the card. Capped at half the height so a node
 * two pixels tall stays a shape rather than inverting. */
const NODE_RADIUS = NODE_WIDTH / 2

/** How far the selection ring stands off the node. Square units, so this is
 * the same clearance on all four sides -- which is exactly what it was not
 * under the stretched space, where three units drew fifteen pixels beside a
 * node and three above it. */
const SELECT_INSET = 3

/** A ring of the surface token around a glyph, so a label reads against
 * whatever band it happens to land on. Eight offsets rather than four: at
 * four the diagonals show through as notches at this weight. */
const HALO = [
  '2px 0 var(--lf-surface)',
  '-2px 0 var(--lf-surface)',
  '0 2px var(--lf-surface)',
  '0 -2px var(--lf-surface)',
  '1.5px 1.5px var(--lf-surface)',
  '-1.5px 1.5px var(--lf-surface)',
  '1.5px -1.5px var(--lf-surface)',
  '-1.5px -1.5px var(--lf-surface)',
].join(', ')

/** The narrowest a stage may get before the plot scrolls instead of
 * compressing. Eight stages at this width is about 1160px, which is wider
 * than the card on a laptop -- so a long funnel scrolls, which is the honest
 * failure: a stage you can read and must scroll to beats eight you cannot. */
const MIN_SLOT_PX = 145

/** The widest a stage may get. Past this a two-stage funnel stops reading as
 * a flow and starts reading as a bridge between two distant posts -- found
 * by rendering, and the reason a cap exists at all. */
const MAX_SLOT_PX = 320

/**
 * Where a node sits horizontally inside its slot.
 *
 * `SankeyModel` gives a node an `x` and no width -- the width is a visual
 * judgement, so the placement that follows from it is the renderer's too.
 * Centred rather than flush left: the text rows above and below are a
 * `repeat(N, 1fr)` grid whose columns ARE the slots, so a centred node
 * stands under its own name without either measuring the other, and the
 * plot gets a symmetric half-slot margin instead of a whole empty slot on
 * the right.
 */
function nodeLeft(node: SankeyNode, slot: number): number {
  return node.x + (slot - NODE_WIDTH) / 2
}

/** Two decimals is past what any screen can resolve and keeps the `d`
 * attribute readable in a DOM dump. */
function r(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * One link, as a closed band from `(x0, y0)` of thickness `w0` to
 * `(x1, y1)` of thickness `w1`.
 *
 * Both edges are the same cubic with its control points at the horizontal
 * midpoint, which is what gives the flat-then-turn-then-flat shape that
 * reads as a flow. The band TAPERS whenever the two ends disagree, and that
 * is not a drawing of loss: `sankey.ts` scales each end to fill the node it
 * touches, so the taper is what keeps the geometry adding up at both nodes
 * while the printed counts stay the true ones.
 */
function bandPath(x0: number, y0: number, w0: number, x1: number, y1: number, w1: number): string {
  const mid = (x0 + x1) / 2
  return [
    `M ${r(x0)} ${r(y0)}`,
    `C ${r(mid)} ${r(y0)}, ${r(mid)} ${r(y1)}, ${r(x1)} ${r(y1)}`,
    `L ${r(x1)} ${r(y1 + w1)}`,
    `C ${r(mid)} ${r(y1 + w1)}, ${r(mid)} ${r(y0 + w0)}, ${r(x0)} ${r(y0 + w0)}`,
    'Z',
  ].join(' ')
}

/** How far along the plot a drop-off ribbon travels before it has faded
 * out. Horizontal, so unlike `PEEL_DY` it changes nothing about how much
 * room the plot needs and stays here with the path that uses it. Short of a
 * whole slot on purpose: the ribbon says "these people left", and a ribbon
 * long enough to reach the next stage would say they went there. */
const PEEL_DX = 118

/**
 * The people who stopped at a node, leaving it: a band of their own
 * thickness that displaces away from the flow and fades out.
 *
 * The same cubic as `bandPath`, so a ribbon reads as the same kind of object
 * as a flow rather than as an annotation -- it IS a population, and drawing
 * it in a different vocabulary would say otherwise. What separates it is
 * that it carries no colour of its own and fades to nothing, which is what
 * stops the eye following it as a path to somewhere.
 */
function peelPath(x0: number, top: number, w: number, up: boolean): string {
  const y1 = top + (up ? -PEEL_DY : PEEL_DY)
  const mid = x0 + PEEL_DX * 0.45
  const x1 = x0 + PEEL_DX
  return [
    `M ${r(x0)} ${r(top)}`,
    `C ${r(mid)} ${r(top)}, ${r(mid)} ${r(y1)}, ${r(x1)} ${r(y1)}`,
    `L ${r(x1)} ${r(y1 + w)}`,
    `C ${r(mid)} ${r(y1 + w)}, ${r(mid)} ${r(top + w)}, ${r(x0)} ${r(top + w)}`,
    'Z',
  ].join(' ')
}

/**
 * Translucent, and this is the one place opacity is right.
 *
 * The ribbons this replaced used a token that already IS the blend, because
 * a single ribbon over an unknown surface came out grey. A Sankey's links
 * CROSS, and the reader has to see which one passes in front of which -- so
 * the blend has to happen against whatever is underneath rather than
 * against a surface guessed at build time. Each band still carries a
 * full-opacity outline in its own tint, which is what keeps its edges
 * findable where two of them overlap.
 */
const LINK_FILL_OPACITY = 0.62

/** The optional path, drawn recessive.
 *
 * On a funnel that converts everyone, every band fills the edge it touches
 * and the plot has no whitespace to separate anything with -- so figure and
 * ground have to come from weight instead. The required chain reads as the
 * body of the funnel; the flow that detours through an optional step reads
 * as lighter, and the dash says which is which a second time for anyone who
 * cannot see the difference in weight. */
const BRANCH_FILL_OPACITY = 0.3

/** A click target smaller than this is not a click target. A node can be two
 * viewBox units tall (`MIN_BAR_HEIGHT`, a step nobody reached), so the
 * button is centred on the node and grown to something a pointer can hit. */
const HIT_MIN_HEIGHT = 24

/**
 * The width the model is built at before the plot has been measured, and
 * after it has been measured as zero.
 *
 * Both cases are real. The first paint happens before layout, and a test
 * environment reports every element as 0x0 for ever -- so a model built
 * straight from the measurement would put every node at x = 0 with a slot a
 * pixel wide, and the chart would be a stripe. Falling back to the widest a
 * stage is allowed to be gives a plot that is correct in every proportion,
 * just not yet the size of its container; one frame later the observer
 * replaces it.
 */
const FALLBACK_SLOT_PX = MAX_SLOT_PX

/**
 * The plot's width in CSS pixels, from the element it is drawn into.
 *
 * A ResizeObserver, which this component went out of its way to avoid until
 * now -- the old model was drawn in an abstract space stretched to fit, so a
 * measurement was genuinely unnecessary. That space is what made a node's
 * rounded cap an oval, a stroke thicker on one axis than the other, and any
 * fixed inset five times wider than it was tall; the selection mark was
 * re-cut twice over it. Measuring buys a coordinate space where one unit is
 * one pixel on both axes, and every one of those problems stops existing
 * rather than being worked around.
 */
function usePlotWidth(fallback: number): [number, (el: HTMLDivElement | null) => void] {
  const [width, setWidth] = useState(0)
  const observer = useRef<ResizeObserver | null>(null)
  useEffect(() => () => observer.current?.disconnect(), [])
  const ref = (el: HTMLDivElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (el == null) return
    setWidth(el.getBoundingClientRect().width)
    // Guarded: jsdom has no ResizeObserver, and a component that throws on
    // mount there would take every test of this screen with it.
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry != null) setWidth(entry.contentRect.width)
    })
    ro.observe(el)
    observer.current = ro
  }
  return [width > 0 ? width : fallback, ref]
}

/**
 * The predicates narrowing the step at position `i`, or `null` when this
 * component cannot be certain which definition step the result's step
 * corresponds to.
 *
 * Lifted from `StepBars`, deliberately unchanged in behaviour: `definition`
 * and `result` arrive from two INDEPENDENT requests, so position is the
 * correspondence and the event-name check is what stops that assumption
 * being silent when it stops holding. When it cannot be certain it renders
 * NOTHING -- a narrowing shown against the wrong step would have an operator
 * act on a population the screen never measured, and that failure is
 * invisible. An omitted clause is merely less information.
 *
 * `optional` is checked for the same reason and with the same ruling. An
 * optional treatment drawn against a required step has an operator read a
 * branch as a stage, and that failure is invisible too. When the two
 * disagree the RESULT wins everywhere on this screen -- it is what the
 * numbers were computed from -- and this returns `null`, so no narrowing is
 * shown beside a step whose shape the definition disagrees about.
 */
function whereFor(
  definition: readonly FunnelStep[] | null | undefined,
  i: number,
  result: StepResult,
): string | null {
  const step = definition?.[i]
  if (step == null || step.event !== result.event) return null
  if ((step.optional === true) !== (result.optional === true)) return null
  if (step.where == null || step.where.length === 0) return null
  return wherePhrase(step.where)
}

/**
 * A funnel result as a Sankey: one node per step, and a band per population
 * moving between them.
 *
 * **This component computes no geometry.** `sankeyModel` owns every
 * position, thickness and offset, including how tall the plot has to be --
 * an optional node is lifted OFF the required centre line, so the extent is
 * a computed maximum rather than a constant, and sizing the viewBox from
 * anything else clips the branch. What is left here is a width for a node,
 * a path string per link, and where the text goes.
 *
 * **The fork is the point.** The tapering ribbon this replaced could only
 * say "these two stages, and the loss between them"; it had one shape for
 * one chain, and an optional step had to be drawn as an annotation hanging
 * off it. A Sankey draws both legs out of a branch point as flows, rejoins
 * them at the next required step, and lets the widths say how many took
 * each -- which is the question an optional step exists to ask.
 *
 * **Colour is ORDINAL, not categorical** (ADR 006). Funnel stages have an
 * order that changes the meaning if you swap them, so they take one hue in
 * monotone lightness steps -- `--chart-funnel-1..7`, whose span was measured
 * against each mode's surface rather than chosen (see `theme.css`). Each
 * link is tinted from its SOURCE node, which ties a band to where it came
 * from rather than to where it lands. **That is not what makes a crossing
 * readable, and it must not be sold as though it were.** A ramp step is
 * shared by every band leaving one stage AND by the branch that borrows it:
 * on a funnel with two adjacent optional steps, five of the six bands carry
 * `--chart-funnel-2`. What actually separates two bands where they overlap
 * is the full-opacity outline read against the 0.55 fill it encloses -- a
 * contrast in OPACITY, which is the only channel left once two bands share
 * a ramp step -- together with the continuity of each shape through the
 * crossing. A palette of distinct hues,
 * which is what the reference design for this screen used, would spend the
 * identity channel restating an order that position already carries, and no
 * hue ordering survives colour-blindness.
 *
 * **Nothing here computes a rate.** `from_previous` and `from_start` both
 * arrive from the server, which returns both deliberately -- deriving one
 * from a chain of the other is "a multiplication every caller gets subtly
 * wrong in a different way" (`core/src/funnels/levels.ts`). A link's `rate`
 * is the server's own where the server has one and `sankeyModel`'s guarded
 * ratio where it does not; the biggest-leak line is a `max` over rates the
 * server already sent.
 *
 * **Pure over its props**: no client, no fetch, no clock, same as
 * `StepBars`. `FunnelFlowOrBars` decides which of the two renders -- and at
 * 390px it is the bars, because eight steps sharing a phone screen leave
 * 48px each and a Sankey needs room for its bands to separate.
 *
 * Text is HTML, never SVG `<text>`: the plot stretches horizontally
 * (`preserveAspectRatio="none"`) so a glyph inside it would stretch with it.
 * The step rows are a `repeat(N, 1fr)` grid sharing the plot's slots; the
 * link labels are absolutely positioned from the model's own coordinates,
 * which is exact because the viewBox height IS the pixel height and only
 * the horizontal axis scales.
 *
 * Each node and each link also carries an SVG `<title>`, which is the
 * browser's own hover tooltip. That is where the long form goes -- both
 * endpoints of a band, and the sentence explaining a double count -- so the
 * text drawn on the plot can stay short enough to fit on it.
 */
export function FunnelFlow(props: {
  result: FunnelRunResult
  /** The funnel DEFINITION's steps, so a narrowed step says so instead of
   * showing a bare event name a differently-predicated step would show too.
   * Optional: `result` alone is a complete rendering. */
  definition?: readonly FunnelStep[] | null
  /** The step whose people are currently shown beneath the chart, by its
   * 1-indexed `index` -- the same number `onSelectStep` reports and the
   * API's `step` parameter expects. */
  selectedStep?: number | null
  /** Reports which step was clicked, by its 1-indexed `index`. Omitted by a
   * caller with nothing to do about a click -- `FunnelBuilder`'s preview
   * renders an unsaved definition with no funnel id, so there is no people
   * list it could open. Without this, no step buttons render at all: no
   * button, no focus stop, no hover affordance. */
  onSelectStep?: (step: number) => void
}) {
  const { result, definition, selectedStep, onSelectStep } = props
  const steps = result.steps
  const total = steps.length
  const [plotWidthPx, plotRef] = usePlotWidth(Math.max(1, total) * FALLBACK_SLOT_PX)
  /** A gradient is referenced by a document-wide id, so two funnels on one
   * screen would otherwise share -- and silently swap -- each other's fades.
   * `useId` is what React gives for exactly this, and it survives hydration. */
  const plotId = useId().replace(/:/g, '')
  const model = sankeyModel(steps, result.entered, plotWidthPx)
  /** `branchSlots` still, and only for the WORDS: an optional step's rate is
   * a share of the required step it hangs off, and the row under the plot
   * has to name which one. The model draws the branch; this names it, from
   * the same function, so the two can never disagree. */
  const branches = branchSlots(steps)
  const leak = biggestLeak(spineSteps(steps), result.entered)
  const columns = { gridTemplateColumns: `repeat(${Math.max(1, total)}, minmax(0, 1fr))` }
  /* A cap, not a width: the plot still shrinks to whatever room it is given.
   * Without it a two-step funnel spreads two nodes across the whole card and
   * the band between them lands ~700px long, which reads as a bridge rather
   * than as a flow. Per-step rather than absolute so a six-step funnel still
   * fills a wide screen. */
  /* FULL WIDTH, with a FLOOR per stage rather than a cap on the whole plot.
   *
   * This was `maxWidth: total * 200px`, which pinned a three-stage funnel to
   * 600px however wide the screen was -- reported as "squeezed into a very
   * narrow width", and it was. A cap answers the wrong question: the risk is
   * not a chart that is too wide, it is a stage too narrow to read. So the
   * plot fills its container between a floor and a ceiling PER STAGE, and
   * both bounds answer a real finding. The floor: an eight-stage funnel
   * scrolls rather than compressing every stage into an unreadable sliver.
   * The ceiling: a two-stage funnel across a wide card put ~700px of band
   * between two nodes, which reads as a bridge rather than a flow -- that
   * was the reason for the original cap, and it still holds. What was wrong
   * was capping the WHOLE plot at 200px a stage, which pinned a three-stage
   * funnel to 600px on any screen. Per stage, both bounds can be true. */
  const plot = {
    minWidth: `${Math.max(1, total) * MIN_SLOT_PX}px`,
    maxWidth: `${Math.max(1, total) * MAX_SLOT_PX}px`,
  }
  /** A viewBox x as a percentage of the plot's own width. The SVG is
   * `width="100%"` over a viewBox of `model.width`, so this is exactly where
   * that coordinate lands however wide the card is -- no measuring, no
   * resize observer. Vertical needs no equivalent: the viewBox height IS the
   * pixel height, so a y is already a CSS offset. */
  const pct = (x: number) => (x / model.width) * 100

  return (
    <div data-testid="funnel-flow" className="flex min-w-0 flex-col gap-2 overflow-x-auto">
      {/* The cap wraps the PLOT only. Wrapping the sentences below it too
       * was the first attempt and it re-flowed "loses 35.1% of the previous
       * step" onto two lines inside a card with 800px of empty space beside
       * it -- a chart constraint has no business setting prose measure. */}
      {/* Left-aligned, not centred. The cap means a short funnel does not
       * fill the card, and centring left it marooned in the middle with the
       * sentences beneath it starting at the left edge -- two different
       * origins on one block. `mr-auto` takes up the slack on the right so
       * the plot starts where every other line on the screen starts. */}
      <div ref={plotRef} className="flex w-full flex-col gap-2" style={plot}>
        {/* Stage names, above the plot as in a column chart -- the reader
         * needs to know what a node IS before they read how big it is. */}
        <div className="grid gap-1" style={columns}>
          {steps.map((s, i) => {
            const where = whereFor(definition, i, s)
            return (
              <div key={s.index} className="min-w-0 px-1 text-center">
                <p className="truncate text-sm font-medium" title={s.event}>
                  {s.event}
                </p>
                {/* Said in WORDS, not only in the node's offset. The offset
                 * is what carries the branch at a glance; a reader who has
                 * not learned what it means still has to be told, and
                 * "optional" is one word. */}
                {s.optional === true && (
                  <p
                    data-testid={`flow-step-${s.index}-optional`}
                    className="truncate text-xs text-muted-foreground"
                  >
                    optional
                  </p>
                )}
                {where != null && (
                  <p
                    data-testid={`flow-step-${s.index}-where`}
                    className="truncate text-xs text-muted-foreground"
                    title={`where ${where}`}
                  >
                    where {where}
                  </p>
                )}
              </div>
            )
          })}
        </div>

        <div className="relative">
          {/* `height` in pixels equal to the viewBox height, so the vertical
           * scale is exactly 1 and only the horizontal axis stretches. That
           * is what lets the label layer position from model coordinates
           * directly, and it is why `model.height` -- a computed maximum,
           * not a constant -- has to be read for both. */}
          <svg
            role="img"
            aria-label={`Funnel flow: ${steps
              .map((s) =>
                s.optional === true
                  ? `${s.event} (optional) ${formatPercent(s.from_previous)} of the step it branches off`
                  : `${s.event} ${formatPercent(s.from_start)}`,
              )
              .join(', ')}`}
            viewBox={`0 0 ${model.width} ${model.height}`}
            preserveAspectRatio="none"
            width="100%"
            height={model.height}
            className="block"
          >
            <title>Funnel flow</title>
            <defs>
              {/* One gradient per ribbon rather than one shared: a `<defs>`
               * id has to be unique on the PAGE, and two funnels can be on
               * one screen. Keyed by step index, which is unique within a
               * result, and prefixed with the plot's own id. */}
              {model.drops.map((drop: SankeyDrop) => (
                <linearGradient
                  key={`fade-${drop.node}`}
                  id={`lf-drop-${plotId}-${drop.node}`}
                  x1="0"
                  x2="1"
                >
                  <stop offset="0" stopColor="var(--lf-text-subtle)" stopOpacity={0.3} />
                  <stop offset="1" stopColor="var(--lf-text-subtle)" stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {/* THE DROP-OFF, drawn first and under everything.
             *
             * These people are the reason the funnel is a funnel, and until
             * now the chart drew them as nothing at all -- the empty space
             * under a node's bands, which a reader had to know to look for.
             * On a step that loses a third of its traffic that empty space is
             * most of the node's height, and it read as a rendering fault
             * rather than as a loss. Reported as "the drop-off spacing
             * doesn't look right", which was the right complaint about the
             * wrong thing: the spacing was correct and the absence was the
             * defect.
             *
             * Under the flows, in no colour of its own, fading to nothing:
             * it has to be legible as a quantity without competing with the
             * paths that continue. */}
            {model.drops.map((drop: SankeyDrop) => {
              const node = model.nodes[drop.node] as SankeyNode
              const s = steps[drop.node] as StepResult
              return (
                <path
                  key={`drop-${s.index}`}
                  data-testid={`flow-drop-${s.index}`}
                  data-direction={drop.up ? 'up' : 'down'}
                  d={peelPath(nodeLeft(node, model.slot) + NODE_WIDTH, drop.top, drop.w, drop.up)}
                  fill={`url(#lf-drop-${plotId}-${drop.node})`}
                >
                  <title>
                    {formatCount(drop.people)} reached {s.event} and went no further.
                  </title>
                </path>
              )
            })}
            {/* Links next, so a node's own edge always sits on top of the
             * bands meeting it rather than being overdrawn by them. */}
            {model.links.map((link: SankeyLink) => {
              const src = model.nodes[link.from] as SankeyNode
              const dst = model.nodes[link.to] as SankeyNode
              const from = steps[link.from] as StepResult
              const to = steps[link.to] as StepResult
              const x0 = nodeLeft(src, model.slot) + NODE_WIDTH
              const x1 = nodeLeft(dst, model.slot)
              return (
                <path
                  key={`link-${from.index}-${to.index}`}
                  data-testid={`flow-link-${from.index}-${to.index}`}
                  data-kind={link.kind}
                  d={bandPath(x0, link.y0, link.w0, x1, link.y1, link.w1)}
                  /* The SOURCE node's ramp step, never the destination's.
                   * Two bands arriving at one node came from different
                   * places and are different populations, and the tint says
                   * which stage each one left. Tinting by where they land
                   * instead would state the opposite -- that they are the
                   * same population -- which is a claim about the data, not
                   * a shortfall in legibility. What keeps the two findable
                   * where they overlap is the outline, not the fill. */
                  fill={`var(--chart-funnel-${src.ramp})`}
                  fillOpacity={
                    link.kind === 'branch' || link.kind === 'continue'
                      ? BRANCH_FILL_OPACITY
                      : LINK_FILL_OPACITY
                  }
                  /* A HAIRLINE OF THE BAND'S OWN HUE, and nothing else --
                   * no dash.
                   *
                   * The optional legs used to be dashed, on the argument that
                   * an optional node borrows its branch point's ramp step so
                   * several bands can share one colour and texture is the
                   * channel ADR 006 leaves free. The argument holds and the
                   * result was still wrong: a dash tracing every edge of
                   * every optional band was the loudest thing on the chart,
                   * and it is what made the plot look unfinished rather than
                   * considered. Reported, twice.
                   *
                   * What carries the distinction instead is the weight the
                   * two already had -- 0.3 against 0.62 -- now that the bands
                   * no longer collide and can be seen at all, plus the word
                   * `optional` under the stage name. A hairline in the fill's
                   * own hue defines the edge without competing with it. */
                  stroke={`var(--chart-funnel-${src.ramp})`}
                  strokeOpacity={0.5}
                  strokeWidth={0.75}
                >
                  <title>
                    {from.event} → {to.event}: {formatCount(link.people)} people,{' '}
                    {formatPercent(link.rate)} of {from.event}
                  </title>
                </path>
              )
            })}
            {model.nodes.map((node: SankeyNode) => {
              const s = steps[node.step] as StepResult
              const optional = node.optional
              return (
                <rect
                  key={`node-${s.index}`}
                  data-testid={`flow-node-${s.index}`}
                  data-optional={optional ? 'true' : undefined}
                  x={r(nodeLeft(node, model.slot))}
                  y={r(node.y)}
                  width={NODE_WIDTH}
                  height={r(node.height)}
                  /* Rounded to a full cap, which only became possible once
                   * the model was measured in pixels -- in the stretched
                   * space this replaced, a radius rendered as an oval whose
                   * shape changed with the card's width. Capped at half the
                   * height so a node at the floor stays a shape. */
                  rx={r(Math.min(NODE_RADIUS, node.height / 2))}
                  /* A solid ramp fill on EVERY node, optional included. The
                   * bars this replaced marked an optional step by painting
                   * it in the palest token and outlining it, because on one
                   * baseline there was nothing else to mark it with. Here
                   * the node is lifted clear of the required line and both
                   * its legs are drawn, so the geometry says "off to the
                   * side" far louder than a fill ever did -- and the ramp
                   * step it borrows says which stage it hangs off. */
                  fill={`var(--chart-funnel-${node.ramp})`}
                  /* A hairline of the surface between the node and the bands
                   * meeting it. Bands are drawn at 0.55 and a node at full
                   * opacity, which separates them on paper but not where a
                   * band is the same ramp step as the node it lands on --
                   * exactly the case on a short funnel. The halo makes the
                   * node an object rather than a darker patch of band. */
                  stroke="var(--lf-surface)"
                  strokeWidth={1.5}
                >
                  <title>
                    {s.event}
                    {optional ? ' (optional)' : ''}: {formatCount(node.people)} people.
                    {node.overlap > 0
                      ? ` ${formatCount(node.overlap)} also reached a step out of order, so two paths count them.`
                      : ''}
                  </title>
                </rect>
              )
            })}
            {/* The selected node's outline, IN THE SVG and drawn from the
             * node's own coordinates.
             *
             * It used to live on the HTML hit target, which is a fixed 28px
             * wide because a pointer needs more room than a 12-unit node. The
             * plot stretches horizontally, so the node renders wider than that
             * at most card widths and the outline sat INSIDE the bar it was
             * meant to mark -- with rounded corners on a square node and an
             * offset pushing it further out of true. A hit target and a mark
             * are two different jobs: the target stays generous and invisible,
             * the mark traces the node exactly because it is built from the
             * same numbers. */}
            {selectedStep != null &&
              model.nodes
                .filter(
                  (node: SankeyNode) => (steps[node.step] as StepResult).index === selectedStep,
                )
                .map((node: SankeyNode) => {
                  /* THE MARK IS THE NODE'S OWN BOX -- no padding around it,
                   * and that is a correction of two rendered attempts.
                   *
                   * viewBox units are not square here: `preserveAspectRatio`
                   * is `none`, so one unit is worth about five times as much
                   * horizontally as vertically at a typical card width. A
                   * padding of three units drew three pixels of clearance
                   * above the bar and fifteen beside it -- a box visibly
                   * wider than the thing it marked. The same padding also put
                   * the top edge of a full-height node's ring above y = 0,
                   * where the viewport clips it, and the mark rendered as two
                   * vertical lines with no top or bottom to close it.
                   *
                   * Drawn on the node's exact box with a non-scaling stroke,
                   * the stroke straddles the edge and the clearance is equal
                   * on all four sides IN PIXELS, whatever the stretch. */
                  /* A RING AROUND the node, not on its edge -- and that is
                   * now possible where it was not before. Units are square,
                   * so a fixed inset is the same distance on all four sides
                   * and the mark can stand clear of the node instead of
                   * straddling it. Clamped into the plot so a full-height
                   * node's ring keeps its top and bottom edges. */
                  const top = Math.max(0, node.y - SELECT_INSET)
                  const bottom = Math.min(model.height, node.y + node.height + SELECT_INSET)
                  const box = {
                    x: r(nodeLeft(node, model.slot) - SELECT_INSET),
                    y: r(top),
                    width: NODE_WIDTH + SELECT_INSET * 2,
                    height: r(bottom - top),
                    rx: r(Math.min(NODE_RADIUS + SELECT_INSET, (bottom - top) / 2)),
                  }
                  return (
                    <g key={`selected-${node.step}`}>
                      {/* TWO rings, and the outer one is not decoration. The
                       * mark has to read against whatever it traces, and stage
                       * one is the darkest step of the ramp while the accent
                       * is the accent -- rendered, the single ring vanished into
                       * the node it was marking. A surface-coloured halo under
                       * an accent ring separates the mark from both the node and
                       * the band that starts immediately beside it. */}
                      <rect
                        {...box}
                        fill="none"
                        stroke="var(--lf-surface)"
                        strokeWidth={5}
                        pointerEvents="none"
                      />
                      <rect
                        data-testid={`flow-node-${(steps[node.step] as StepResult).index}-selected`}
                        {...box}
                        fill="none"
                        stroke="var(--lf-accent)"
                        strokeWidth={2}
                        pointerEvents="none"
                      />
                    </g>
                  )
                })}
          </svg>

          {/* One transparent button per NODE -- its OWN layer, never inside
           * the label layer below. That layer is `pointer-events-none`
           * wholesale (a label must never swallow a click meant for the band
           * under it), so a button placed inside it would be permanently
           * unclickable.
           *
           * On the node rather than over the whole slot, which is where it
           * used to be: a slot-wide target now covers the bands crossing it
           * as well, and clicking a band to select the step it passes is a
           * lie about what was clicked.
           *
           * Rendered only with `onSelectStep` -- the builder preview has no
           * funnel id to list people for, so nothing here must be
           * interactive: no button, no focus stop, no hover affordance. */}
          {onSelectStep != null && (
            <div className="absolute inset-0">
              {model.nodes.map((node: SankeyNode) => {
                const s = steps[node.step] as StepResult
                const height = Math.max(node.height, HIT_MIN_HEIGHT)
                const centred = node.y + node.height / 2 - height / 2
                /* Clamped into the plot: a node at the floor height sits
                 * two units tall, and a target grown around it would
                 * otherwise hang above the top edge or below the bottom. */
                const top = Math.min(Math.max(0, centred), Math.max(0, model.height - height))
                return (
                  <button
                    key={`select-${s.index}`}
                    type="button"
                    data-testid={`flow-step-${s.index}-select`}
                    aria-pressed={selectedStep === s.index}
                    aria-label={`Show people at step ${s.index}: ${s.event}${s.optional === true ? ' (optional)' : ''}`}
                    onClick={() => onSelectStep(s.index)}
                    /* Selected is an OUTLINE around the node, not a fill
                     * behind it. FOUND BY RENDERING IT: the target is wider
                     * than the node it selects (a node is 8 viewBox units;
                     * a pointer needs more), so a filled highlight came out
                     * as two pale vertical bars flanking the node -- which
                     * on a chart made of vertical bars reads as two more
                     * nodes, not as a selection. An outline traces the
                     * target instead of colouring beside it. */
                    className="absolute -translate-x-1/2 border-0 bg-transparent p-0 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    style={{
                      left: `${pct(nodeLeft(node, model.slot) + NODE_WIDTH / 2)}%`,
                      top: `${r(top)}px`,
                      height: `${r(height)}px`,
                      width: '28px',
                    }}
                  />
                )
              })}
            </div>
          )}

          {/* Each band's own count and rate, on the band.
           *
           * HTML absolutely over the plot, never an SVG `<text>`: the plot
           * stretches horizontally, so a glyph inside it would stretch too.
           *
           * At the band's MIDPOINT, and that needs no sampling: both edges
           * are cubics whose control points sit at the horizontal midpoint,
           * which makes the y-component a 1D Bezier with P0=P1 and P2=P3 --
           * so at the centre the curve is exactly the mean of its two ends.
           *
           * The count AND the rate, because neither answers the other's
           * question: the width already says "this share of the node", and
           * an operator copies the absolute number into a ticket. Both are
           * the model's TRUE values, never the scaled widths.
           *
           * On a chip in the surface token, not bare on the band. A label
           * lands wherever its band goes and bands overlap, so there is no
           * one colour underneath to have measured against; the chip puts
           * `text-foreground` back on the surface it is the ordinary pairing
           * for.
           *
           * `aria-hidden`: the SVG's own `aria-label` already reads the
           * funnel as a sentence, and a screen reader meeting these spans
           * separately would hear a row of bare numbers with nothing saying
           * which flow each belongs to. */}
          <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            {/* What each ribbon is, in words. The ribbon draws the size of
             * the loss and fades out; the number is what an operator copies
             * into a ticket, and without it the shape is a mood rather than
             * a measurement. Placed at the ribbon's far end, where it has
             * faded enough not to sit on top of its own fill. */}
            {model.drops.map((drop: SankeyDrop) => {
              const node = model.nodes[drop.node] as SankeyNode
              const s = steps[drop.node] as StepResult
              const x = nodeLeft(node, model.slot) + NODE_WIDTH + PEEL_DX
              const y = drop.top + (drop.up ? -PEEL_DY : PEEL_DY) + drop.w / 2
              return (
                <span
                  key={`drop-label-${s.index}`}
                  data-testid={`flow-drop-${s.index}-label`}
                  className="absolute -translate-y-1/2 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                  style={{ left: `${pct(x)}%`, top: `${r(y)}px`, textShadow: HALO }}
                >
                  {formatCount(drop.people)} dropped
                </span>
              )
            })}
            {model.links.map((link: SankeyLink) => {
              const src = model.nodes[link.from] as SankeyNode
              const dst = model.nodes[link.to] as SankeyNode
              const from = steps[link.from] as StepResult
              const to = steps[link.to] as StepResult
              const x0 = nodeLeft(src, model.slot) + NODE_WIDTH
              const x1 = nodeLeft(dst, model.slot)
              const midY = (link.y0 + link.w0 / 2 + (link.y1 + link.w1 / 2)) / 2
              return (
                <span
                  key={`rate-${from.index}-${to.index}`}
                  data-testid={`flow-rate-${from.index}-${to.index}`}
                  /* A HALO, not a chip. The chip this replaces was a
                   * surface-coloured rectangle behind every label, which is
                   * correct about contrast and wrong about what it looks
                   * like: a row of little boxes floating over the plot reads
                   * as tooltips someone forgot to dismiss. A halo puts the
                   * same surface under the glyphs only, so the label sits ON
                   * the band.
                   *
                   * `text-shadow` rather than `-webkit-text-stroke`, which
                   * was tried: a text stroke paints OVER the glyph, thinning
                   * it into an outline instead of backing it. */
                  className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap px-1 text-xs font-semibold tabular-nums text-foreground"
                  style={{
                    left: `${pct((x0 + x1) / 2)}%`,
                    top: `${r(midY)}px`,
                    textShadow: HALO,
                  }}
                >
                  {formatCount(link.people)} · {formatPercent(link.rate)}
                </span>
              )
            })}
          </div>
        </div>

        {/* `from_start` as the headline and the count beneath it: the share is
         * what the node height already drew, so it reads as a label rather than
         * as new information, and the absolute number is what an operator
         * copies into a ticket. Both in text tokens, never in the series
         * colour -- the node above carries identity. */}
        <div className="grid gap-1" style={columns}>
          {steps.map((s, i) => {
            /* The required step this branch hangs off, from the SAME
             * `branchSlots` the model branches with -- so the name under
             * the number and the band on the plot can never disagree about
             * which step the share is a share of. */
            const from = branches[i]
            const branchPoint = from == null ? null : (steps[from] as StepResult)
            const node = model.nodes[i] as SankeyNode
            return (
              <div
                key={s.index}
                data-testid={`flow-step-${s.index}`}
                className="min-w-0 text-center"
              >
                {s.optional === true ? (
                  /* `from_previous`, NOT `from_start`, as the headline -- and
                   * that is not a style choice. An optional step's rate is a
                   * share of the required step it branches off, so putting it
                   * where every other column puts a share of the ENTRANTS would
                   * print two different denominators in one row of numbers with
                   * nothing saying which is which. The words under it say whose
                   * share it is. */
                  <>
                    <p className="text-base font-semibold tabular-nums">
                      {formatPercent(s.from_previous)}
                    </p>
                    {/* NAMING the denominator, immediately under the number, and
                     * this line is the whole reason the row is readable. Every
                     * other bold percentage in it is a share of the ENTRANTS;
                     * this one is a share of one required step. Same row, same
                     * weight, different denominator -- and a number that looks
                     * right while answering a slightly different question is
                     * worse than no number. */}
                    {branchPoint != null && (
                      <p
                        data-testid={`flow-step-${s.index}-of`}
                        className="truncate text-xs text-muted-foreground"
                        title={`of ${branchPoint.event}`}
                      >
                        of {branchPoint.event}
                      </p>
                    )}
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {formatCount(s.people)} did
                    </p>
                    {/* The three counts cannot be read as one population, which
                     * is why each carries its own verb rather than sharing a
                     * separator. `skipped` is people who reached the branch
                     * point and did NOT do this -- they are still in the funnel,
                     * and a reader who takes them for a drop-off has the story
                     * backwards. `continued` is the subset of the people who DID
                     * do it that went on to the next required step, which is the
                     * band leaving this node. */}
                    {s.skipped != null && (
                      <p
                        data-testid={`flow-step-${s.index}-skipped`}
                        className="text-xs tabular-nums text-muted-foreground"
                      >
                        {formatCount(s.skipped)} skipped
                      </p>
                    )}
                    {s.continued != null && (
                      <p
                        data-testid={`flow-step-${s.index}-continued`}
                        className="text-xs tabular-nums text-muted-foreground"
                      >
                        {formatCount(s.continued)} carried on
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <p className="text-base font-semibold tabular-nums">
                      {formatPercent(s.from_start)}
                    </p>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {formatCount(s.people)}
                    </p>
                  </>
                )}
                {/* A double count, said on the step it happens at -- and on a
                 * REQUIRED step as readily as an optional one. Someone who
                 * did the optional step after the next required one is on the
                 * branch leg and on the bypass leg both, so the legs out of
                 * their branch point add up to more than the branch point
                 * has. The widths cannot show that (they are scaled to fit),
                 * and silently scaling it away is how a chart becomes
                 * something an operator stops trusting. */}
                {node != null && node.overlap > 0 && (
                  <p
                    data-testid={`flow-step-${s.index}-overlap`}
                    className="text-xs tabular-nums text-muted-foreground"
                    title={`${formatCount(node.overlap)} also reached a step out of order, so two paths count them`}
                  >
                    {formatCount(node.overlap)} counted twice
                  </p>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {leak != null && (
        <p data-testid="funnel-biggest-leak" className="text-sm text-muted-foreground">
          Biggest leak: <span className="font-medium text-foreground">{leak.event}</span> loses{' '}
          {formatPercent(leak.lost)} of the previous step.
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        Entered {formatCount(result.entered)} · Converted {formatCount(result.converted)} ·{' '}
        {formatPercent(result.conversion_rate)}
      </p>
    </div>
  )
}
