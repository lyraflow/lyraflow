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
}) {
  const { result, definition } = props
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {result.steps.map((step, i) => {
        const previous = i === 0 ? null : result.steps[i - 1]
        const where = whereFor(definition, i, step.event)
        const width =
          result.entered === 0 ? 0 : Math.round((step.people / result.entered) * 10000) / 100
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
            <div data-testid={`funnel-step-${step.index}`} className="flex min-w-0 flex-col gap-1">
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
            </div>
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
