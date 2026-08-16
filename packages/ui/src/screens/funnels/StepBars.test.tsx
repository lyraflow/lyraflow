import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { StepBars } from './StepBars.js'

const RESULT = {
  entered: 1204,
  converted: 491,
  conversion_rate: 0.4078,
  partial_window_entrants: 312,
  range: { since: '2026-08-08T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' },
  as_of: '2026-08-15T12:00:00.000Z',
  warnings: [],
  steps: [
    { index: 1, event: 'page_view', people: 1204, from_previous: 1, from_start: 1 },
    { index: 2, event: 'signup_started', people: 718, from_previous: 0.5963, from_start: 0.5963 },
    { index: 3, event: 'signup_completed', people: 491, from_previous: 0.6839, from_start: 0.4078 },
  ],
}

describe('StepBars', () => {
  it('renders the server-supplied from_start for each step', () => {
    render(<StepBars result={RESULT} />)
    const step3 = screen.getByTestId('funnel-step-3')
    expect(step3).toHaveTextContent('491')
    // 40.8% is the server's from_start. A client deriving it from the chain
    // 1 * 0.5963 * 0.6839 gets 40.78...% which also renders "40.8%" -- so this
    // assertion alone cannot catch derivation. The next test does.
    expect(step3).toHaveTextContent('40.8%')
  })

  it('uses from_start verbatim, not a product of from_previous', () => {
    // Deliberately inconsistent: the chain would give ~0.25, the server says 0.9.
    // A client that multiplies renders 25.0%; one that reads from_start renders 90%.
    const skewed = {
      ...RESULT,
      steps: [
        { index: 1, event: 'a', people: 100, from_previous: 1, from_start: 1 },
        { index: 2, event: 'b', people: 50, from_previous: 0.5, from_start: 0.9 },
      ],
    }
    render(<StepBars result={skewed} />)
    // '90.0%', not '90%': formatPercent only drops the decimal for exact 0 and 1.
    expect(screen.getByTestId('funnel-step-2')).toHaveTextContent('90.0%')
    expect(screen.getByTestId('funnel-step-2')).not.toHaveTextContent('50.0%')
  })

  it('renders every per-step rate as 0%, never NaN, for an empty funnel', () => {
    const empty = {
      ...RESULT,
      entered: 0,
      converted: 0,
      conversion_rate: 0,
      partial_window_entrants: 0,
      steps: [
        { index: 1, event: 'a', people: 0, from_previous: 0, from_start: 0 },
        { index: 2, event: 'b', people: 0, from_previous: 0, from_start: 0 },
      ],
    }
    const { container } = render(<StepBars result={empty} />)
    expect(container.textContent).not.toMatch(/NaN/)
    expect(screen.getByTestId('funnel-step-1')).toHaveTextContent('0%')
    expect(screen.getByTestId('funnel-step-2')).toHaveTextContent('0%')
  })

  it('renders no drop row at all for an empty funnel -- "100% dropped" would be its own lie when nothing has happened yet', () => {
    const empty = {
      ...RESULT,
      entered: 0,
      converted: 0,
      conversion_rate: 0,
      partial_window_entrants: 0,
      steps: [
        { index: 1, event: 'a', people: 0, from_previous: 0, from_start: 0 },
        { index: 2, event: 'b', people: 0, from_previous: 0, from_start: 0 },
        { index: 3, event: 'c', people: 0, from_previous: 0, from_start: 0 },
      ],
    }
    const { container } = render(<StepBars result={empty} />)
    expect(container.textContent).not.toMatch(/NaN/)
    expect(container.querySelectorAll('[data-testid^="funnel-drop-"]')).toHaveLength(0)
  })

  it("still shows the drop row into a step that itself reaches zero people, as long as the funnel had entrants -- the empty-funnel guard must key on entered, not on a step's own people count", () => {
    const lastStepZero = {
      ...RESULT,
      steps: [
        { index: 1, event: 'a', people: 1204, from_previous: 1, from_start: 1 },
        { index: 2, event: 'b', people: 0, from_previous: 0, from_start: 0 },
      ],
    }
    render(<StepBars result={lastStepZero} />)
    const drop = screen.getByTestId('funnel-drop-2')
    expect(drop).toHaveTextContent('1,204') // 1204 - 0 dropped
    expect(drop).toHaveTextContent('100%') // 1 - 0 from_previous
  })

  it('states the drop between consecutive steps as a count and a percentage', () => {
    render(<StepBars result={RESULT} />)
    const drop = screen.getByTestId('funnel-drop-2')
    expect(drop).toHaveTextContent('486') // 1204 - 718
    expect(drop).toHaveTextContent('40.4%') // 1 - 0.5963
  })

  it('computes the drop from from_previous, not from_start -- they coincide at step 2 in this fixture, so this must use a step where they diverge', () => {
    render(<StepBars result={RESULT} />)
    const drop = screen.getByTestId('funnel-drop-3')
    // step 3: from_previous = 0.6839 -> drop 31.6%. from_start = 0.4078 -> would
    // wrongly render 59.2% if the drop mistakenly read from_start instead.
    expect(drop).toHaveTextContent('31.6%')
    expect(drop).not.toHaveTextContent('59.2%')
    expect(drop).toHaveTextContent('227') // 718 - 491
  })

  it('gives the first step no drop row -- it has no predecessor', () => {
    render(<StepBars result={RESULT} />)
    expect(screen.queryByTestId('funnel-drop-1')).toBeNull()
  })

  it('sizes a bar from people relative to the entrant count, not to the max rate', () => {
    render(<StepBars result={RESULT} />)
    const bar = within(screen.getByTestId('funnel-step-2')).getByTestId('bar-fill')
    // 718/1204 = 59.6345...% rounded to two decimal places -- presentational
    // only, per the controller correction. Asserting the unrounded float
    // through jsdom's style serialisation is brittle.
    expect(bar).toHaveStyle({ width: '59.63%' })
  })
})
