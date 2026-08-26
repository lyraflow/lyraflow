import type { StepResult } from '../../api/types.js'

/**
 * The height of a node every entrant reached, in viewBox units.
 *
 * Deliberately NOT exported. It used to be `PLOT_HEIGHT`, and it was the
 * SVG's own pixel height as well as this scale -- true only while every bar
 * stood on one baseline and the plot could be no taller than its tallest
 * bar. A Sankey's optional nodes are lifted OFF that line, so how tall the
 * plot has to be is a computed maximum (`SankeyModel.height`) rather than a
 * constant, and a module-level `PLOT_HEIGHT` would keep asserting the
 * premise that is gone. This is only what `barHeight` measures against.
 */
const BAR_SCALE = 280

/** Nodes never vanish entirely: a step that converted nobody still has a
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
 * agrees with the node heights rather than fighting them.
 *
 * `MAX_FUNNEL_STEPS` is 8 and the validated ramp has 7 steps, so an
 * eight-step funnel has one stage more than there are safe colours. The last
 * two share the palest step rather than taking an invented eighth: an
 * interpolated step either drops below the 2:1 contrast floor or below the
 * 0.06 adjacent-lightness gap, both of which the ramp was measured against.
 * The two affected stages are still told apart by position, by the links
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
 * The links, the ramp and the leak all read this rather than the whole
 * list. An optional step has a node and a slot, and it is not a stage: its
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
 * so it occupies one -- while the chain runs between consecutive entries
 * HERE. Two optional steps in a row therefore still branch off ONE required
 * step and rejoin at ONE next required step, rather than forming a chain of
 * three.
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
 * A node's height for `people` out of `entered`.
 *
 * Guarded at a zero denominator for the same reason `StepBars` guards its
 * own width: `entered === 0` is a real state (a brand-new project's first
 * run), and dividing anyway yields `NaN`, which reaches the DOM as an
 * invalid attribute and collapses the plot. A zero-entrant funnel draws
 * every node at the floor.
 */
export function barHeight(people: number, entered: number): number {
  if (entered <= 0) return MIN_BAR_HEIGHT
  return Math.max(MIN_BAR_HEIGHT, scaleHeight(people, entered))
}

/**
 * The same scale as `barHeight`, WITHOUT the minimum.
 *
 * ONE SCALE FOR THE WHOLE PLOT is the point. A band drawn through this is
 * directly comparable to a node drawn through `barHeight` and to every other
 * band, so a thickness means the same number of people wherever it appears.
 * Bands were previously scaled to fill each node's edge, which made a width
 * readable only against the one node it touched and left a funnel that
 * converts everyone as a solid rectangle with no space in it.
 *
 * No floor, unlike `barHeight`: a node that nobody reached still needs a
 * position on the page, but a band carrying nobody must draw as nothing. A
 * two-unit sliver for zero people is a line an operator would try to read.
 */
export function scaleHeight(people: number, entered: number): number {
  if (entered <= 0) return 0
  return Math.round((people / entered) * BAR_SCALE * 100) / 100
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
