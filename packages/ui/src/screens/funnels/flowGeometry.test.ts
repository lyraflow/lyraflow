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
  plotWidth,
  rampIndex,
  ribbonLabelY,
  ribbonPath,
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
    const d = ribbonPath(PLOT_HEIGHT, PLOT_HEIGHT / 2, 0)
    expect(d).toBe(
      `M ${BAR_WIDTH + 28} 0 C ${(BAR_WIDTH + 28 + 128) / 2} 0, ${(BAR_WIDTH + 28 + 128) / 2} 90, 128 90 L 128 180 L ${BAR_WIDTH + 28} 180 Z`,
    )
  })

  it('starts where the source bar ends and lands where the next one starts', () => {
    const d = ribbonPath(100, 40, 2)
    expect(d.startsWith(`M ${barX(2) + BAR_WIDTH} ${PLOT_HEIGHT - 100} `)).toBe(true)
    expect(d).toContain(`${barX(3)} ${PLOT_HEIGHT - 40}`)
  })

  it('emits no NaN for a zero-entrant funnel', () => {
    expect(ribbonPath(barHeight(0, 0), barHeight(0, 0), 0)).not.toContain('NaN')
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
