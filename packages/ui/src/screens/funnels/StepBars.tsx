import type { FunnelRunResult, FunnelStep } from '../../api/types.js'
import { wherePhrase } from '../segments/vocabulary.js'
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
 */
function whereFor(
  definition: readonly FunnelStep[] | null | undefined,
  i: number,
  event: string,
): string | null {
  const step = definition?.[i]
  if (step == null || step.event !== event) return null
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
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {result.steps.map((step, i) => {
        const previous = i === 0 ? null : result.steps[i - 1]
        const where = whereFor(definition, i, step.event)
        const width =
          result.entered === 0 ? 0 : Math.round((step.people / result.entered) * 10000) / 100
        const rowContent = (
          <>
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm font-medium">
                {step.index}. {step.event}
              </span>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {formatCount(step.people)} · {formatPercent(step.from_start)}
              </span>
            </div>
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
              <div
                data-testid="bar-fill"
                className="h-full rounded-sm bg-primary"
                style={{ width: `${width}%` }}
              />
            </div>
          </>
        )
        return (
          <div key={step.index} className="flex min-w-0 flex-col gap-1">
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
                aria-label={`Show people at step ${step.index}: ${step.event}`}
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
