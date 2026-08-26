import { describe, expect, it } from 'vitest'
import type { StepResult } from '../../api/types.js'
import {
  MIN_BAR_HEIGHT,
  RAMP_STEPS,
  barHeight,
  biggestLeak,
  branchSlots,
  rampIndex,
  rampIndexes,
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
    // `BAR_SCALE` is 180 and is deliberately not exported -- the plot's own
    // height is a computed maximum now, not a constant -- so these are
    // pinned to the literal heights rather than to a shared symbol that
    // could be changed on both sides at once.
    expect(barHeight(100, 100)).toBe(280)
    expect(barHeight(50, 100)).toBe(140)
    expect(barHeight(25, 100)).toBe(70)
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

  it('names the definition-order slot of every spine step, so the chain spans rather than routes', () => {
    // The pairs the chain links run between are consecutive entries HERE,
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
})
