import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FunnelRunResult, FunnelStep, StepResult } from '../../api/types.js'
import { FunnelFlow } from './FunnelFlow.js'
import { PLOT_HEIGHT } from './flowGeometry.js'

const step = (over: Partial<StepResult> & { index: number }): StepResult => ({
  event: `e${over.index}`,
  people: 0,
  from_previous: 1,
  from_start: 1,
  ...over,
})

function result(over: Partial<FunnelRunResult> = {}): FunnelRunResult {
  return {
    entered: 100,
    converted: 25,
    conversion_rate: 0.25,
    partial_window_entrants: 0,
    steps: [
      step({ index: 1, event: '$page', people: 100, from_previous: 1, from_start: 1 }),
      step({ index: 2, event: 'docs_search', people: 25, from_previous: 0.25, from_start: 0.25 }),
    ],
    range: { since: '2026-08-15T00:00:00Z', until: '2026-08-22T00:00:00Z' },
    as_of: '2026-08-22T00:00:00Z',
    warnings: [],
    ...over,
  } as FunnelRunResult
}

describe('FunnelFlow', () => {
  it('draws one bar per step, heights proportional to the entrant count', () => {
    render(<FunnelFlow result={result()} />)
    // Pinned by VALUE, not by shape: 100/100 is the full plot, 25/100 a
    // quarter of it. A test asserting only "has a height" would pass against
    // a chart that drew every bar the same.
    expect(screen.getByTestId('flow-bar-1')).toHaveAttribute('height', String(PLOT_HEIGHT))
    expect(screen.getByTestId('flow-bar-2')).toHaveAttribute('height', String(PLOT_HEIGHT / 4))
  })

  it('draws one fewer ribbon than there are steps', () => {
    render(<FunnelFlow result={result()} />)
    expect(screen.getByTestId('flow-ribbon-1')).toBeInTheDocument()
    expect(screen.queryByTestId('flow-ribbon-2')).not.toBeInTheDocument()
  })

  it('labels each step with from_start, not from_previous', () => {
    // THE MUTATION THIS FILE EXISTS FOR. The two rates differ only once a
    // funnel has three steps and both are plausible on screen, so swapping
    // them is invisible to a reader and to any test that checks "a
    // percentage is shown". Step 3 below is 40% of the previous step and 20%
    // of the start; the label must be the latter.
    render(
      <FunnelFlow
        result={result({
          entered: 100,
          converted: 20,
          conversion_rate: 0.2,
          steps: [
            step({ index: 1, event: 'a', people: 100, from_previous: 1, from_start: 1 }),
            step({ index: 2, event: 'b', people: 50, from_previous: 0.5, from_start: 0.5 }),
            step({ index: 3, event: 'c', people: 20, from_previous: 0.4, from_start: 0.2 }),
          ],
        })}
      />,
    )
    const third = screen.getByTestId('flow-step-3')
    expect(within(third).getByText('20.0%')).toBeInTheDocument()
    expect(within(third).queryByText('40.0%')).not.toBeInTheDocument()
  })

  it('names the biggest leak by the step that lost the most', () => {
    render(
      <FunnelFlow
        result={result({
          entered: 100,
          converted: 18,
          conversion_rate: 0.18,
          steps: [
            step({ index: 1, event: 'sessions', people: 100, from_previous: 1, from_start: 1 }),
            step({ index: 2, event: 'paywall', people: 80, from_previous: 0.8, from_start: 0.8 }),
            step({ index: 3, event: 'checkout', people: 20, from_previous: 0.25, from_start: 0.2 }),
            step({ index: 4, event: 'purchase', people: 18, from_previous: 0.9, from_start: 0.18 }),
          ],
        })}
      />,
    )
    const leak = screen.getByTestId('funnel-biggest-leak')
    expect(leak).toHaveTextContent('checkout')
    expect(leak).toHaveTextContent('75.0%')
  })

  it('says nothing about leaks when no step loses anyone', () => {
    render(
      <FunnelFlow
        result={result({
          entered: 10,
          converted: 10,
          conversion_rate: 1,
          steps: [
            step({ index: 1, event: 'a', people: 10, from_previous: 1, from_start: 1 }),
            step({ index: 2, event: 'b', people: 10, from_previous: 1, from_start: 1 }),
          ],
        })}
      />,
    )
    expect(screen.queryByTestId('funnel-biggest-leak')).not.toBeInTheDocument()
  })

  it('renders an empty funnel without NaN reaching any attribute', () => {
    // `entered === 0` is a real first-run state. A NaN in `height` or `d`
    // makes the browser drop the attribute and collapse the plot -- and it
    // is invisible to a test that only checks the component mounted.
    const { container } = render(
      <FunnelFlow
        result={result({
          entered: 0,
          converted: 0,
          conversion_rate: 0,
          steps: [
            step({ index: 1, event: 'a', people: 0, from_previous: 0, from_start: 0 }),
            step({ index: 2, event: 'b', people: 0, from_previous: 0, from_start: 0 }),
          ],
        })}
      />,
    )
    expect(container.innerHTML).not.toContain('NaN')
    expect(screen.getByTestId('flow-bar-1')).toBeInTheDocument()
  })

  it('shows a step’s where clause, and only against the step it belongs to', () => {
    const definition: FunnelStep[] = [
      { event: '$page', where: [{ property: 'path', operator: '=', value: '/docs' }] },
      { event: 'docs_search' },
    ]
    render(<FunnelFlow result={result()} definition={definition} />)
    expect(screen.getByTestId('flow-step-1-where')).toHaveTextContent('/docs')
    expect(screen.queryByTestId('flow-step-2-where')).not.toBeInTheDocument()
  })

  it('renders no where clause when the definition and the result may not correspond', () => {
    // Two independent requests produced these. A narrowing shown against the
    // wrong step would have an operator act on a population the screen never
    // measured, and that failure is silent -- so position agreement is not
    // enough, the event name has to match too.
    const stale: FunnelStep[] = [
      { event: 'something_else', where: [{ property: 'path', operator: '=', value: '/docs' }] },
      { event: 'docs_search' },
    ]
    render(<FunnelFlow result={result()} definition={stale} />)
    expect(screen.queryByTestId('flow-step-1-where')).not.toBeInTheDocument()
  })

  it('labels each ribbon with from_previous, not from_start', () => {
    // The number on a ribbon belongs to the TRANSITION it is drawn on. Step 3
    // below is 40% of the previous step and 20% of the start; the ribbon into
    // it must read 40%, while the number UNDER it reads 20%. Swapping them
    // makes the chart say the same thing twice and look like it said two.
    render(
      <FunnelFlow
        result={result({
          entered: 100,
          converted: 20,
          conversion_rate: 0.2,
          steps: [
            step({ index: 1, event: 'a', people: 100, from_previous: 1, from_start: 1 }),
            step({ index: 2, event: 'b', people: 50, from_previous: 0.5, from_start: 0.5 }),
            step({ index: 3, event: 'c', people: 20, from_previous: 0.4, from_start: 0.2 }),
          ],
        })}
      />,
    )
    expect(screen.getByTestId('flow-rate-2')).toHaveTextContent('40.0%')
    expect(screen.getByTestId('flow-step-3')).toHaveTextContent('20.0%')
  })

  it('draws one rate label per ribbon, never one for the first step', () => {
    // Step 1 has no incoming transition; a label there would have to be
    // from_previous = 1, i.e. a permanent "100%" that means nothing.
    render(<FunnelFlow result={result()} />)
    // 25.0%, which is this fixture's step-2 `from_previous` -- not the 64.9%
    // from the screenshot that prompted this feature.
    expect(screen.getByTestId('flow-rate-1')).toHaveTextContent('25.0%')
    expect(screen.queryByTestId('flow-rate-0')).not.toBeInTheDocument()
    expect(screen.queryByTestId('flow-rate-2')).not.toBeInTheDocument()
  })

  it('fills ribbons from their own token rather than a bar colour at reduced opacity', () => {
    // FOUND BY RENDERING IT, not by reading it. The first version drew each
    // ribbon as its source bar's colour at `opacity: 0.4`; blending a
    // saturated copper toward the surface desaturates it, and the ribbons
    // came out visibly GREY in light and olive in dark. Opacity over a
    // surface the component does not know the colour of is the trap; a token
    // that already IS the blend is the fix.
    const { container } = render(<FunnelFlow result={result()} />)
    const ribbon = screen.getByTestId('flow-ribbon-1')
    expect(ribbon).toHaveAttribute('fill', 'var(--chart-funnel-ribbon)')
    expect(ribbon).not.toHaveAttribute('opacity')
    expect(container.innerHTML).not.toContain('opacity')
  })

  it('caps the plot so a two-step funnel does not draw two enormous blocks', () => {
    // Also found by rendering: uncapped, two steps spread across a wide card
    // put each bar at ~240px, which reads as two blocks rather than a flow.
    // A cap, not a width -- the plot still shrinks to whatever room it gets.
    render(<FunnelFlow result={result()} />)
    expect(screen.getByTestId('funnel-flow').querySelector('[style*="max-width"]')).toHaveStyle({
      maxWidth: '400px',
    })
  })

  it('keeps every step inside the seven colours the stylesheet defines', () => {
    // An eight-step funnel is legal (MAX_FUNNEL_STEPS) and the validated ramp
    // has seven steps. A `--chart-funnel-8` would resolve to nothing and the
    // bar would render with no fill at all.
    const eight = Array.from({ length: 8 }, (_, i) =>
      step({
        index: i + 1,
        event: `e${i + 1}`,
        people: 100 - i * 10,
        from_start: (100 - i * 10) / 100,
      }),
    )
    const { container } = render(
      <FunnelFlow result={result({ entered: 100, converted: 30, steps: eight })} />,
    )
    expect(container.innerHTML).not.toContain('--chart-funnel-8')
    expect(container.innerHTML).toContain('--chart-funnel-7')
  })
})
