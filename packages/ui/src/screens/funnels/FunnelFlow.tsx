import type { FunnelRunResult, FunnelStep } from '../../api/types.js'
import { wherePhrase } from '../segments/vocabulary.js'
import {
  BAR_WIDTH,
  PLOT_HEIGHT,
  barHeight,
  barX,
  biggestLeak,
  plotWidth,
  rampIndex,
  ribbonPath,
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
}) {
  const { result, definition } = props
  const steps = result.steps
  const total = steps.length
  const heights = steps.map((s) => barHeight(s.people, result.entered))
  const leak = biggestLeak(steps, result.entered)
  const columns = { gridTemplateColumns: `repeat(${Math.max(1, total)}, minmax(0, 1fr))` }

  return (
    <div data-testid="funnel-flow" className="flex min-w-0 flex-col gap-2">
      {/* Stage names, above the plot as in a column chart -- the reader
       * needs to know what a bar IS before they read how tall it is. */}
      <div className="grid gap-1" style={columns}>
        {steps.map((s, i) => {
          const where = whereFor(definition, i, s.event)
          return (
            <div key={s.index} className="min-w-0 px-1 text-center">
              <p className="truncate text-sm font-medium" title={s.event}>
                {s.event}
              </p>
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

      {/* `height` in pixels equal to the viewBox height, so the vertical
       * scale is exactly 1 and only the horizontal axis stretches. Under a
       * vertical stretch every `rx` distorts and a 4px corner becomes
       * whatever the container's aspect ratio makes it. */}
      <svg
        role="img"
        aria-label={`Funnel flow: ${steps.map((s) => `${s.event} ${formatPercent(s.from_start)}`).join(', ')}`}
        viewBox={`0 0 ${plotWidth(total)} ${PLOT_HEIGHT}`}
        preserveAspectRatio="none"
        width="100%"
        height={PLOT_HEIGHT}
        className="block"
      >
        <title>Funnel flow</title>
        {/* Ribbons first, so a bar's own edge always sits on top of the
         * ribbon meeting it rather than being overdrawn by it. */}
        {steps.slice(0, -1).map((s, i) => (
          <path
            key={`ribbon-${s.index}`}
            data-testid={`flow-ribbon-${s.index}`}
            d={ribbonPath(heights[i] as number, heights[i + 1] as number, i)}
            fill={`var(--chart-funnel-${rampIndex(i, total)})`}
            opacity={0.4}
          />
        ))}
        {steps.map((s, i) => (
          <rect
            key={`bar-${s.index}`}
            data-testid={`flow-bar-${s.index}`}
            x={barX(i)}
            y={PLOT_HEIGHT - (heights[i] as number)}
            width={BAR_WIDTH}
            height={heights[i] as number}
            rx={4}
            fill={`var(--chart-funnel-${rampIndex(i, total)})`}
          />
        ))}
      </svg>

      {/* `from_start` as the headline and the count beneath it: the share is
       * what the bar height already drew, so it reads as a label rather than
       * as new information, and the absolute number is what an operator
       * copies into a ticket. Both in text tokens, never in the series
       * colour -- the bar above carries identity. */}
      <div className="grid gap-1" style={columns}>
        {steps.map((s) => (
          <div key={s.index} data-testid={`flow-step-${s.index}`} className="min-w-0 text-center">
            <p className="text-base font-semibold tabular-nums">{formatPercent(s.from_start)}</p>
            <p className="text-xs tabular-nums text-muted-foreground">{formatCount(s.people)}</p>
          </div>
        ))}
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
