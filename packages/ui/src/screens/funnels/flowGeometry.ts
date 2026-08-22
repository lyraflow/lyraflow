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
 */
export function ribbonPath(fromHeight: number, toHeight: number, fromStep: number): string {
  const x1 = barX(fromStep) + BAR_WIDTH
  const x2 = barX(fromStep + 1)
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
 */
export function biggestLeak(
  steps: readonly StepResult[],
  entered: number,
): { index: number; event: string; lost: number } | null {
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
