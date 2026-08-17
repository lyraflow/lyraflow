import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FunnelStep } from '../../api/types.js'
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

describe('StepBars narrowing', () => {
  // Two narrowed steps with two predicates each and four different
  // operators. One narrowed step could not tell "this step's predicates"
  // from "the first step's"; one predicate per step could not tell a comma
  // join from none; and an all-`=` fixture could not tell a worded operator
  // from a raw symbol.
  const DEFINITION: FunnelStep[] = [
    {
      event: 'page_view',
      where: [
        { property: 'page', operator: '=', value: 'changelog' },
        { property: 'duration_ms', operator: '>=', value: 30 },
      ],
    },
    {
      event: 'signup_started',
      where: [
        { property: 'plan', operator: '!=', value: 'free' },
        { property: 'seats', operator: '<=', value: 10 },
      ],
    },
    { event: 'signup_completed' },
  ]

  it("renders each step's own predicates, in the operator words", () => {
    const { container } = render(<StepBars result={RESULT} definition={DEFINITION} />)
    const one = screen.getByTestId('funnel-step-1-where')
    expect(one).toHaveTextContent('where page is changelog, duration_ms at least 30')
    const two = screen.getByTestId('funnel-step-2-where')
    expect(two).toHaveTextContent('where plan is not free, seats at most 10')
    // Step 1's clause must not have leaked onto step 2, which is exactly
    // what a component reading `definition[0]` for every row would do.
    expect(two).not.toHaveTextContent('changelog')
    expect(one).not.toHaveTextContent('free')
    for (const raw of ['>=', '!=', '<=']) {
      expect(container.textContent ?? '').not.toContain(raw)
    }
  })

  it('renders no clause for a step that carries none', () => {
    render(<StepBars result={RESULT} definition={DEFINITION} />)
    expect(screen.queryByTestId('funnel-step-3-where')).toBeNull()
  })

  it('keeps a clause inside its own step block, never beside the next step', () => {
    render(<StepBars result={RESULT} definition={DEFINITION} />)
    // Structural, not visual: the clause is a descendant of the step it
    // describes, so nothing between two steps can be read as narrowing
    // either one.
    expect(
      within(screen.getByTestId('funnel-step-2')).getByTestId('funnel-step-2-where'),
    ).toHaveTextContent('plan is not free')
    expect(
      within(screen.getByTestId('funnel-step-1')).queryByTestId('funnel-step-2-where'),
    ).toBeNull()
  })

  it('renders no clause at all without a definition -- numbers alone stay a complete rendering', () => {
    render(<StepBars result={RESULT} />)
    expect(screen.queryByTestId('funnel-step-1-where')).toBeNull()
    expect(screen.getByTestId('funnel-step-1')).toHaveTextContent('page_view')
  })

  it('shows nothing rather than a clause it cannot place, when the events at a position disagree', () => {
    // The funnel fetch and the run are independent requests, so a result on
    // screen can predate the definition beside it. A narrowing shown
    // against the wrong step would have an operator act on a population
    // never measured, and nothing on screen would say so.
    const edited: FunnelStep[] = [
      { event: 'landing_view', where: [{ property: 'page', operator: '=', value: 'changelog' }] },
      ...DEFINITION.slice(1),
    ]
    render(<StepBars result={RESULT} definition={edited} />)
    expect(screen.queryByTestId('funnel-step-1-where')).toBeNull()
    // The steps that DO still line up keep their clauses -- the guard is
    // per position, not a whole-chart switch.
    expect(screen.getByTestId('funnel-step-2-where')).toHaveTextContent('plan is not free')
  })

  it('shows nothing for a position the definition does not reach', () => {
    render(<StepBars result={RESULT} definition={[DEFINITION[0] as FunnelStep]} />)
    expect(screen.getByTestId('funnel-step-1-where')).toBeInTheDocument()
    expect(screen.queryByTestId('funnel-step-2-where')).toBeNull()
  })
})
