import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { FunnelRunResult, FunnelStep, StepResult } from '../../api/types.js'
import { FunnelFlow } from './FunnelFlow.js'
import { BAR_WIDTH, PLOT_HEIGHT, barX } from './flowGeometry.js'

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

describe('FunnelFlow selection', () => {
  it("calls onSelectStep with the step's 1-indexed index when its slot is clicked", async () => {
    const user = userEvent.setup()
    const onSelectStep = vi.fn()
    render(<FunnelFlow result={result()} onSelectStep={onSelectStep} />)
    await user.click(screen.getByTestId('flow-step-2-select'))
    expect(onSelectStep).toHaveBeenCalledTimes(1)
    expect(onSelectStep).toHaveBeenCalledWith(2)
  })

  it('marks only the selected step as pressed, via aria-pressed rather than colour alone', () => {
    render(<FunnelFlow result={result()} selectedStep={2} onSelectStep={() => {}} />)
    expect(screen.getByTestId('flow-step-1-select')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('flow-step-2-select')).toHaveAttribute('aria-pressed', 'true')
  })

  it('names each step button with what it does and which step it means -- the event name alone is ambiguous when two steps share it', () => {
    render(<FunnelFlow result={result()} onSelectStep={() => {}} />)
    expect(screen.getByTestId('flow-step-2-select')).toHaveAccessibleName(
      'Show people at step 2: docs_search',
    )
  })

  it('renders no selection buttons, and nothing focusable, without onSelectStep -- the builder preview has no funnel id to list people for', () => {
    render(<FunnelFlow result={result()} />)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('has no ancestor that disables pointer events -- any such ancestor makes the button permanently unclickable in a real browser, even though jsdom cannot detect that from a click alone', () => {
    // A structural check that a button merely sits OUTSIDE the label overlay
    // is a proxy for this, not the invariant itself: it is defeated by
    // `pointer-events-none` landing on the new layer's OWN wrapper, which is
    // still "outside" the label overlay yet still swallows every click. The
    // real rule is about the whole ancestor chain, not one named container.
    render(<FunnelFlow result={result()} onSelectStep={() => {}} />)
    const button = screen.getByTestId('flow-step-1-select')
    let node: Element | null = button.parentElement
    let disabledBy: Element | null = null
    while (node) {
      if (/pointer-events-none/.test(node.className)) {
        disabledBy = node
        break
      }
      node = node.parentElement
    }
    expect(disabledBy).toBeNull()
  })
})

describe('FunnelFlow with an optional step', () => {
  // Step 3 of four is optional: it branches off step 2 and step 4 follows
  // step 2 on the spine. 30 of step 2's 80 took the branch, 50 did not, and
  // 40 of the same 80 went on to step 4 -- deliberately unrelated numbers,
  // so a rendering that confuses the branch with the chain shows it.
  const BRANCHED = result({
    entered: 100,
    converted: 40,
    conversion_rate: 0.4,
    steps: [
      step({ index: 1, event: 'signup', people: 100, from_previous: 1, from_start: 1 }),
      step({ index: 2, event: 'onboarded', people: 80, from_previous: 0.8, from_start: 0.8 }),
      step({
        index: 3,
        event: 'video_submitted',
        people: 30,
        from_previous: 0.375,
        from_start: 0.3,
        optional: true,
        skipped: 50,
      }),
      step({ index: 4, event: 'purchase', people: 40, from_previous: 0.5, from_start: 0.4 }),
    ],
  })

  it('draws one ribbon per SPINE pair, so a four-step funnel with a branch draws two, not three', () => {
    render(<FunnelFlow result={BRANCHED} />)
    expect(screen.getByTestId('flow-ribbon-1')).toBeInTheDocument()
    expect(screen.getByTestId('flow-ribbon-2')).toBeInTheDocument()
    // Step 3 is the branch. A ribbon leaving it would be a third stage
    // transition in a funnel that has two.
    expect(screen.queryByTestId('flow-ribbon-3')).not.toBeInTheDocument()
    expect(screen.queryByTestId('flow-ribbon-4')).not.toBeInTheDocument()
  })

  it('spans the spine ribbon ACROSS the optional slot at full geometry, from step 2 to step 4', () => {
    // THE MUTATION THIS BLOCK EXISTS FOR. A ribbon routed 2 -> 3 -> 4 draws
    // two losses that did not happen: 80 people did not become 30 and then
    // 30 did not become 40. They went 80 -> 40 down the chain, and 30 of the
    // 80 took a side branch on the way. The taper is a claim about where
    // people were lost, so pointing it at a branch is not a cosmetic error.
    render(<FunnelFlow result={BRANCHED} />)
    const d = screen.getByTestId('flow-ribbon-2').getAttribute('d') ?? ''
    expect(d.startsWith(`M ${barX(1) + BAR_WIDTH} ${PLOT_HEIGHT - 144}`)).toBe(true)
    expect(d).toContain(`${barX(3)} ${PLOT_HEIGHT - 72}`)
    // Its height at both ends is step 2's and step 4's, untouched by the
    // branch between them.
    expect(d).not.toContain(`${PLOT_HEIGHT - 54}`)
  })

  it('lets no ribbon start or land at the optional slot at all', () => {
    // Stated over EVERY ribbon rather than over the two this fixture has, so
    // it still holds for a funnel shaped differently. `barX(2)` is the
    // optional bar's left edge and `barX(2) + BAR_WIDTH` its right; a ribbon
    // touching either is one that treated the branch as a stage.
    const { container } = render(<FunnelFlow result={BRANCHED} />)
    const ribbons = [...container.querySelectorAll('[data-testid^="flow-ribbon-"]')]
    expect(ribbons.length).toBeGreaterThan(0)
    for (const ribbon of ribbons) {
      const d = ribbon.getAttribute('d') ?? ''
      expect(d).not.toContain(`M ${barX(2) + BAR_WIDTH} `)
      expect(d).not.toContain(` ${barX(2)} `)
    }
  })

  it('reads each ribbon label from the step the ribbon LANDS on, across the span', () => {
    // Step 4's `from_previous` is a share of step 2, because step 2 is what
    // precedes it on the spine. A label reading `steps[i + 1]` would print
    // the branch's 37.5% on the chain's ribbon.
    render(<FunnelFlow result={BRANCHED} />)
    expect(screen.getByTestId('flow-rate-2')).toHaveTextContent('50.0%')
    expect(screen.getByTestId('flow-rate-2')).not.toHaveTextContent('37.5%')
    expect(screen.queryByTestId('flow-rate-3')).not.toBeInTheDocument()
  })

  it('hangs the branch off its own branch point with a stroked, dashed, unfillable connector', () => {
    render(<FunnelFlow result={BRANCHED} />)
    const branch = screen.getByTestId('flow-branch-3')
    expect(branch).toHaveAttribute('fill', 'none')
    expect(branch).toHaveAttribute('stroke-dasharray', '4 3')
    const d = branch.getAttribute('d') ?? ''
    // From step 2's bar, not from step 1's and not from the plot edge.
    expect(d.startsWith(`M ${barX(1) + BAR_WIDTH} ${PLOT_HEIGHT - 144}`)).toBe(true)
    // No area: a `Z` or a baseline leg would make this a taper, which would
    // say people were lost between the branch point and the branch.
    expect(d).not.toContain('Z')
    expect(d).not.toContain('L')
  })

  it('marks the optional bar itself, in the dash and in words', () => {
    render(<FunnelFlow result={BRANCHED} />)
    const bar = screen.getByTestId('flow-bar-3')
    expect(bar).toHaveAttribute('stroke-dasharray', '4 3')
    expect(screen.getByTestId('flow-step-3-optional')).toHaveTextContent('optional')
    // A required bar keeps its solid ramp fill and gains nothing.
    expect(screen.getByTestId('flow-bar-4')).not.toHaveAttribute('stroke-dasharray')
    expect(screen.queryByTestId('flow-step-4-optional')).not.toBeInTheDocument()
  })

  it('gives the optional step both of its numbers, each with its own verb', () => {
    // 30 did it, 50 did not, and those 50 are still in the funnel. A reader
    // who takes them for a drop-off has the story backwards, which is why
    // the two counts never share a separator.
    render(<FunnelFlow result={BRANCHED} />)
    const cell = screen.getByTestId('flow-step-3')
    expect(cell).toHaveTextContent('30 did')
    expect(screen.getByTestId('flow-step-3-skipped')).toHaveTextContent('50 skipped')
    // `from_previous`, not `from_start`: 37.5% of the step it branches off,
    // not 30.0% of the entrants. Both are true; only one shares a
    // denominator with the words beside it.
    expect(cell).toHaveTextContent('37.5%')
    expect(cell).not.toHaveTextContent('30.0%')
  })

  it('never names the branch as the biggest leak, even when it is the steepest number on screen', () => {
    // The branch loses 62.5% of its branch point and step 4 loses 50%. The
    // branch is not in the chain, so it is not in the comparison -- naming
    // it would tell an operator to go fix a side path nobody was expected
    // to take.
    render(<FunnelFlow result={BRANCHED} />)
    const leak = screen.getByTestId('funnel-biggest-leak')
    expect(leak).toHaveTextContent('purchase')
    expect(leak).not.toHaveTextContent('video_submitted')
  })

  it('paints the branch in its branch point’s ramp step rather than consuming one of its own', () => {
    // Three spine stages, so the ramp runs 1, 2, 3. The branch borrows step
    // 2 -- its branch point's -- and step 4 still gets 3. A branch that
    // consumed a ramp step would repaint every later stage, so adding a
    // side path would change the colour of stages it did not touch.
    const { container } = render(<FunnelFlow result={BRANCHED} />)
    expect(screen.getByTestId('flow-bar-2')).toHaveAttribute('fill', 'var(--chart-funnel-2)')
    expect(screen.getByTestId('flow-bar-3')).toHaveAttribute('stroke', 'var(--chart-funnel-2)')
    expect(screen.getByTestId('flow-bar-4')).toHaveAttribute('fill', 'var(--chart-funnel-3)')
    expect(container.innerHTML).not.toContain('--chart-funnel-4')
  })

  it('renders as the RESULT says and shows no narrowing when the definition disagrees about optionality', () => {
    // Same rule as the event-name check, and for the same reason: these
    // arrive from two independent requests. The numbers were computed from
    // the definition the RUN used, so the result wins -- and a clause that
    // may belong to a different shape of step is not shown at all.
    const stale: FunnelStep[] = [
      { event: 'signup' },
      { event: 'onboarded' },
      {
        event: 'video_submitted',
        where: [{ property: 'kind', operator: '=', value: 'intro' }],
      },
      { event: 'purchase' },
    ]
    render(<FunnelFlow result={BRANCHED} definition={stale} />)
    expect(screen.queryByTestId('flow-step-3-where')).not.toBeInTheDocument()
    // Still drawn as a branch, because that is what the numbers are.
    expect(screen.getByTestId('flow-bar-3')).toHaveAttribute('stroke-dasharray', '4 3')
    expect(screen.getByTestId('flow-step-3-optional')).toBeInTheDocument()
    expect(screen.queryByTestId('flow-ribbon-3')).not.toBeInTheDocument()
  })

  it('keeps a clause on a step the definition DOES agree about', () => {
    // The guard is per position, not a whole-chart switch.
    const definition: FunnelStep[] = [
      { event: 'signup', where: [{ property: 'plan', operator: '=', value: 'pro' }] },
      { event: 'onboarded' },
      { event: 'video_submitted', optional: true },
      { event: 'purchase' },
    ]
    render(<FunnelFlow result={BRANCHED} definition={definition} />)
    expect(screen.getByTestId('flow-step-1-where')).toHaveTextContent('pro')
  })

  it('draws two adjacent branches off the SAME required step, still with one spanning ribbon', () => {
    // Both hang off step 2; the second does NOT hang off the first. One
    // ribbon spans all three slots between step 2 and step 5.
    const two = result({
      entered: 100,
      converted: 40,
      conversion_rate: 0.4,
      steps: [
        step({ index: 1, event: 'a', people: 100, from_previous: 1, from_start: 1 }),
        step({ index: 2, event: 'b', people: 80, from_previous: 0.8, from_start: 0.8 }),
        step({
          index: 3,
          event: 'c',
          people: 30,
          from_previous: 0.375,
          from_start: 0.3,
          optional: true,
          skipped: 50,
        }),
        step({
          index: 4,
          event: 'd',
          people: 20,
          from_previous: 0.25,
          from_start: 0.2,
          optional: true,
          skipped: 60,
        }),
        step({ index: 5, event: 'e', people: 40, from_previous: 0.5, from_start: 0.4 }),
      ],
    })
    render(<FunnelFlow result={two} />)
    const d = screen.getByTestId('flow-ribbon-2').getAttribute('d') ?? ''
    expect(d.startsWith(`M ${barX(1) + BAR_WIDTH} `)).toBe(true)
    expect(d).toContain(`${barX(4)} `)
    // Both connectors start at step 2's bar.
    for (const id of ['flow-branch-3', 'flow-branch-4']) {
      const branch = screen.getByTestId(id).getAttribute('d') ?? ''
      expect(branch.startsWith(`M ${barX(1) + BAR_WIDTH} `)).toBe(true)
    }
  })
})
