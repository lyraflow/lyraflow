import { describe, expect, it } from 'vitest'
import type { StepResult } from '../../api/types.js'
import {
  BAR_WIDTH,
  LABEL_HEIGHT,
  MIN_BAR_HEIGHT,
  PLOT_HEIGHT,
  RAMP_STEPS,
  barHeight,
  barX,
  biggestLeak,
  branchPath,
  branchSlots,
  labelColumns,
  plotWidth,
  rampIndex,
  rampIndexes,
  ribbonLabelY,
  ribbonPath,
  spineSlots,
  spineSteps,
} from './flowGeometry.js'

const step = (over: Partial<StepResult> & { index: number }): StepResult => ({
  event: `e${over.index}`,
  people: 0,
  from_previous: 1,
  from_start: 1,
  ...over,
})

describe('barHeight', () => {
  it('scales a step against the entrant count, not against the previous step', () => {
    // The bar says "this share of everyone who entered", which is what
    // `from_start` reports. Scaling against the previous step instead would
    // draw every surviving step at full height and hide the funnel entirely.
    expect(barHeight(100, 100)).toBe(PLOT_HEIGHT)
    expect(barHeight(50, 100)).toBe(PLOT_HEIGHT / 2)
    expect(barHeight(25, 100)).toBe(PLOT_HEIGHT / 4)
  })

  it('never returns NaN when nobody entered', () => {
    // `entered === 0` is a real first-run state. A NaN here reaches the DOM
    // as an invalid attribute and collapses the plot -- the same guard
    // `StepBars` already carries for its own widths.
    const h = barHeight(0, 0)
    expect(Number.isNaN(h)).toBe(false)
    expect(h).toBe(MIN_BAR_HEIGHT)
  })

  it('floors a converted-nobody step at a visible sliver, not at zero', () => {
    // Zero height reads as a rendering failure; a sliver reads as a zero.
    expect(barHeight(0, 500)).toBe(MIN_BAR_HEIGHT)
  })
})

describe('rampIndex', () => {
  it('runs darkest-first across the ramp for a funnel that fits', () => {
    expect(rampIndex(0, 5)).toBe(1)
    expect(rampIndex(4, 5)).toBe(5)
  })

  it('gives a single-step list the first ramp step rather than dividing by zero', () => {
    expect(rampIndex(0, 1)).toBe(1)
  })

  it('repeats the palest step for an eight-step funnel rather than inventing an eighth colour', () => {
    // The validated ramp has 7 steps (see theme.css: copper-200 is 1.56:1 on
    // the light surface and fails the 2:1 floor). MAX_FUNNEL_STEPS is 8, so
    // the last two stages share step 7. An invented eighth would fail either
    // the contrast floor or the adjacent-lightness gap.
    expect(rampIndex(6, 8)).toBe(RAMP_STEPS)
    expect(rampIndex(7, 8)).toBe(RAMP_STEPS)
  })

  it('never returns a step the stylesheet does not define', () => {
    for (let total = 1; total <= 8; total++) {
      for (let i = 0; i < total; i++) {
        const r = rampIndex(i, total)
        expect(r).toBeGreaterThanOrEqual(1)
        expect(r).toBeLessThanOrEqual(RAMP_STEPS)
      }
    }
  })
})

describe('ribbonPath', () => {
  it('anchors both ends to the baseline so the taper is the drop-off', () => {
    // A constant-thickness ribbon would say the loss happens AT the bar. The
    // top edge falling from one bar's top to the next's is what draws the
    // loss where it occurs.
    const d = ribbonPath(PLOT_HEIGHT, PLOT_HEIGHT / 2, 0, 1)
    expect(d).toBe(
      `M ${BAR_WIDTH + 28} 0 C ${(BAR_WIDTH + 28 + 128) / 2} 0, ${(BAR_WIDTH + 28 + 128) / 2} 90, 128 90 L 128 180 L ${BAR_WIDTH + 28} 180 Z`,
    )
  })

  it('starts where the source bar ends and lands where the next one starts', () => {
    const d = ribbonPath(100, 40, 2, 3)
    expect(d.startsWith(`M ${barX(2) + BAR_WIDTH} ${PLOT_HEIGHT - 100} `)).toBe(true)
    expect(d).toContain(`${barX(3)} ${PLOT_HEIGHT - 40}`)
  })

  it('emits no NaN for a zero-entrant funnel', () => {
    expect(ribbonPath(barHeight(0, 0), barHeight(0, 0), 0, 1)).not.toContain('NaN')
  })
})

describe('ribbonLabelY', () => {
  it('centres the label on the ribbon at its own midpoint', () => {
    // Both bars full height: the ribbon is a full-height slab, so its middle
    // is the plot's middle, less half a line box.
    expect(ribbonLabelY(PLOT_HEIGHT, PLOT_HEIGHT)).toBe(PLOT_HEIGHT / 2 - LABEL_HEIGHT / 2)
  })

  it('uses the mean of the two ends, which is exactly where the curve is', () => {
    // ribbonPath's cubic has both control points at the horizontal midpoint,
    // making its y-component a 1D Bezier with P0=P1 and P2=P3 -- so the
    // curve at the centre IS the mean. If this drifts, the label stops
    // sitting on the ribbon it names.
    const from = 180
    const to = 60
    const topAtCentre = PLOT_HEIGHT - (from + to) / 2 // 60
    const thickness = PLOT_HEIGHT - topAtCentre // 120
    expect(ribbonLabelY(from, to)).toBe(topAtCentre + thickness / 2 - LABEL_HEIGHT / 2)
  })

  it('lifts the label above a ribbon too thin to hold it', () => {
    // Two near-empty steps leave a wedge thinner than a line of text. A
    // centred label would spill over both edges and be legible against
    // neither the ribbon nor the surface.
    const y = ribbonLabelY(4, 4)
    expect(y).toBeLessThan(PLOT_HEIGHT - 4 - LABEL_HEIGHT)
    expect(y).toBeGreaterThanOrEqual(0)
  })

  it('never returns a negative offset', () => {
    // A negative top would push the label out of the plot and, in a
    // scrolling card, out of view entirely.
    expect(ribbonLabelY(PLOT_HEIGHT, PLOT_HEIGHT - 1)).toBeGreaterThanOrEqual(0)
    expect(ribbonLabelY(0, 0)).toBeGreaterThanOrEqual(0)
  })
})

describe('plotWidth', () => {
  it('is one slot per step', () => {
    expect(plotWidth(2)).toBe(200)
    expect(plotWidth(8)).toBe(800)
  })

  it('never collapses to zero for an empty step list', () => {
    // A zero-width viewBox makes the whole SVG undrawable rather than empty.
    expect(plotWidth(0)).toBeGreaterThan(0)
  })
})

describe('biggestLeak', () => {
  it('names the step that loses the largest share of the one before it', () => {
    const steps = [
      step({ index: 1, people: 100, from_previous: 1 }),
      step({ index: 2, event: 'paywall', people: 80, from_previous: 0.8 }),
      step({ index: 3, event: 'checkout', people: 20, from_previous: 0.25 }),
      step({ index: 4, event: 'purchase', people: 18, from_previous: 0.9 }),
    ]
    expect(biggestLeak(steps, 100)).toEqual({ index: 3, event: 'checkout', lost: 0.75 })
  })

  it('never names step 1, whose from_previous is 1 by construction', () => {
    // Everyone who entered reached step 1, so it cannot be the leak.
    // Including it would make a funnel that loses nobody name step 1.
    const steps = [
      step({ index: 1, people: 10, from_previous: 1 }),
      step({ index: 2, people: 10, from_previous: 1 }),
    ]
    expect(biggestLeak(steps, 10)).toBeNull()
  })

  it('says nothing when nobody entered', () => {
    const steps = [
      step({ index: 1, people: 0, from_previous: 0 }),
      step({ index: 2, people: 0, from_previous: 0 }),
    ]
    expect(biggestLeak(steps, 0)).toBeNull()
  })

  it('says nothing for a funnel with fewer than two steps', () => {
    expect(biggestLeak([step({ index: 1, people: 5 })], 5)).toBeNull()
  })

  it('picks the first of two equal leaks rather than the last', () => {
    // Deterministic output matters: an operator who reruns the same funnel
    // must not see the callout move between two equally bad steps.
    const steps = [
      step({ index: 1, people: 100, from_previous: 1 }),
      step({ index: 2, event: 'a', people: 50, from_previous: 0.5 }),
      step({ index: 3, event: 'b', people: 25, from_previous: 0.5 }),
    ]
    expect(biggestLeak(steps, 100)?.event).toBe('a')
  })
})

describe('geometry with optional steps', () => {
  const s = (event: string, people: number, optional?: true): StepResult => ({
    index: 0,
    event,
    people,
    from_previous: 1,
    from_start: 1,
    ...(optional ? { optional, skipped: 0 } : {}),
  })

  it('spans the spine ribbon across an optional slot', () => {
    // Slot 1 to slot 3, not slot 1 to slot 2. Routing the ribbon THROUGH the
    // optional step would draw a loss that did not happen, which is worse
    // than the stacked bars this plot replaced.
    const path = ribbonPath(100, 50, 1, 3)
    expect(path).toContain(`M ${barX(1) + BAR_WIDTH}`)
    expect(path).toContain(`${barX(3)}`)
  })

  it('excludes optional steps from the spine', () => {
    const steps = [s('a', 10), s('b', 8), s('c', 3, true), s('d', 5)]
    expect(spineSteps(steps).map((x) => x.event)).toEqual(['a', 'b', 'd'])
  })

  it('never names an optional step as the biggest leak', () => {
    // Its `from_previous` is measured against the step it branches off, so a
    // rarely-taken side branch would otherwise win a comparison it is not in.
    const steps = [
      { ...s('a', 100), from_previous: 1 },
      { ...s('b', 90), from_previous: 0.9 },
      { ...s('c', 5, true), from_previous: 0.05 },
      { ...s('d', 40), from_previous: 0.44 },
    ]
    // Asserted BOTH ways on purpose. `biggestLeak` filters to the spine
    // itself rather than trusting the caller to have done it, so a future
    // caller handing it the raw definition list cannot reintroduce this.
    expect(biggestLeak(steps, 100)?.event).toBe('d')
    expect(biggestLeak(spineSteps(steps), 100)?.event).toBe('d')
  })

  it('ramps colour over the spine, and hands an optional step its branch point colour', () => {
    // The ordinal ramp says "these are in an order". An off-spine step is
    // not in that order, so it borrows rather than consuming a step.
    const steps = [s('a', 10), s('b', 8), s('c', 3, true), s('d', 5)]
    const ramp = rampIndexes(steps)
    expect(ramp).toEqual([1, 2, 2, 3])
  })

  it('leaves a funnel with no optional steps ramping exactly as before', () => {
    const steps = [s('a', 10), s('b', 8), s('c', 5)]
    expect(rampIndexes(steps)).toEqual([1, 2, 3])
    expect(spineSteps(steps)).toHaveLength(3)
  })

  it('names the definition-order slot of every spine step, so a ribbon spans rather than routes', () => {
    // The pairs the ribbons are drawn between are consecutive entries HERE,
    // not consecutive definition positions. Two optional steps in a row must
    // still yield one pair, spanning both slots.
    expect(spineSlots([s('a', 10), s('b', 8), s('c', 3, true), s('d', 5)])).toEqual([0, 1, 3])
    expect(spineSlots([s('a', 10), s('b', 3, true), s('c', 2, true), s('d', 5)])).toEqual([0, 3])
    expect(spineSlots([s('a', 10), s('b', 8)])).toEqual([0, 1])
  })

  it('hangs each optional step off the last REQUIRED step before it, never off its neighbour', () => {
    // Two optional steps in a row both branch off the same required step --
    // the second does NOT branch off the first, which is the denominator
    // `levels.ts` computed its `from_previous` against.
    const steps = [s('a', 10), s('b', 8), s('c', 3, true), s('d', 2, true), s('e', 5)]
    expect(branchSlots(steps)).toEqual([null, null, 1, 1, null])
  })

  it('draws a branch connector as an open curve that cannot read as a taper', () => {
    // A tapering ribbon means "the loss happened between these two stages".
    // Nothing was lost between a required step and the branch hanging off
    // it, so the connector is a stroked line with no area at all -- no
    // baseline leg, no close.
    const d = branchPath(180, 60, 1, 2)
    expect(d.startsWith(`M ${barX(1) + BAR_WIDTH} ${PLOT_HEIGHT - 180}`)).toBe(true)
    expect(d).toContain(`${barX(2)} ${PLOT_HEIGHT - 60}`)
    expect(d).not.toContain('Z')
    expect(d).not.toContain('L')
  })

  it('emits no NaN from a branch connector on a zero-entrant funnel', () => {
    expect(branchPath(barHeight(0, 0), barHeight(0, 0), 0, 1)).not.toContain('NaN')
  })
})

describe('ribbonLabelY over a spanned slot', () => {
  it('lifts the label clear of a branch bar standing in the slot the ribbon spans', () => {
    // FOUND BY RENDERING IT. A spanning ribbon's centre is the middle of the
    // branch's own slot, so the label printed across the branch bar's dashed
    // outline with the dashes running through the glyphs.
    const from = 180
    const to = 90
    const bar = 30
    const centred = ribbonLabelY(from, to)
    const lifted = ribbonLabelY(from, to, bar)
    expect(lifted).toBeLessThan(centred)
    // Above the ribbon's own thickness at the centre, which is 135 here --
    // clearing the bar alone would still leave it inside the ribbon.
    expect(lifted).toBeLessThanOrEqual(PLOT_HEIGHT - 135 - LABEL_HEIGHT)
  })

  it('clears a branch TALLER than the ribbon it stands in, not just a short one', () => {
    // The branch can be taller than the chain at that point -- a side path
    // most people take. Lifting only above the ribbon would put the label
    // straight back on the bar.
    const lifted = ribbonLabelY(40, 20, 150)
    expect(lifted).toBeLessThanOrEqual(PLOT_HEIGHT - 150 - LABEL_HEIGHT)
    expect(lifted).toBeGreaterThanOrEqual(0)
  })

  it('never returns a negative offset for a full-height branch', () => {
    expect(ribbonLabelY(PLOT_HEIGHT, PLOT_HEIGHT, PLOT_HEIGHT)).toBeGreaterThanOrEqual(0)
  })

  it('drops the label inside the ribbon when a tall branch leaves no surface above it', () => {
    // MEASURED. Entered 200, step 1 = 200, the optional step = 195, the next
    // required step = 190. The branch stands 175.5 tall, so lifting clear of
    // it wants a NEGATIVE offset -- and clamping that at 0 put the label
    // straight back across the dashed outline it was lifted to avoid, whose
    // top edge is at 4.5. A branch taken by ~90%+ of entrants is the
    // ordinary shape for an optional step most people take, not an exotic
    // one.
    const bar = barHeight(195, 200)
    const y = ribbonLabelY(barHeight(200, 200), barHeight(190, 200), bar)
    expect(y).toBeGreaterThan(PLOT_HEIGHT - bar)
    // And still on the plot, rather than hanging off the bottom of it.
    expect(y + LABEL_HEIGHT).toBeLessThanOrEqual(PLOT_HEIGHT)
  })

  it('is unchanged when nothing is spanned, which is every ribbon on a funnel with no branches', () => {
    expect(ribbonLabelY(PLOT_HEIGHT, PLOT_HEIGHT, 0)).toBe(ribbonLabelY(PLOT_HEIGHT, PLOT_HEIGHT))
    expect(ribbonLabelY(4, 4, 0)).toBe(ribbonLabelY(4, 4))
  })
})

describe('labelColumns', () => {
  it('centres an adjacent pair across its own two slots, exactly as before', () => {
    // Every ribbon on a funnel with no optional steps is this case, and its
    // placement must not move: the midpoint of two adjacent slots IS the
    // ribbon's midpoint.
    expect(labelColumns(0, 1)).toEqual({ start: 1, span: 2 })
    expect(labelColumns(3, 4)).toEqual({ start: 4, span: 2 })
  })

  it('anchors a spanning ribbon at its ARRIVAL gap, never over the slot it passes', () => {
    // FOUND ON A REAL FUNNEL. A ribbon from step 1 to step 3 has its midpoint
    // in the middle of step 2's slot, so a centred label lands squarely on
    // the branch bar standing there and reads as that step's rate -- next to
    // the branch's own, different, percentage. Anchored at the arrival gap it
    // sits beside the bar the ribbon lands on, where nothing else is drawn.
    expect(labelColumns(0, 2)).toEqual({ start: 2, span: 2 })
  })

  it('anchors at the arrival gap however many slots are spanned', () => {
    expect(labelColumns(0, 3)).toEqual({ start: 3, span: 2 })
    expect(labelColumns(1, 4)).toEqual({ start: 4, span: 2 })
  })

  it('never overlaps the branch label that shares the branch point', () => {
    // The branch ribbon leaves the same bar and labels itself across slots
    // 1-2; the spanning ribbon must not also sit there.
    const branch = labelColumns(0, 1)
    const spine = labelColumns(0, 2)
    expect(branch.start + branch.span).toBeLessThanOrEqual(spine.start + 1)
  })
})
