import type { FunnelRunResult, FunnelStep } from '../../api/types.js'
import { FunnelFlow } from './FunnelFlow.js'
import { StepBars } from './StepBars.js'
import { useIsWide } from './useIsWide.js'

/**
 * Renders the funnel as a left-to-right flow where there is room for one,
 * and as the stacked bars where there is not.
 *
 * ONE of the two, never both. Rendering both and hiding one with CSS would
 * be simpler, and is wrong twice: a screen reader would read the funnel
 * twice, and every `data-testid` in the pair would resolve to two elements.
 * That is why this consults a media query rather than a `hidden md:block`
 * pair -- see `useIsWide`, which defaults to the BARS wherever `matchMedia`
 * is absent.
 *
 * The two renderings are deliberately not one component with a `layout`
 * prop. They share no markup: one is an SVG plot with an HTML grid over it,
 * the other is a list of rows. What they share is the `whereFor` rule and
 * the numbers, and those are shared by copying neither -- `whereFor` is the
 * same logic stated once in each file because it is six lines whose
 * behaviour is load-bearing, and `format.ts` is imported by both.
 *
 * Every caller that shows a funnel result goes through here, so the builder's
 * preview and the detail screen cannot drift into showing the same numbers
 * two different ways.
 */
export function FunnelFlowOrBars(props: {
  result: FunnelRunResult
  definition?: readonly FunnelStep[] | null
  /** The step whose people are currently shown beneath the chart, by its
   * 1-indexed `index`. Forwarded verbatim to whichever of `FunnelFlow` /
   * `StepBars` renders -- see either's own doc comment for what it does. */
  selectedStep?: number | null
  /** Reports which step was clicked. Omitted by a caller with nothing to do
   * about a click -- `FunnelBuilder`'s preview passes neither this nor
   * `selectedStep`, which is what keeps its unsaved-definition preview
   * inert: both `FunnelFlow` and `StepBars` render no interactive step
   * control at all without it. */
  onSelectStep?: (step: number) => void
}) {
  const wide = useIsWide()
  return wide ? <FunnelFlow {...props} /> : <StepBars {...props} />
}
