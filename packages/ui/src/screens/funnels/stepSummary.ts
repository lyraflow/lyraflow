import { FilterNode as FilterNodeSchema } from '@lyraflow/core/segments/ast.js'
import type { FunnelStep } from '../../api/types.js'
import { summarise } from '../segments/summarise.js'
import { wherePhrase } from '../segments/vocabulary.js'

/**
 * Whether a step is finished enough to be worth collapsing.
 *
 * The event name is the step; without it there is nothing to summarise and
 * nothing a reader could recognise the collapsed row by. An audience has to
 * parse against the real AST for the same reason `FunnelBuilder` gates Save
 * on `completeness` rather than on a hand-written notion of "filled in" -- a
 * second definition of validity drifts from the one the server enforces, and
 * the field that drifts is one nobody thought about.
 *
 * A step with no audience at all is complete once it has an event. Absent is
 * a finished state, not an unfinished one.
 */
export function stepComplete(step: FunnelStep): boolean {
  if (step.event.trim() === '') return false
  if (step.audience === undefined) return true
  return FilterNodeSchema.safeParse(step.audience).success
}

/**
 * Below this many steps, opening a funnel leaves every step expanded.
 *
 * Collapsing on load exists so an eight-step definition is a list you can
 * read rather than a page you scroll. A two-step funnel has no such problem,
 * and folding it shut would mean clicking twice to reach the fields on a
 * form whose whole content already fits on screen -- paying the cost of the
 * feature without getting its benefit.
 */
export const COLLAPSE_ON_LOAD_MIN_STEPS = 4

/** Which steps a freshly-seeded funnel should open with folded shut.
 *
 * Complete ones only, and only past the threshold. Anything unfinished stays
 * open whatever the length: a collapsed row would hide the very field
 * standing between the operator and a saveable funnel. */
export function collapsedOnLoad(steps: readonly FunnelStep[]): number[] {
  if (steps.length < COLLAPSE_ON_LOAD_MIN_STEPS) return []
  return steps.map((s, i) => (stepComplete(s) ? i : -1)).filter((i) => i >= 0)
}

/**
 * A collapsed step in one line.
 *
 * Built from the same two phrase-makers the expanded form and the segment
 * builder use -- `wherePhrase` for predicates, `summarise` for the audience
 * tree -- rather than a third way of saying the same thing. A collapsed row
 * that described a step differently from its own expanded form would make
 * the reader distrust both.
 *
 * The audience is reported by SHAPE, not spelled out: a tree can be twenty
 * conditions deep and a summary that grew with it would defeat the collapse
 * it exists to serve. "audience: <its top-level sentence>" is enough to
 * recognise which step you are looking at, which is the only job a collapsed
 * row has.
 *
 * An unnamed step reads as "Not set" rather than as an empty string, so a
 * collapsed row is never a blank line the reader has to click to identify.
 * `stepComplete` means this should not happen through the UI, but a funnel
 * written through the API can carry anything the schema allows.
 *
 * `optional` is a part of its own, immediately after the event and in the
 * same one word the flow chart prints under an optional step's bar.
 * `collapsedOnLoad` folds every complete step once a funnel reaches four,
 * which is the length this feature was built for -- so without it, opening
 * a five-step funnel hides which step is optional until each row is
 * expanded one at a time.
 */
export function stepSummary(step: FunnelStep): string {
  const parts: string[] = [step.event.trim() === '' ? 'Not set' : step.event]
  if (step.optional === true) {
    parts.push('optional')
  }
  if (step.where != null && step.where.length > 0) {
    parts.push(`where ${wherePhrase(step.where)}`)
  }
  if (step.audience !== undefined) {
    parts.push(`audience: ${summarise(step.audience)}`)
  }
  return parts.join(' · ')
}
