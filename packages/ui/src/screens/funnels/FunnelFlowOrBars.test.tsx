import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FunnelRunResult } from '../../api/types.js'
import { FunnelFlowOrBars } from './FunnelFlowOrBars.js'

const RESULT = {
  entered: 100,
  converted: 25,
  conversion_rate: 0.25,
  partial_window_entrants: 0,
  steps: [
    { index: 1, event: '$page', people: 100, from_previous: 1, from_start: 1 },
    { index: 2, event: 'docs_search', people: 25, from_previous: 0.25, from_start: 0.25 },
  ],
  range: { since: '2026-08-15T00:00:00Z', until: '2026-08-22T00:00:00Z' },
  as_of: '2026-08-22T00:00:00Z',
  warnings: [],
} as unknown as FunnelRunResult

/** jsdom implements no `matchMedia`, so a test that cares what the query
 * answers has to supply one -- the same arrangement `ThemeToggle.test.tsx`
 * uses, and for the same reason. */
function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('FunnelFlowOrBars', () => {
  it('renders the flow when the viewport is wide', () => {
    stubMatchMedia(true)
    render(<FunnelFlowOrBars result={RESULT} />)
    expect(screen.getByTestId('funnel-flow')).toBeInTheDocument()
    expect(screen.queryByTestId('funnel-step-1')).not.toBeInTheDocument()
  })

  it('renders the stacked bars when the viewport is narrow', () => {
    stubMatchMedia(false)
    render(<FunnelFlowOrBars result={RESULT} />)
    expect(screen.getByTestId('funnel-step-1')).toBeInTheDocument()
    expect(screen.queryByTestId('funnel-flow')).not.toBeInTheDocument()
  })

  it('falls back to the bars in an environment with no matchMedia at all', () => {
    // The fallback DIRECTION is the safety property. Getting it backwards
    // means a chart rendering into 48px slots wherever the API is missing --
    // which is every server-rendered and test-rendered tree.
    vi.stubGlobal('matchMedia', undefined)
    render(<FunnelFlowOrBars result={RESULT} />)
    expect(screen.getByTestId('funnel-step-1')).toBeInTheDocument()
    expect(screen.queryByTestId('funnel-flow')).not.toBeInTheDocument()
  })

  // Task 6: `FunnelDetail` passes `selectedStep`/`onSelectStep` all the way
  // down to whichever of the two actually renders -- this was the one part
  // of the wiring this file itself owns.
  it('forwards selectedStep and onSelectStep to the flow rendering', () => {
    stubMatchMedia(true)
    const onSelectStep = vi.fn()
    render(<FunnelFlowOrBars result={RESULT} selectedStep={2} onSelectStep={onSelectStep} />)
    expect(screen.getByTestId('flow-step-2-select')).toHaveAttribute('aria-pressed', 'true')
    screen.getByTestId('flow-step-1-select').click()
    expect(onSelectStep).toHaveBeenCalledWith(1)
  })

  it('forwards selectedStep and onSelectStep to the bars rendering', () => {
    stubMatchMedia(false)
    const onSelectStep = vi.fn()
    render(<FunnelFlowOrBars result={RESULT} selectedStep={2} onSelectStep={onSelectStep} />)
    expect(screen.getByTestId('funnel-step-2')).toHaveAttribute('aria-pressed', 'true')
    screen.getByTestId('funnel-step-1').click()
    expect(onSelectStep).toHaveBeenCalledWith(1)
  })

  it('renders exactly one of the two, never both', () => {
    // Rendering both and hiding one with CSS would read the funnel twice to
    // a screen reader and make every shared testid resolve to two elements.
    stubMatchMedia(true)
    const { container } = render(<FunnelFlowOrBars result={RESULT} />)
    expect(container.querySelectorAll('[data-testid="funnel-flow"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-testid="funnel-step-1"]')).toHaveLength(0)
  })
})
