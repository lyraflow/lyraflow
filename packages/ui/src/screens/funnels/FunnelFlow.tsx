import type { FunnelRunResult, FunnelStep, StepResult } from '../../api/types.js'
import { wherePhrase } from '../segments/vocabulary.js'
import { SLOT_WIDTH, biggestLeak, branchSlots, spineSteps } from './flowGeometry.js'
import { formatCount, formatPercent } from './format.js'
import { type SankeyLink, type SankeyNode, sankeyModel } from './sankey.js'

/**
 * How wide a node stands in its slot, in viewBox units.
 *
 * NARROW on purpose. In a Sankey the links carry the quantity and the node
 * is only the place they meet, so a node wide enough to read as a bar
 * re-tells the story the band beside it already told -- which is what the
 * bars this replaced did. The plot stretches horizontally, so this is 8% of
 * a slot rather than a pixel count: at the widest the plot is ever drawn
 * (200px per step, see `plot` below) it lands at 16px, and it shrinks with
 * the card rather than swallowing a narrow one.
 */
const NODE_WIDTH = 8

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
function nodeLeft(node: SankeyNode): number {
  return node.x + (SLOT_WIDTH - NODE_WIDTH) / 2
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
const LINK_FILL_OPACITY = 0.55

/** A click target smaller than this is not a click target. A node can be two
 * viewBox units tall (`MIN_BAR_HEIGHT`, a step nobody reached), so the
 * button is centred on the node and grown to something a pointer can hit. */
const HIT_MIN_HEIGHT = 24

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
  const model = sankeyModel(steps, result.entered)
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
  const plot = { maxWidth: `${Math.max(1, total) * 200}px` }
  /** A viewBox x as a percentage of the plot's own width. The SVG is
   * `width="100%"` over a viewBox of `model.width`, so this is exactly where
   * that coordinate lands however wide the card is -- no measuring, no
   * resize observer. Vertical needs no equivalent: the viewBox height IS the
   * pixel height, so a y is already a CSS offset. */
  const pct = (x: number) => (x / model.width) * 100

  return (
    <div data-testid="funnel-flow" className="flex min-w-0 flex-col gap-2">
      {/* The cap wraps the PLOT only. Wrapping the sentences below it too
       * was the first attempt and it re-flowed "loses 35.1% of the previous
       * step" onto two lines inside a card with 800px of empty space beside
       * it -- a chart constraint has no business setting prose measure. */}
      {/* Left-aligned, not centred. The cap means a short funnel does not
       * fill the card, and centring left it marooned in the middle with the
       * sentences beneath it starting at the left edge -- two different
       * origins on one block. `mr-auto` takes up the slack on the right so
       * the plot starts where every other line on the screen starts. */}
      <div className="mr-auto flex w-full min-w-0 flex-col gap-2" style={plot}>
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
            {/* Links first, so a node's own edge always sits on top of the
             * bands meeting it rather than being overdrawn by them. */}
            {model.links.map((link: SankeyLink) => {
              const src = model.nodes[link.from] as SankeyNode
              const dst = model.nodes[link.to] as SankeyNode
              const from = steps[link.from] as StepResult
              const to = steps[link.to] as StepResult
              const x0 = nodeLeft(src) + NODE_WIDTH
              const x1 = nodeLeft(dst)
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
                  fillOpacity={LINK_FILL_OPACITY}
                  stroke={`var(--chart-funnel-${src.ramp})`}
                  strokeWidth={1}
                  /* The plot stretches horizontally, so a stroke in user
                   * space would come out thicker on one axis than the other
                   * and would change with the card's width. */
                  vectorEffect="non-scaling-stroke"
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
                  x={r(nodeLeft(node))}
                  y={r(node.y)}
                  width={NODE_WIDTH}
                  height={r(node.height)}
                  /* A solid ramp fill on EVERY node, optional included. The
                   * bars this replaced marked an optional step by painting
                   * it in the palest token and outlining it, because on one
                   * baseline there was nothing else to mark it with. Here
                   * the node is lifted clear of the required line and both
                   * its legs are drawn, so the geometry says "off to the
                   * side" far louder than a fill ever did -- and the ramp
                   * step it borrows says which stage it hangs off. */
                  fill={`var(--chart-funnel-${node.ramp})`}
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
                    className="absolute -translate-x-1/2 rounded-sm border-0 bg-transparent p-0 outline-offset-2 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:outline aria-pressed:outline-2 aria-pressed:outline-primary"
                    style={{
                      left: `${pct(nodeLeft(node) + NODE_WIDTH / 2)}%`,
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
            {model.links.map((link: SankeyLink) => {
              const src = model.nodes[link.from] as SankeyNode
              const dst = model.nodes[link.to] as SankeyNode
              const from = steps[link.from] as StepResult
              const to = steps[link.to] as StepResult
              const x0 = nodeLeft(src) + NODE_WIDTH
              const x1 = nodeLeft(dst)
              const midY = (link.y0 + link.w0 / 2 + (link.y1 + link.w1 / 2)) / 2
              return (
                <span
                  key={`rate-${from.index}-${to.index}`}
                  data-testid={`flow-rate-${from.index}-${to.index}`}
                  className="absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm bg-background px-1 text-xs font-medium tabular-nums text-foreground"
                  style={{ left: `${pct((x0 + x1) / 2)}%`, top: `${r(midY)}px` }}
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
