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
