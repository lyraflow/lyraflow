import type { StepResult } from '../../api/types.js'

/**
 * The plot's own coordinate space, in viewBox units.
 *
 * `PLOT_HEIGHT` is used as the SVG's pixel height too, so the vertical scale
 * is exactly 1 and only the horizontal axis stretches
 * (`preserveAspectRatio="none"`). That is what keeps a bar's rounded top the
 * radius it says it is: under a vertical stretch `rx`/`ry` distort, and a
 * 4px corner silently becomes 7px on a tall container.
 *
 * Each step owns a slot `SLOT_WIDTH` wide; the bar sits in the middle of it
 * and the ribbon spans the gap between two bars. Slots rather than measured
 * pixels because the labels above and the numbers below are HTML in a
 * `repeat(N, 1fr)` grid -- text stays crisp and unscaled, geometry scales,
 * and neither needs to measure the other at runtime.
 */
export const PLOT_HEIGHT = 180
export const SLOT_WIDTH = 100
/** Leaves `(SLOT_WIDTH - BAR_WIDTH) / 2` of gap on each side for the ribbon. */
export const BAR_WIDTH = 44
/** Bars never vanish entirely: a step that converted nobody still has a
 * position on the page, and a zero-height rectangle reads as a rendering
 * failure rather than as a zero. */
export const MIN_BAR_HEIGHT = 2

/** How many ordinal ramp steps `theme.css` defines. See its own comment for
 * why this is 7 and not 8 -- it is the widest span of the copper ramp whose
 * palest member still clears 2:1 on each mode's surface, measured. */
export const RAMP_STEPS = 7

/**
 * Which ordinal ramp step a funnel stage takes, 1-based.
 *
 * Stage 1 is the darkest and the last stage the palest, so more-is-darker
 * agrees with the bar heights rather than fighting them.
 *
 * `MAX_FUNNEL_STEPS` is 8 and the validated ramp has 7 steps, so an
 * eight-step funnel has one stage more than there are safe colours. The last
 * two share the palest step rather than taking an invented eighth: an
 * interpolated step either drops below the 2:1 contrast floor or below the
 * 0.06 adjacent-lightness gap, both of which the ramp was measured against.
 * The two affected stages are still told apart by position, by the ribbon
 * between them and by the surface gap. Widening this for real means adding
 * steps in the brand tooling and re-running its own contrast script.
 */
export function rampIndex(stepIndex: number, totalSteps: number): number {
  if (totalSteps <= 1) return 1
  const span = Math.min(totalSteps, RAMP_STEPS)
  const position = Math.min(stepIndex, span - 1)
  return position + 1
}

/**
 * The steps that make up the required chain, in order.
 *
 * The ribbons, the ramp and the leak all read this rather than the whole
 * list. An optional step has a bar and a slot, and it is not a stage: its
 * `from_previous` is measured against the required step it branches off
 * (`core/src/funnels/spine.ts`), so anything comparing consecutive stages
 * must skip it or it is comparing two different denominators.
 */
export function spineSteps(steps: readonly StepResult[]): StepResult[] {
  return steps.filter((s) => s.optional !== true)
}

/**
 * The DEFINITION-ORDER slot of each spine step, in order.
 *
 * The plot keeps one slot per definition step -- an optional step is drawn,
 * so it occupies one -- while the ribbons are drawn between consecutive
 * entries HERE. Two optional steps in a row therefore still produce ONE
 * ribbon, spanning three slots, rather than a chain of three.
 */
export function spineSlots(steps: readonly StepResult[]): number[] {
  const out: number[] = []
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.optional !== true) out.push(i)
  }
  return out
}

/**
 * For each definition-order slot, the slot of the required step it branches
 * off -- `null` for a required step, and for an optional step with no
 * required step before it.
 *
 * The last required step BEFORE it, never its neighbour: two optional steps
 * in a row both hang off the same required step, and the second one's
 * `from_previous` was computed against that step, not against the first
 * branch. `validateFunnel` refuses an optional first step, so the `null`
 * case is unreachable through the API -- it is still defined here, because a
 * pure function that throws its caller's validation rule states that rule
 * twice.
 */
export function branchSlots(steps: readonly StepResult[]): (number | null)[] {
  const out: (number | null)[] = []
  let lastRequired: number | null = null
  for (let i = 0; i < steps.length; i++) {
    if (steps[i]?.optional === true) {
      out.push(lastRequired)
      continue
    }
    out.push(null)
    lastRequired = i
  }
  return out
}

/**
 * Which ramp step each step paints with, by definition-order index.
 *
 * Computed over the SPINE, with an optional step taking the ramp step of the
 * stage it branches off -- so it reads as attached to that stage rather than
 * as one of its own. Consuming a ramp step would spend the ordinal channel
 * on something that has no position in the order, and would also shift every
 * later stage's colour, so the same six-stage funnel would repaint itself
 * because a side branch was added beside it.
 */
export function rampIndexes(steps: readonly StepResult[]): number[] {
  const spineLength = spineSteps(steps).length
  const out: number[] = []
  let rank = 0
  for (const step of steps) {
    if (step.optional === true) {
      out.push(rampIndex(Math.max(0, rank - 1), spineLength))
      continue
    }
    out.push(rampIndex(rank, spineLength))
    rank++
  }
  return out
}

/**
 * A bar's height for `people` out of `entered`.
 *
 * Guarded at a zero denominator for the same reason `StepBars` guards its
 * own width: `entered === 0` is a real state (a brand-new project's first
 * run), and dividing anyway yields `NaN`, which reaches the DOM as an
 * invalid attribute and collapses the plot. A zero-entrant funnel draws
 * every bar at the floor.
 */
export function barHeight(people: number, entered: number): number {
  if (entered <= 0) return MIN_BAR_HEIGHT
  const scaled = (people / entered) * PLOT_HEIGHT
  return Math.max(MIN_BAR_HEIGHT, Math.round(scaled * 100) / 100)
}

/** The x offset of a step's bar within the whole plot. */
export function barX(stepIndex: number): number {
  return stepIndex * SLOT_WIDTH + (SLOT_WIDTH - BAR_WIDTH) / 2
}

/** The plot's total width in viewBox units. */
export function plotWidth(totalSteps: number): number {
  return Math.max(1, totalSteps) * SLOT_WIDTH
}

/**
 * The ribbon carrying the flow from one stage to the next.
 *
 * Bottom-anchored: both bars and the ribbon sit on the same baseline, and
 * the ribbon's TOP edge falls from one bar's top to the next's. So the
 * tapering wedge is the drop-off, drawn where it happens rather than
 * summarised beside the chart. A ribbon of constant thickness would say the
 * loss occurs at the bar, which is not what a conversion window means.
 *
 * The curve is a cubic with horizontal control points at the midpoint,
 * giving the flat-then-fall-then-flat shape that reads as a flow rather
 * than as a triangle.
 *
 * The destination is EXPLICIT rather than `fromStep + 1`, because an
 * optional step occupies a slot the spine ribbon must span. A ribbon routed
 * through it would draw a loss between two stages that are not consecutive.
 */
export function ribbonPath(
  fromHeight: number,
  toHeight: number,
  fromStep: number,
  toStep: number,
): string {
  const x1 = barX(fromStep) + BAR_WIDTH
  const x2 = barX(toStep)
  const y1 = PLOT_HEIGHT - fromHeight
  const y2 = PLOT_HEIGHT - toHeight
  const mid = (x1 + x2) / 2
  return [
    `M ${x1} ${y1}`,
    `C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
    `L ${x2} ${PLOT_HEIGHT}`,
    `L ${x1} ${PLOT_HEIGHT}`,
    'Z',
  ].join(' ')
}

/**
 * The thread from a required step's bar to the optional step hanging off it.
 *
 * The SAME cubic as `ribbonPath`'s top edge and NOT a ribbon: no baseline
 * legs, no `Z`, so there is no area to fill and no taper to read. That is
 * the whole point. A taper says "the loss happened between these two
 * stages"; nothing was lost between a required step and a branch off it,
 * because the branch is not the next stage -- the people who did not take it
 * carried on down the spine. Drawing a wedge here would depict a loss that
 * did not happen, which is worse than the stacked bars this plot replaced.
 *
 * Stroked, dashed and thin at the call site for the same reason: an optional
 * step is subordinate to the chain it hangs off, and the dash is what says
 * so at a glance without depending on colour.
 */
export function branchPath(
  fromHeight: number,
  toHeight: number,
  fromStep: number,
  toStep: number,
): string {
  const x1 = barX(fromStep) + BAR_WIDTH
  const x2 = barX(toStep)
  const y1 = PLOT_HEIGHT - fromHeight
  const y2 = PLOT_HEIGHT - toHeight
  const mid = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
}

/** Roughly one `text-xs` line box, used to centre the ribbon's label on the
 * ribbon rather than hanging it from its own top edge. */
export const LABEL_HEIGHT = 16
/** Below this the ribbon is thinner than a line of text, and a label inside
 * it would spill over both edges onto the surface. */
const LABEL_FITS_ABOVE = 24

/**
 * Where the step-to-step rate sits on its ribbon, as a distance from the top
 * of the plot.
 *
 * The label is HTML overlaid on the SVG, never an SVG `<text>`: the plot
 * stretches horizontally (`preserveAspectRatio="none"`), so a glyph inside
 * it would stretch with it. `PLOT_HEIGHT` is also the pixel height, so this
 * number is a CSS offset without any conversion.
 *
 * The cubic in `ribbonPath` has both control points at the horizontal
 * midpoint, which makes its y-component a 1D Bezier with P0=P1 and P2=P3 --
 * so at the centre the curve is exactly the mean of the two ends. No
 * sampling needed, and the label cannot drift off the curve it names.
 *
 * A THIN ribbon puts the label above itself instead of inside. Two bars that
 * both converted almost nobody leave a wedge thinner than a line of text,
 * and a label centred in it spills over both edges -- half on the ribbon,
 * half on the surface, legible against neither. Above the wedge it sits on
 * the surface, where the ordinary text token is already the validated
 * pairing.
 *
 * `spannedBarHeight` is the tallest bar standing in a slot this ribbon spans
 * ACROSS -- an optional step's, and 0 whenever the ribbon joins two adjacent
 * slots, which is every ribbon on a funnel with no optional steps. FOUND BY
 * RENDERING IT: a spanning ribbon's centre is the middle of the branch's own
 * slot, so the label came out printed across the branch bar's dashed
 * outline, with the dashes running through the glyphs. Lifting it clear of
 * BOTH the ribbon and that bar is the fix; `max` of the two rather than the
 * bar alone, because a branch shorter than the ribbon would still leave the
 * label inside the ribbon it was lifted out of.
 *
 * A TALL spanned bar drops the label back INSIDE, which is the same trade
 * the thin-ribbon case makes in the other direction. Past
 * `PLOT_HEIGHT - LABEL_HEIGHT - 2` there is no surface left above to lift
 * onto -- a branch taken by more than ~90% of entrants, the ordinary shape
 * for an optional step most people take -- and clamping at 0 printed the
 * label across the dashed outline it was lifted to avoid. Two pixels BELOW
 * the top edge instead: inside both the ribbon and the branch bar, which
 * are filled with the same `--chart-funnel-ribbon` token, so the label
 * keeps the pairing `text-foreground` was measured against and stays clear
 * of the dashes.
 */
/**
 * Which grid columns a ribbon's rate label spans, 1-based, as
 * `{ start, span }` for a CSS `grid-column`.
 *
 * An ADJACENT pair keeps the label centred across its own two slots. That
 * midpoint IS the ribbon's midpoint, it is where every funnel without
 * optional steps has always drawn it, and nothing here moves it.
 *
 * A ribbon that SPANS a slot cannot use its midpoint, and this was found on a
 * real funnel rather than reasoned about: a ribbon from step 1 to step 3 has
 * its centre in the middle of step 2's slot, so the label printed squarely
 * over the branch bar standing there -- directly above that step's own,
 * different, percentage. Two numbers stacked in one column, belonging to two
 * different things. It is anchored at the ARRIVAL gap instead: the two
 * columns straddling the destination bar's left edge, where the only thing
 * beside it is the bar the ribbon lands on.
 *
 * Vertical placement is `ribbonLabelY`'s and is deliberately untouched --
 * the ambiguity was horizontal, and the lift over a spanned bar still holds.
 */
export function labelColumns(fromStep: number, toStep: number): { start: number; span: number } {
  if (toStep - fromStep <= 1) return { start: fromStep + 1, span: toStep - fromStep + 1 }
  return { start: toStep, span: 2 }
}

export function ribbonLabelY(fromHeight: number, toHeight: number, spannedBarHeight = 0): number {
  const topAtCentre = PLOT_HEIGHT - (fromHeight + toHeight) / 2
  const thickness = PLOT_HEIGHT - topAtCentre
  if (spannedBarHeight > 0) {
    const clearOf = Math.max(thickness, spannedBarHeight)
    const above = PLOT_HEIGHT - clearOf - LABEL_HEIGHT - 2
    if (above < 0) return Math.round(PLOT_HEIGHT - clearOf + 2)
    return Math.round(above)
  }
  if (thickness >= LABEL_FITS_ABOVE) {
    return Math.round(topAtCentre + thickness / 2 - LABEL_HEIGHT / 2)
  }
  return Math.max(0, Math.round(topAtCentre - LABEL_HEIGHT - 2))
}

/**
 * The step that loses the largest share of the one before it.
 *
 * A `max` over rates the SERVER computed, never a rate computed here --
 * `levels.ts` returns `from_previous` and `from_start` both ways precisely
 * so no client re-derives one from the other. This picks a winner among
 * them; it does not do arithmetic on them beyond the comparison.
 *
 * Step 1 is excluded: its `from_previous` is 1 by construction (everyone who
 * entered reached it), so it can never be the leak and including it would
 * make an empty funnel name step 1 as its own worst drop.
 *
 * `null` when there is nothing to say -- fewer than two steps, nobody
 * entered, or no step lost anyone. "Biggest leak: none" is noise, and a
 * funnel that loses nobody deserves silence rather than a sentence
 * congratulating it.
 *
 * This comparison is over the SPINE. Callers pass `spineSteps(...)`, and it
 * filters again itself rather than trusting them to: an optional step's
 * `from_previous` is a share of the required step it branches off, so a
 * rarely-taken side branch would otherwise win a comparison it is not in and
 * the screen would name a branch nobody was expected to take as the funnel's
 * worst problem. Stating the rule in each caller is how the next caller gets
 * it wrong.
 */
export function biggestLeak(
  rawSteps: readonly StepResult[],
  entered: number,
): { index: number; event: string; lost: number } | null {
  const steps = spineSteps(rawSteps)
  if (entered <= 0 || steps.length < 2) return null
  let worst: { index: number; event: string; lost: number } | null = null
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i]
    if (step == null) continue
    const lost = 1 - step.from_previous
    if (lost <= 0) continue
    if (worst == null || lost > worst.lost) {
      worst = { index: step.index, event: step.event, lost }
    }
  }
  return worst
}
