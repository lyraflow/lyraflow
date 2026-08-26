import { describe, expect, it } from 'vitest'
import type { FunnelStep } from './ast.js'
import { type LevelRow, summarise } from './levels.js'

const steps: FunnelStep[] = [{ event: 'a' }, { event: 'b' }, { event: 'c' }]

describe('summarise', () => {
  it('treats a level as "reached at least this step", not "stopped here"', () => {
    // 10 people got no further than step 1, 5 no further than step 2, 2 finished.
    const rows: LevelRow[] = [
      { level: 1, people: 10, partial: 0 },
      { level: 2, people: 5, partial: 0 },
      { level: 3, people: 2, partial: 0 },
    ]
    const r = summarise(rows, steps)
    expect(r.steps.map((s) => s.people)).toEqual([17, 7, 2])
    expect(r.entered).toBe(17)
    expect(r.converted).toBe(2)
  })

  it('computes both rates, and from_start is not a running product of from_previous', () => {
    const rows: LevelRow[] = [
      { level: 1, people: 10, partial: 0 },
      { level: 2, people: 5, partial: 0 },
      { level: 3, people: 5, partial: 0 },
    ]
    const r = summarise(rows, steps)
    expect(r.steps[0]?.people).toBe(20)
    expect(r.steps[0]?.from_previous).toBe(1)
    expect(r.steps[0]?.from_start).toBe(1)
    expect(r.steps[1]?.people).toBe(10)
    expect(r.steps[1]?.from_previous).toBeCloseTo(0.5)
    expect(r.steps[1]?.from_start).toBeCloseTo(0.5)
    expect(r.steps[2]?.people).toBe(5)
    expect(r.steps[2]?.from_previous).toBeCloseTo(0.5)
    expect(r.steps[2]?.from_start).toBeCloseTo(0.25)
  })

  it('reports an empty funnel as zeroes rather than NaN', () => {
    const r = summarise([], steps)
    expect(r.entered).toBe(0)
    expect(r.converted).toBe(0)
    expect(r.conversion_rate).toBe(0)
    expect(r.steps.map((s) => s.people)).toEqual([0, 0, 0])
    expect(r.steps.every((s) => Number.isFinite(s.from_previous))).toBe(true)
    expect(r.steps.every((s) => Number.isFinite(s.from_start))).toBe(true)
  })

  it('reports a fully-converting funnel as a rate of 1', () => {
    const r = summarise([{ level: 3, people: 4, partial: 0 }], steps)
    expect(r.conversion_rate).toBe(1)
    expect(r.steps.map((s) => s.people)).toEqual([4, 4, 4])
  })

  it('sums partial-window entrants across every level', () => {
    const rows: LevelRow[] = [
      { level: 1, people: 10, partial: 3 },
      { level: 3, people: 2, partial: 1 },
    ]
    expect(summarise(rows, steps).partial_window_entrants).toBe(4)
  })

  it('ignores a level beyond the step count rather than growing the output', () => {
    const rows: LevelRow[] = [
      { level: 1, people: 4, partial: 0 },
      { level: 9, people: 1, partial: 0 },
    ]
    const r = summarise(rows, steps)
    expect(r.steps).toHaveLength(3)
    expect(r.steps[2]?.people).toBe(1)
    expect(r.entered).toBe(5)
  })

  it('ignores a level of zero — matched nothing is not entered', () => {
    const rows: LevelRow[] = [
      { level: 0, people: 99, partial: 7 },
      { level: 1, people: 4, partial: 0 },
    ]
    const r = summarise(rows, steps)
    expect(r.entered).toBe(4)
    expect(r.partial_window_entrants).toBe(0)
  })

  it('carries the event name onto each step', () => {
    expect(summarise([], steps).steps.map((s) => s.event)).toEqual(['a', 'b', 'c'])
  })

  it('indexes steps from 1, matching the drop-off endpoint', () => {
    expect(summarise([], steps).steps.map((s) => s.index)).toEqual([1, 2, 3])
  })
})

describe('summarise with optional steps', () => {
  // a -> b -> [c optional] -> d.  Spine is a, b, d.
  const withOptional: FunnelStep[] = [
    { event: 'a' },
    { event: 'b' },
    { event: 'c', optional: true },
    { event: 'd' },
  ]

  it('measures conversion over the required steps only', () => {
    // Spine levels: 10 stopped at a, 6 stopped at b, 4 reached d.
    // Of those, 5 also did the optional c.
    const rows: LevelRow[] = [
      { level: 1, people: 10, partial: 0, optionalReached: [0] },
      { level: 2, people: 6, partial: 0, optionalReached: [2] },
      { level: 3, people: 4, partial: 0, optionalReached: [3] },
    ]
    const r = summarise(rows, withOptional)
    expect(r.entered).toBe(20)
    expect(r.converted).toBe(4)
    expect(r.conversion_rate).toBeCloseTo(0.2)
  })

  it('does not let the optional step shift the required steps after it', () => {
    // THE regression this guards. `d` reads spine rank 3, not definition
    // position 4. Reading by position gives it 0 and the funnel silently
    // reports nobody converting.
    const rows: LevelRow[] = [
      { level: 1, people: 10, partial: 0, optionalReached: [0] },
      { level: 2, people: 6, partial: 0, optionalReached: [2] },
      { level: 3, people: 4, partial: 0, optionalReached: [3] },
    ]
    const r = summarise(rows, withOptional)
    expect(r.steps.map((s) => s.people)).toEqual([20, 10, 5, 4])
    expect(r.steps[3]?.event).toBe('d')
    expect(r.steps[3]?.people).toBe(4)
  })

  it('rates the step after an optional one against the required step before it', () => {
    const rows: LevelRow[] = [
      { level: 1, people: 10, partial: 0, optionalReached: [0] },
      { level: 2, people: 6, partial: 0, optionalReached: [2] },
      { level: 3, people: 4, partial: 0, optionalReached: [3] },
    ]
    const r = summarise(rows, withOptional)
    // d is 4 of b's 10 -- NOT 4 of c's 5.
    expect(r.steps[3]?.from_previous).toBeCloseTo(0.4)
    expect(r.steps[3]?.from_start).toBeCloseTo(0.2)
  })

  it('rates an optional step against the required step it branches off', () => {
    const rows: LevelRow[] = [
      { level: 1, people: 10, partial: 0, optionalReached: [0] },
      { level: 2, people: 6, partial: 0, optionalReached: [2] },
      { level: 3, people: 4, partial: 0, optionalReached: [3] },
    ]
    const r = summarise(rows, withOptional)
    expect(r.steps[2]?.optional).toBe(true)
    expect(r.steps[2]?.people).toBe(5)
    expect(r.steps[2]?.from_previous).toBeCloseTo(0.5) // 5 of b's 10
    expect(r.steps[2]?.from_start).toBeCloseTo(0.25) // 5 of 20
  })

  it('reports skipped as the people at the branch point who did not do it', () => {
    const rows: LevelRow[] = [
      { level: 1, people: 10, partial: 0, optionalReached: [0] },
      { level: 2, people: 6, partial: 0, optionalReached: [2] },
      { level: 3, people: 4, partial: 0, optionalReached: [3] },
    ]
    const r = summarise(rows, withOptional)
    expect(r.steps[2]?.skipped).toBe(5) // b's 10 minus c's 5
  })

  it('leaves required steps free of the optional-only fields', () => {
    // A required step carrying `skipped: 0` would read as "nobody skipped
    // this", which is a claim about a step that cannot be skipped.
    const r = summarise([], withOptional)
    expect(r.steps[0]?.optional).toBeUndefined()
    expect(r.steps[0]?.skipped).toBeUndefined()
    expect(r.steps[3]?.skipped).toBeUndefined()
  })

  it('folds a level beyond the SPINE length into the last required step', () => {
    // The clamp is against the spine's length (3), not the definition's (4).
    const rows: LevelRow[] = [{ level: 9, people: 2, partial: 0, optionalReached: [0] }]
    const r = summarise(rows, withOptional)
    expect(r.steps).toHaveLength(4)
    expect(r.steps[3]?.people).toBe(2)
  })

  it('reports zeroes rather than NaN when nobody entered', () => {
    const r = summarise([], withOptional)
    expect(r.steps.every((s) => Number.isFinite(s.from_previous))).toBe(true)
    expect(r.steps.every((s) => Number.isFinite(s.from_start))).toBe(true)
    expect(r.steps[2]?.skipped).toBe(0)
  })

  it('treats an absent optionalReached as zero rather than NaN', () => {
    // A row from a funnel with no optional steps omits the field entirely.
    const r = summarise([{ level: 3, people: 4, partial: 0 }], withOptional)
    expect(r.steps[2]?.people).toBe(0)
    expect(Number.isFinite(r.steps[2]?.from_previous ?? Number.NaN)).toBe(true)
  })
})
