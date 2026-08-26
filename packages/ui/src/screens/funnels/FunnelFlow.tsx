import type { FunnelRunResult, FunnelStep, StepResult } from '../../api/types.js'
import { wherePhrase } from '../segments/vocabulary.js'
import {
  BAR_WIDTH,
  PLOT_HEIGHT,
  barHeight,
  barX,
  biggestLeak,
  branchPath,
  branchSlots,
  plotWidth,
  rampIndexes,
  ribbonLabelY,
  ribbonPath,
  spineSlots,
  spineSteps,
} from './flowGeometry.js'
import { formatCount, formatPercent } from './format.js'

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
 * A funnel result as a left-to-right flow: one bar per stage, a tapering
 * ribbon carrying the survivors between them.
 *
 * **The ribbon is the point.** Stacked bars show each stage's size and leave
 * the reader to subtract; the taper draws the loss between the two stages it
 * happened between. That is the one thing the previous rendering could not
 * say, and the reason this exists rather than a restyle.
 *
 * **Colour is ORDINAL, not categorical.** Funnel stages have an order that
 * changes the meaning if you swap them, so they take one hue in monotone
 * lightness steps -- `--chart-funnel-1..7`, whose span was measured against
 * each mode's surface rather than chosen (see `theme.css`). A palette of
 * distinct hues, which is what the reference design for this screen used,
 * would spend the identity channel restating an order that position already
 * carries, and no hue ordering survives colour-blindness.
 *
 * **Nothing here computes a rate.** `from_previous` and `from_start` both
 * arrive from the server, which returns both deliberately -- deriving one
 * from a chain of the other is "a multiplication every caller gets subtly
 * wrong in a different way" (`core/src/funnels/levels.ts`). The arithmetic
 * below is bar heights and path coordinates; the biggest-leak line is a
 * `max` over rates the server already sent.
 *
 * **Pure over its props**: no client, no fetch, no clock, same as
 * `StepBars`. `FunnelFlowOrBars` decides which of the two renders.
 *
 * Text is HTML in a `repeat(N, 1fr)` grid above and below the plot, never
 * SVG `<text>`: the SVG stretches horizontally (`preserveAspectRatio="none"`)
 * so a glyph inside it would stretch with it. The grid and the plot share
 * the same slot count, which is what keeps a label over its own bar without
 * either measuring the other.
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
  const heights = steps.map((s) => barHeight(s.people, result.entered))
  /* One slot per DEFINITION step, and the spine is what the ribbons are
   * drawn between: `slots` is the definition-order position of each required
   * step, so a pair of consecutive entries can be two slots apart, or three.
   * `branches` says which required step each optional step hangs off. */
  const slots = spineSlots(steps)
  const branches = branchSlots(steps)
  const ramp = rampIndexes(steps)
  const leak = biggestLeak(spineSteps(steps), result.entered)
  const columns = { gridTemplateColumns: `repeat(${Math.max(1, total)}, minmax(0, 1fr))` }
  /* A cap, not a width: the plot still shrinks to whatever room it is given.
   * Without it a two-step funnel spreads two bars across the whole card and
   * each one lands ~240px wide, which reads as two blocks rather than as a
   * flow. Per-step rather than absolute so a six-step funnel still fills a
   * wide screen. */
  const plot = { maxWidth: `${Math.max(1, total) * 200}px` }

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
         * needs to know what a bar IS before they read how tall it is. */}
        <div className="grid gap-1" style={columns}>
          {steps.map((s, i) => {
            const where = whereFor(definition, i, s)
            return (
              <div key={s.index} className="min-w-0 px-1 text-center">
                <p className="truncate text-sm font-medium" title={s.event}>
                  {s.event}
                </p>
                {/* Said in WORDS, not only in the dash on the bar. The dash
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
           * scale is exactly 1 and only the horizontal axis stretches. Under a
           * vertical stretch every `rx` distorts and a 4px corner becomes
           * whatever the container's aspect ratio makes it. */}
          <svg
            role="img"
            aria-label={`Funnel flow: ${steps
              .map((s) =>
                s.optional === true
                  ? `${s.event} (optional) ${formatPercent(s.from_previous)} of the step it branches off`
                  : `${s.event} ${formatPercent(s.from_start)}`,
              )
              .join(', ')}`}
            viewBox={`0 0 ${plotWidth(total)} ${PLOT_HEIGHT}`}
            preserveAspectRatio="none"
            width="100%"
            height={PLOT_HEIGHT}
            className="block"
          >
            <title>Funnel flow</title>
            {/* Ribbons first, so a bar's own edge always sits on top of the
             * ribbon meeting it rather than being overdrawn by it.
             *
             * One per consecutive pair on the SPINE, spanning whatever slots
             * lie between them. NOT one per adjacent slot: a ribbon routed
             * into an optional step and out again would draw two losses that
             * did not happen, between stages that are not consecutive. The
             * spine is the chain; an optional step is a branch off it, and
             * the flow past it is undisturbed, which is exactly what a
             * ribbon at full geometry across its slot says. */}
            {slots.slice(0, -1).map((from, k) => {
              const to = slots[k + 1] as number
              const source = steps[from] as StepResult
              return (
                <path
                  key={`ribbon-${source.index}`}
                  data-testid={`flow-ribbon-${source.index}`}
                  d={ribbonPath(heights[from] as number, heights[to] as number, from, to)}
                  fill="var(--chart-funnel-ribbon)"
                />
              )
            })}
            {/* The thread from a branch point to the step hanging off it.
             * Stroked and dashed, with NO fill and no baseline legs -- see
             * `branchPath`. A wedge here would say the people who skipped
             * this step were lost, and they were not: they carried on down
             * the spine, which is the ribbon passing behind this. */}
            {branches.map((from, i) =>
              from == null ? null : (
                <path
                  key={`branch-${(steps[i] as StepResult).index}`}
                  data-testid={`flow-branch-${(steps[i] as StepResult).index}`}
                  d={branchPath(heights[from] as number, heights[i] as number, from, i)}
                  fill="none"
                  stroke={`var(--chart-funnel-${ramp[i]})`}
                  strokeWidth={1.5}
                  strokeDasharray="4 3"
                  /* The plot stretches horizontally, so a stroke in user
                   * space would come out thicker on one axis than the other
                   * and the dash pattern would stretch with the container.
                   * This keeps both in screen space, which is the only way a
                   * dash reads as the same dash at every card width. */
                  vectorEffect="non-scaling-stroke"
                />
              ),
            )}
            {steps.map((s, i) => {
              const optional = s.optional === true
              return (
                <rect
                  key={`bar-${s.index}`}
                  data-testid={`flow-bar-${s.index}`}
                  data-optional={optional ? 'true' : undefined}
                  x={barX(i)}
                  y={PLOT_HEIGHT - (heights[i] as number)}
                  width={BAR_WIDTH}
                  height={heights[i] as number}
                  rx={4}
                  /* Optional: the palest token in the set -- the same one the
                   * ribbons use -- outlined in its branch point's ramp step.
                   * Subordinate by weight rather than by hue, and the outline
                   * is what ties it to the stage it hangs off. A solid ramp
                   * fill would make it look like a stage of its own, which is
                   * the one thing it must not look like. */
                  fill={optional ? 'var(--chart-funnel-ribbon)' : `var(--chart-funnel-${ramp[i]})`}
                  stroke={optional ? `var(--chart-funnel-${ramp[i]})` : undefined}
                  strokeWidth={optional ? 1.5 : undefined}
                  strokeDasharray={optional ? '4 3' : undefined}
                  vectorEffect={optional ? 'non-scaling-stroke' : undefined}
                />
              )
            })}
          </svg>

          {/* One transparent, full-slot button per step -- its OWN layer,
           * never inside the rate-label grid below. That grid is
           * `pointer-events-none` wholesale (a label must never swallow a
           * click meant for the ribbon or bar under it), so a button placed
           * inside it would be permanently unclickable. This layer sits
           * BENEATH the label layer in source order: sharing one grid would
           * also collide the two at `gridRow: 1` -- labels span two columns
           * each (they name a transition between two slots) and buttons span
           * one, so placing them together would leave stacking order
           * dependent on source position, which the label layer's own
           * comment already relies on for something else (see below) and
           * should not have to arbitrate here too.
           *
           * Rendered only with `onSelectStep` -- the builder preview has no
           * funnel id to list people for, so nothing here must be
           * interactive: no button, no focus stop, no hover affordance. */}
          {onSelectStep != null && (
            <div className="absolute inset-0 grid" style={columns}>
              {steps.map((s, i) => (
                <button
                  key={`select-${s.index}`}
                  type="button"
                  data-testid={`flow-step-${s.index}-select`}
                  aria-pressed={selectedStep === s.index}
                  aria-label={`Show people at step ${s.index}: ${s.event}${s.optional === true ? ' (optional)' : ''}`}
                  onClick={() => onSelectStep(s.index)}
                  className="h-full w-full rounded-sm border-0 bg-transparent p-0 hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset aria-pressed:bg-accent/20"
                  style={{ gridRow: 1, gridColumn: i + 1 }}
                />
              ))}
            </div>
          )}

          {/* The step-to-step rate, sitting on the ribbon it describes.
           *
           * HTML absolutely over the plot, never an SVG `<text>`: the plot
           * stretches horizontally, so a glyph inside it would stretch too.
           *
           * A ribbon's centre falls exactly on the boundary between two
           * slots -- `barX(i) + BAR_WIDTH` to `barX(i + 1)` is centred on
           * `(i + 1) * SLOT_WIDTH` -- so a label spanning those two grid
           * columns and centred within the span lands on the ribbon without
           * measuring anything at runtime.
           *
           * `from_previous`, NOT `from_start`: the number belongs to the
           * TRANSITION it is drawn on -- how many of the previous step's
           * people made it across. The cumulative share is already the big
           * number under each bar; repeating it here would say the same
           * thing twice while looking like it said something new.
           *
           * `text-foreground` over the ribbon fill measures 11.62:1 in light
           * and 8.44:1 in dark -- computed, not eyeballed -- and it is the
           * ordinary text token in both modes, so a label lifted above a
           * thin ribbon onto the surface keeps the validated pairing.
           *
           * `aria-hidden`: the SVG's own `aria-label` already reads the
           * funnel as a sentence, and a screen reader meeting these spans
           * separately would hear a row of bare percentages with nothing
           * saying which transition each belongs to. */}
          <div
            className="pointer-events-none absolute inset-0 grid"
            style={columns}
            aria-hidden="true"
          >
            {slots.slice(0, -1).map((from, k) => {
              const to = slots[k + 1] as number
              const source = steps[from] as StepResult
              /* The tallest branch bar standing in a slot this ribbon spans
               * across -- 0 when the two stages are adjacent, which is every
               * ribbon on a funnel with no optional steps. See
               * `ribbonLabelY`: without it the label prints across the
               * branch's dashed outline. */
              let spanned = 0
              for (let s = from + 1; s < to; s++) {
                spanned = Math.max(spanned, heights[s] as number)
              }
              return (
                <span
                  key={`rate-${source.index}`}
                  data-testid={`flow-rate-${source.index}`}
                  className="justify-self-center self-start text-xs font-medium tabular-nums text-foreground"
                  style={{
                    /* `gridRow: 1` on EVERY label, and it is not decorative.
                     * Their column spans overlap by one, so auto-placement
                     * pushes each one onto a fresh row -- the labels came out
                     * stacked down the page, the later ones outside the card
                     * entirely. Pinning the row makes them overlay the plot,
                     * which is the whole point of an absolute overlay. */
                    gridRow: 1,
                    /* Spanning the pair's OWN slots, however many lie between
                     * them. Centred over `${from + 1}` through `${to + 1}`
                     * lands on `(from + to + 1) * SLOT_WIDTH / 2`, which is
                     * exactly the ribbon's midpoint -- the same identity the
                     * two-column case relied on, and it holds for any span. */
                    gridColumn: `${from + 1} / span ${to - from + 1}`,
                    marginTop: `${ribbonLabelY(heights[from] as number, heights[to] as number, spanned)}px`,
                  }}
                >
                  {formatPercent((steps[to] as StepResult).from_previous)}
                </span>
              )
            })}
          </div>
        </div>

        {/* `from_start` as the headline and the count beneath it: the share is
         * what the bar height already drew, so it reads as a label rather than
         * as new information, and the absolute number is what an operator
         * copies into a ticket. Both in text tokens, never in the series
         * colour -- the bar above carries identity. */}
        <div className="grid gap-1" style={columns}>
          {steps.map((s) =>
            s.optional === true ? (
              /* `from_previous`, NOT `from_start`, as the headline -- and
               * that is not a style choice. An optional step's rate is a
               * share of the required step it branches off, so putting it
               * where every other column puts a share of the ENTRANTS would
               * print two different denominators in one row of numbers with
               * nothing saying which is which. The words under it say whose
               * share it is. */
              <div
                key={s.index}
                data-testid={`flow-step-${s.index}`}
                className="min-w-0 text-center"
              >
                <p className="text-base font-semibold tabular-nums">
                  {formatPercent(s.from_previous)}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {formatCount(s.people)} did
                </p>
                {/* The two counts cannot be read as one population, which is
                 * why each carries its own verb rather than sharing a
                 * middot with it. `skipped` is people who reached the branch
                 * point and did NOT do this -- they are still in the funnel,
                 * and a reader who takes them for a drop-off has the story
                 * backwards. */}
                {s.skipped != null && (
                  <p
                    data-testid={`flow-step-${s.index}-skipped`}
                    className="text-xs tabular-nums text-muted-foreground"
                  >
                    {formatCount(s.skipped)} skipped
                  </p>
                )}
              </div>
            ) : (
              <div
                key={s.index}
                data-testid={`flow-step-${s.index}`}
                className="min-w-0 text-center"
              >
                <p className="text-base font-semibold tabular-nums">
                  {formatPercent(s.from_start)}
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {formatCount(s.people)}
                </p>
              </div>
            ),
          )}
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
