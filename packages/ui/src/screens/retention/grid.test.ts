import { describe, expect, it } from 'vitest'
import type { CohortRow } from '../../api/types.js'
import {
  MAX_TINT,
  MIN_TINT,
  cohortLabel,
  peakShare,
  periodLabel,
  share,
  tint,
  unmeasuredCount,
} from './grid.js'

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
    expect(tint(null, 100)).toBe(0)
  })

  it('is nothing for a measured zero, which must not look like a hit', () => {
    expect(tint(0, 100)).toBe(0)
  })

  it('fully tints the strongest cell in the grid, whatever its percentage', () => {
    // The correction. Linearly against an absolute 100%, a grid peaking at
    // 51% never got past 0.16 and most of its cells sat under 0.05 -- a table
    // with no visible shading at all, which is what a `where`-narrowed
    // retention grid looks like.
    expect(tint(100, 100)).toBe(MAX_TINT)
    expect(tint(51, 51)).toBe(MAX_TINT)
    expect(tint(3, 3)).toBe(MAX_TINT)
  })

  it('lifts the middle of the range off the floor, rather than scaling linearly', () => {
    // Square root, for the reason the feed sparkline gives for its bars.
    // Linearly, a quarter of the peak would be a quarter of the tint and
    // invisible; on this curve it is half.
    const quarter = tint(25, 100)
    expect(quarter).toBeGreaterThan(MAX_TINT * 0.4)
    expect(quarter).toBeLessThan(MAX_TINT * 0.6)
  })

  it('keeps the order, so a bigger cell is never fainter', () => {
    const steps = [1, 5, 20, 50, 80, 100].map((p) => tint(p, 100))
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i] as number).toBeGreaterThanOrEqual(steps[i - 1] as number)
    }
  })

  it('never lets a non-zero cell render as nothing', () => {
    // A cell where somebody came back must be distinguishable from one where
    // nobody did, however small it is.
    expect(tint(0.01, 100)).toBeGreaterThanOrEqual(MIN_TINT)
    expect(tint(0.01, 100)).toBeGreaterThan(tint(0, 100))
  })

  it('never reaches full strength, so the text over it stays readable', () => {
    expect(MAX_TINT).toBeLessThan(0.5)
  })

  it('is nothing when the grid has no measured cell to scale against', () => {
    expect(tint(10, 0)).toBe(0)
  })
})

describe('peakShare', () => {
  it('is the strongest measured cell across the whole grid', () => {
    expect(
      peakShare([
        { cohort: 'a', size: 10, retained: [1, 5, null] },
        { cohort: 'b', size: 4, retained: [3, 0, null] },
      ]),
    ).toBe(75)
  })

  it('ignores unmeasured cells rather than counting them as zero', () => {
    expect(peakShare([{ cohort: 'a', size: 10, retained: [null, null] }])).toBe(0)
  })

  it('is zero for an empty grid', () => {
    expect(peakShare([])).toBe(0)
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
