import type { FunnelRunResult } from '../../api/types.js'
import { formatCount, formatPercent } from './format.js'

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
 */
export function StepBars(props: { result: FunnelRunResult }) {
  const { result } = props
  return (
    <div className="flex min-w-0 flex-col gap-1">
      {result.steps.map((step, i) => {
        const previous = i === 0 ? null : result.steps[i - 1]
        const width =
          result.entered === 0 ? 0 : Math.round((step.people / result.entered) * 10000) / 100
        return (
          <div key={step.index} className="flex min-w-0 flex-col gap-1">
            {previous && (
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
