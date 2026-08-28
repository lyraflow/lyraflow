import { Params } from '@lyraflow/core'
import { describe, expect, it } from 'vitest'
import {
  BreakdownError,
  MAX_BREAKDOWN_ROWS,
  MAX_SERIES,
  NOT_SET,
  OTHER,
  breakdownColumns,
  breakdownExpr,
  breakdownOverflowed,
  foldSeries,
  parseBreakdown,
} from './breakdown.js'

describe('parseBreakdown', () => {
  it('keeps parsing the bare `event_name` this parameter has always taken', () => {
    // The CLI's snippet command sends exactly this. Breaking it would be a
    // silent regression in a command nobody re-reads.
    expect(parseBreakdown('event_name')).toEqual({ source: 'event_name' })
  })

  it('is absent for an absent or empty parameter, not an error', () => {
    expect(parseBreakdown(undefined)).toBeUndefined()
    expect(parseBreakdown('')).toBeUndefined()
  })

  it('reads an event column', () => {
    expect(parseBreakdown('attribute:utm_source')).toEqual({
      source: 'attribute',
      name: 'utm_source',
    })
  })

  it('reads a property key, including one that looks like a column', () => {
    // `path` exists as BOTH a column and a plausible property name. Which is
    // meant is stated by the source, never guessed -- the same rule
    // `WherePredicate` makes.
    expect(parseBreakdown('property:path')).toEqual({ source: 'property', name: 'path' })
  })

  it('refuses a column that is not on the allowlist', () => {
    // This is the guard that makes the bare interpolation in `breakdownExpr`
    // safe. It must refuse rather than pass the name through.
    expect(() => parseBreakdown('attribute:event_id')).toThrow(BreakdownError)
    expect(() => parseBreakdown('attribute:1 FROM events--')).toThrow(BreakdownError)
  })

  it('refuses an unknown source rather than guessing one', () => {
    expect(() => parseBreakdown('trait:plan')).toThrow(/source must be/)
    expect(() => parseBreakdown('nonsense')).toThrow(/event_name/)
  })

  it('refuses an empty or over-long field name', () => {
    expect(() => parseBreakdown('property:')).toThrow(BreakdownError)
    expect(() => parseBreakdown(`property:${'x'.repeat(129)}`)).toThrow(BreakdownError)
  })

  it('splits on the FIRST colon, so a key may contain one', () => {
    expect(parseBreakdown('property:utm:source')).toEqual({
      source: 'property',
      name: 'utm:source',
    })
  })
})

describe('breakdownExpr', () => {
  const expr = (raw: string) => {
    const params = new Params()
    const sql = breakdownExpr(parseBreakdown(raw) as never, params)
    return { sql, values: Object.values(params.values) }
  }

  it('groups by the column itself for event_name', () => {
    expect(expr('event_name').sql).toBe('event_name')
  })

  it('labels an empty column value rather than leaving a blank series', () => {
    const { sql } = expr('attribute:utm_source')
    expect(sql).toContain(NOT_SET)
    expect(sql).toContain('utm_source')
  })

  it('reads a property from BOTH bags, since routing is per value', () => {
    // A numeric property lives only in `properties_num`. Reading the string
    // bag alone would report every one of them as a single empty series.
    const { sql } = expr('property:seats')
    expect(sql).toContain('mapContains(properties,')
    expect(sql).toContain('mapContains(properties_num,')
    expect(sql).toContain('toString(properties_num[')
  })

  it('binds a property key rather than interpolating it', () => {
    const { sql, values } = expr("property:x') OR 1=1--")
    expect(sql).not.toContain('OR 1=1')
    expect(values).toContain("x') OR 1=1--")
  })
})

describe('breakdownColumns', () => {
  it('asks for nothing when there is no breakdown, or when it is the event name', () => {
    expect(breakdownColumns(undefined)).toEqual([])
    expect(breakdownColumns({ source: 'event_name' })).toEqual([])
  })

  it('asks for exactly the column an attribute names', () => {
    expect(breakdownColumns({ source: 'attribute', name: 'utm_source' })).toEqual(['utm_source'])
  })

  it('asks for both property maps', () => {
    expect(breakdownColumns({ source: 'property', name: 'plan' })).toEqual([
      'properties',
      'properties_num',
    ])
  })
})

describe('foldSeries', () => {
  const point = (bucket: string, series: string, events: number) => ({ bucket, series, events })

  it('leaves a set at or under the cap untouched', () => {
    const points = [point('b1', 'a', 1), point('b1', 'b', 2)]
    const out = foldSeries(points, 2)
    expect(out.folded).toBe(0)
    expect(out.points).toBe(points)
  })

  it('keeps the biggest series by TOTAL, not by its biggest single bucket', () => {
    // `spiky` has the largest single bucket (100) but the smaller total
    // (100); `steady` never wins a bucket but totals 150. Ranking by the
    // biggest bucket keeps the wrong one -- and would make a series appear
    // and disappear along the x-axis as the window moves.
    //
    // The first version of this test used 100-vs-500, where BOTH rankings
    // pick the same winner, so it passed against the defect it was written
    // for. Caught by running the mutation rather than reasoning about it.
    const out = foldSeries(
      [
        point('b1', 'spiky', 100),
        point('b1', 'steady', 50),
        point('b2', 'steady', 50),
        point('b3', 'steady', 50),
      ],
      1,
    )
    expect(out.points.filter((p) => p.series === 'steady')).toHaveLength(3)
    expect(out.points.filter((p) => p.series === 'spiky')).toHaveLength(0)
    expect(out.folded).toBe(1)
  })

  it('sums several folded series in one bucket into ONE point', () => {
    // Not several rows sharing the name `(other)`, which a chart would draw
    // stacked on top of each other.
    const out = foldSeries([point('b1', 'keep', 10), point('b1', 'x', 3), point('b1', 'y', 4)], 1)
    const other = out.points.filter((p) => p.series === OTHER)
    expect(other).toHaveLength(1)
    expect(other[0]?.events).toBe(7)
  })

  it('conserves the total, so the chart reconciles against the unbroken count', () => {
    const points = Array.from({ length: 40 }, (_, i) => point('b1', `s${i}`, i + 1))
    const before = points.reduce((n, p) => n + p.events, 0)
    const out = foldSeries(points, 5)
    expect(out.points.reduce((n, p) => n + p.events, 0)).toBe(before)
  })

  it('reports how many series were folded, so a caller can say "and N others"', () => {
    const points = Array.from({ length: 15 }, (_, i) => point('b1', `s${i}`, i + 1))
    expect(foldSeries(points, 10).folded).toBe(5)
    expect(foldSeries(points).folded).toBe(15 - MAX_SERIES)
  })

  it('breaks ties on the name, so the same data always gives the same chart', () => {
    const a = foldSeries([point('b', 'x', 5), point('b', 'y', 5), point('b', 'z', 1)], 2)
    const b = foldSeries([point('b', 'y', 5), point('b', 'z', 1), point('b', 'x', 5)], 2)
    expect(a.points.map((p) => p.series).sort()).toEqual(b.points.map((p) => p.series).sort())
  })
})

describe('breakdownOverflowed', () => {
  it('is false at exactly the cap, and true one past it', () => {
    // The query asks for cap + 1 rows so that "past the cap" is observable at
    // all -- at exactly cap rows a full result and a truncated one look the
    // same, which is the state this refusal exists to avoid being in.
    expect(breakdownOverflowed(10, 10)).toBe(false)
    expect(breakdownOverflowed(11, 10)).toBe(true)
  })

  it('defaults to the shipped ceiling', () => {
    expect(breakdownOverflowed(MAX_BREAKDOWN_ROWS)).toBe(false)
    expect(breakdownOverflowed(MAX_BREAKDOWN_ROWS + 1)).toBe(true)
  })
})
