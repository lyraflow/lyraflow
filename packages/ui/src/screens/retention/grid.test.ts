import { describe, expect, it } from 'vitest'
import type { CohortRow } from '../../api/types.js'
import { MAX_TINT, cohortLabel, periodLabel, share, tint, unmeasuredCount } from './grid.js'

describe('share', () => {
  it('is null for an unmeasured cell, never zero', () => {
    // The distinction the whole screen rests on. Arithmetic on `null` would
    // produce 0, which renders as a cliff in the newest cohorts.
    expect(share(null, 10)).toBeNull()
  })

  it('is zero for a measured cell where nobody came back', () => {
    expect(share(0, 10)).toBe(0)
  })

  it('is a percentage of the cohort, not of the grid', () => {
    expect(share(3, 12)).toBe(25)
  })

  it('does not divide by an empty cohort', () => {
    // Unreachable through the API -- a cohort exists because somebody
    // entered it -- but `NaN%` on screen reads as a broken report rather
    // than a broken input.
    expect(share(0, 0)).toBeNull()
  })
})

describe('tint', () => {
  it('is nothing at all for an unmeasured cell', () => {
    expect(tint(null)).toBe(0)
  })

  it('never reaches full strength, so the text stays readable', () => {
    expect(tint(100)).toBe(MAX_TINT)
    expect(MAX_TINT).toBeLessThan(0.5)
  })

  it('clamps a percentage outside 0-100 rather than producing a wilder opacity', () => {
    expect(tint(140)).toBe(MAX_TINT)
    expect(tint(-5)).toBe(0)
  })
})

describe('periodLabel', () => {
  it('names period 0 rather than numbering it', () => {
    // It is the cohort's OWN period, which is the one column whose meaning
    // is not obvious from a number.
    expect(periodLabel(0, 'week')).toBe('Same week')
    expect(periodLabel(0, 'month')).toBe('Same month')
  })

  it('numbers the rest', () => {
    expect(periodLabel(3, 'week')).toBe('+3')
  })
})

describe('cohortLabel', () => {
  it('reads a UTC bucket as the day it names', () => {
    // Formatted from its parts, never through `new Date`: that would resolve
    // a bare date in the browser's zone and could show the day before.
    expect(cohortLabel('2026-06-01')).toBe('1 Jun 2026')
  })

  it('hands back anything it cannot parse, rather than rendering NaN', () => {
    expect(cohortLabel('not-a-date')).toBe('not-a-date')
  })
})

describe('unmeasuredCount', () => {
  const rows: CohortRow[] = [
    { cohort: '2026-06-01', size: 3, retained: [1, 2, null, null] },
    { cohort: '2026-06-08', size: 1, retained: [0, null, null, null] },
  ]

  it('counts the cells that could not be measured, across the grid', () => {
    expect(unmeasuredCount(rows)).toBe(5)
  })

  it('does not count a measured zero', () => {
    expect(unmeasuredCount([{ cohort: 'x', size: 2, retained: [0, 0, 0] }])).toBe(0)
  })
})
