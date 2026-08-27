import { describe, expect, it } from 'vitest'
import { describeWindow } from './duration.js'

describe('describeWindow', () => {
  it('uses the largest unit that divides exactly', () => {
    expect(describeWindow(604_800)).toBe('7-day')
    expect(describeWindow(86_400)).toBe('1-day')
    expect(describeWindow(7_200)).toBe('2-hour')
    expect(describeWindow(1_800)).toBe('30-minute')
  })

  it('keeps seconds when no larger unit divides exactly', () => {
    // Never rounds. A window is a number an operator typed with a unit beside
    // it, and describing 90 seconds as "1-minute" would name a shorter window
    // than the funnel actually used.
    expect(describeWindow(90)).toBe('90-second')
    expect(describeWindow(1)).toBe('1-second')
  })

  it('does not dress up a value that is not a duration', () => {
    // The route reads this off a stored definition. A zero or a negative is a
    // defect somewhere upstream, and a phrase that hides it is worse than one
    // that looks odd.
    expect(describeWindow(0)).toBe('0-second')
    expect(describeWindow(-60)).toBe('-60-second')
    expect(describeWindow(Number.NaN)).toBe('NaN-second')
  })
})
