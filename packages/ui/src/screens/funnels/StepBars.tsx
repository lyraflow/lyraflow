import type { FunnelRunResult, FunnelStep, StepResult } from '../../api/types.js'
import { wherePhrase } from '../segments/vocabulary.js'
import { branchSlots } from './flowGeometry.js'
import { formatCount, formatPercent } from './format.js'

/**
 * The predicates narrowing the step at position `i`, or `null` when this
 * component cannot be certain which definition step the result's step at
 * that position corresponds to.
 *
 * `definition` and `result` arrive from two INDEPENDENT requests --
 * `FunnelDetail` fetches the funnel and runs it concurrently, and either
 * can land first or fail alone. `levels.ts` numbers a result step `i + 1`
 * over the definition's own array, so position is the correspondence; the
 * event-name check is what stops that assumption from being silent when it
 * stops holding (a result still on screen from before an edit, a definition
 * that arrived for a different funnel).
 *
 * When it cannot be certain it renders NOTHING, which is the same ruling
 * `summarise` was given for a clause that could absorb its neighbour's join
 * word: a narrowing shown against the wrong step would have an operator act
 * on a population the screen never measured, and that failure is invisible.
 * An omitted clause is merely less information.
 *
 * `optional` is checked by the same rule and for the same reason. An
 * optional treatment drawn against a required step has an operator read a
 * branch as a stage, and that failure is invisible too. When the two
 * disagree the RESULT wins -- it is what the numbers were computed from --
 * and this returns `null`, so a step whose shape the definition disagrees
 * about shows no narrowing.
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
 * A funnel result as one row per step, bar width proportional to `people`.
 *
 * Pure over its props: no client, no fetch, no clock. That is what lets the
 * segment and retention screens reuse it, and what lets these tests pin
 * values rather than shapes.
 *
 * NOTHING here computes a rate. `from_start` and `from_previous` both arrive
 * from the server, which returns both deliberately -- deriving one from a
 * chain of the other is "a multiplication every caller gets subtly wrong in a
 * different way" (packages/core/src/funnels/levels.ts). The same module
 * guarantees a zero denominator yields 0 rather than NaN; a client that
 * divides again would undo that.
 *
 * The one division below is a bar WIDTH, not a reported rate, and it is
 * guarded at zero because `entered === 0` is a real state -- an empty funnel
 * must render as zero-width bars, never as `NaN%` widths that collapse the
 * layout. It is also rounded to two decimal places: the width is purely
 * presentational, and asserting an unrounded float through style
 * serialisation is brittle.
 *
 * Drop rows are suppressed entirely when `entered === 0`, not rendered as
 * "100% dropped". `formatPercent(1 - step.from_previous)` is technically
 * correct there -- `from_previous` really is 0 -- but "100% dropped" reads
 * as a catastrophic funnel failure when the true fact is "no one has
 * entered yet" (a brand-new project's first-run state). This project
 * already draws that line elsewhere (the funnels list says "not run yet",
 * never "0%", for the same reason): a real zero and an absence of data are
 * different facts, and conflating them makes an empty state look broken.
 * The guard keys on `result.entered`, the funnel-wide entrant count, NOT on
 * any individual step's `people` -- a legitimate funnel whose last step
 * happens to convert zero people must still show the drop into that step.
 */
export function StepBars(props: {
  result: FunnelRunResult
  /** The funnel DEFINITION's steps, so a narrowed step says so instead of
   * showing a bare event name that a differently-predicated step would show
   * too. Optional: `result` alone is still a complete rendering, and this
   * component stays usable by a caller that has numbers and no definition. */
  definition?: readonly FunnelStep[] | null
  /** The step whose people are currently shown beneath the chart, by its
   * 1-indexed `index` -- the same number `onSelectStep` reports and the
   * API's `step` parameter expects. */
  selectedStep?: number | null
  /** Reports which step was clicked, by its 1-indexed `index`. Omitted by a
   * caller with nothing to do about a click -- `FunnelBuilder`'s preview
   * renders an unsaved definition with no funnel id, so there is no people
   * list it could open. Without this, a step row renders as an inert block:
   * no button, no focus stop, no `aria-pressed`. */
  onSelectStep?: (step: number) => void
}) {
  const { result, definition, selectedStep, onSelectStep } = props
  /* The step each optional step hangs off, by definition-order slot -- so a
   * branch's rate can name its own denominator instead of printing a bare
   * percentage of something unstated. */
  const branches = branchSlots(result.steps)
  /* The previous SPINE step for each required step, and `null` for an
   * optional one. Not `steps[i - 1]`: with an optional step in between, the
   * neighbour is a branch, and `previous.people - step.people` would subtract
   * a branch's population from a stage's. `from_previous` itself was already
   * computed against the right denominator by the server; this is the count
   * beside it, which is the half that had to be fixed here. */
  const previousSpine: (StepResult | null)[] = []
  {
    let lastRequired: StepResult | null = null
    for (const s of result.steps) {
      if (s.optional === true) {
        previousSpine.push(null)
        continue
      }
      previousSpine.push(lastRequired)
      lastRequired = s
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {result.steps.map((step, i) => {
        const optional = step.optional === true
        const previous = previousSpine[i] ?? null
        const branchSlot = branches[i]
        const branchPoint = branchSlot == null ? null : result.steps[branchSlot]
        const where = whereFor(definition, i, step)
        const width =
          result.entered === 0 ? 0 : Math.round((step.people / result.entered) * 10000) / 100
        const rowContent = (
          <>
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              {/* The badge sits OUTSIDE the truncating span, as its own
               * `shrink-0` sibling. FOUND BY RENDERING IT at 390px: inside
               * it, the ellipsis ate the word "optional" and the branch lost
               * its only marker on the narrowest screen -- the one where the
               * indent is hardest to read too. */}
              <span className="flex min-w-0 items-baseline gap-2 text-sm font-medium">
                <span className="min-w-0 truncate">
                  {step.index}. {step.event}
                </span>
                {optional && (
                  <span
                    data-testid={`funnel-step-${step.index}-optional`}
                    className="shrink-0 rounded-sm border border-dashed border-current px-1 text-xs font-normal text-muted-foreground"
                  >
                    optional
                  </span>
                )}
              </span>
              {/* An optional step is rated against the step it BRANCHES OFF,
               * so this column shows `from_previous` there and `from_start`
               * everywhere else. WHICH step that is goes on the line below
               * rather than here: two different denominators in one column
               * are unreadable without the words, and the words made this
               * column long enough at 390px to truncate the event name. */}
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {formatCount(step.people)} ·{' '}
                {formatPercent(optional ? step.from_previous : step.from_start)}
              </span>
            </div>
            {/* The other half of the branch's population, and deliberately
             * NOT a drop row. These people reached the branch point and did
             * not do this step; they are still in the funnel, and a reader
             * who takes them for a drop-off has the story backwards. Its own
             * line, with its own verb, so the two counts cannot be read as
             * one. */}
            {optional && step.skipped != null && (
              <p
                data-testid={`funnel-step-${step.index}-skipped`}
                className="min-w-0 break-words text-xs tabular-nums text-muted-foreground"
              >
                {branchPoint != null && `of ${branchPoint.event} · `}
                {formatCount(step.skipped)} skipped it and carried on
              </p>
            )}
            {/* Between the step's own name and its own bar, deliberately.
             * The line below a step block is the NEXT step's drop row, so
             * a clause placed after the bar would sit against it; here it
             * is bracketed by two things that already belong to this step
             * and cannot be read as narrowing another one. */}
            {where != null && (
              <p
                data-testid={`funnel-step-${step.index}-where`}
                className="min-w-0 break-words text-xs text-muted-foreground"
              >
                where {where}
              </p>
            )}
            <div className="h-2 w-full overflow-hidden rounded-sm bg-muted">
              {/* Outlined rather than filled for a branch: the fill is what
               * says "this much of the funnel got here", and a branch is not
               * a position in the funnel. The dash is the same mark the flow
               * plot uses on the same step, so the two renderings say the
               * one thing the same way. */}
              <div
                data-testid="bar-fill"
                data-optional={optional ? 'true' : undefined}
                className={
                  optional
                    ? 'h-full rounded-sm border border-dashed border-primary bg-transparent'
                    : 'h-full rounded-sm bg-primary'
                }
                style={{ width: `${width}%` }}
              />
            </div>
          </>
        )
        return (
          <div
            key={step.index}
            /* Indented, so a branch is visibly hanging off the chain rather
             * than sitting in it. */
            className={
              optional ? 'flex min-w-0 flex-col gap-1 pl-6' : 'flex min-w-0 flex-col gap-1'
            }
          >
            {previous && result.entered !== 0 && (
              <div
                data-testid={`funnel-drop-${step.index}`}
                className="pl-4 text-xs text-muted-foreground"
              >
                ↓ {formatPercent(1 - step.from_previous)} (
                {formatCount(previous.people - step.people)} dropped)
              </div>
            )}
            {/* A real `<button>`, not a `<div>` with an onClick -- this row
             * becomes the primary control for the people list beneath the
             * chart (a later screen), and a click handler on a non-button
             * element is unreachable by keyboard and invisible to assistive
             * technology. Rendered as a plain block instead, with no
             * `onClick`, no `aria-pressed` and no focus stop, when the
             * caller passed no `onSelectStep` -- see the prop doc above. */}
            {onSelectStep != null ? (
              <button
                type="button"
                data-testid={`funnel-step-${step.index}`}
                aria-pressed={selectedStep === step.index}
                aria-label={`Show people at step ${step.index}: ${step.event}${optional ? ' (optional)' : ''}`}
                onClick={() => onSelectStep(step.index)}
                className="flex min-w-0 flex-col gap-1 rounded-sm border-0 bg-transparent p-1 text-left hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent"
              >
                {rowContent}
              </button>
            ) : (
              <div
                data-testid={`funnel-step-${step.index}`}
                className="flex min-w-0 flex-col gap-1 p-1"
              >
                {rowContent}
              </div>
            )}
          </div>
        )
      })}
      <p className="mt-2 text-sm text-muted-foreground">
        Entered {formatCount(result.entered)} · Converted {formatCount(result.converted)} ·{' '}
        {formatPercent(result.conversion_rate)}
      </p>
    </div>
  )
}
