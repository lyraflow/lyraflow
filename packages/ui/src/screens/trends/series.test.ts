import { describe, expect, it } from 'vitest'
import type { TrendPoint } from '../../api/types.js'
import {
  INSET,
  OTHER,
  compactCount,
  dotPath,
  linePath,
  nearestIndex,
  pointCoords,
  sharedPeak,
  toSeries,
} from './series.js'

const p = (bucket: string, series: string, events: number): TrendPoint => ({
  bucket,
  series,
  events,
})

describe('toSeries', () => {
  it('zero-fills a bucket a series is missing from', () => {
    // The one thing a trend line must not do is join the two sides of a gap:
    // a series that stopped for a week would otherwise draw a straight line
    // across it, which reads as steady traffic.
    const out = toSeries([p('b1', 'a', 5), p('b2', 'b', 3), p('b3', 'a', 1)])
    const a = out.find((s) => s.name === 'a')
    expect(a?.points.map((x) => x.events)).toEqual([5, 0, 1])
  })

  it('gives every series the same buckets, in the same order', () => {
    const out = toSeries([p('b2', 'a', 1), p('b1', 'b', 1)])
    const buckets = out.map((s) => s.points.map((x) => x.bucket))
    expect(buckets[0]).toEqual(['b1', 'b2'])
    expect(buckets[1]).toEqual(buckets[0])
  })

  it('sorts by total, descending', () => {
    const out = toSeries([p('b1', 'small', 1), p('b1', 'big', 9)])
    expect(out.map((s) => s.name)).toEqual(['big', 'small'])
  })

  it('puts (other) last however big it is', () => {
    // It is not a series anybody chose; at the top it pushes the ones they
    // did choose down the page.
    const out = toSeries([p('b1', OTHER, 900), p('b1', 'chosen', 1)])
    expect(out.map((s) => s.name)).toEqual(['chosen', OTHER])
  })

  it('carries each series total', () => {
    const out = toSeries([p('b1', 'a', 2), p('b2', 'a', 3)])
    expect(out[0]?.total).toBe(5)
  })

  it('handles an ungrouped response, where every point has no series', () => {
    const out = toSeries([
      { bucket: 'b1', events: 4 },
      { bucket: 'b2', events: 6 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.total).toBe(10)
  })
})

describe('sharedPeak', () => {
  it('is the maximum across ALL series, not per series', () => {
    // A per-panel scale makes a series of 3 and a series of 3000 draw the
    // identical shape -- the exact comparison small multiples exist for.
    const out = sharedPeak(toSeries([p('b1', 'a', 3), p('b1', 'b', 3000)]))
    expect(out).toBe(3000)
  })

  it('is zero for nothing at all, rather than -Infinity', () => {
    expect(sharedPeak([])).toBe(0)
  })
})

describe('linePath', () => {
  it('puts the peak at the top and a zero on the floor', () => {
    const path = linePath([{ events: 0 }, { events: 10 }], 10, 100, 50)
    expect(path).toBe('6.00,50.00 94.00,0.00')
  })

  it('insets the end points, so their dots are not drawn half outside the box', () => {
    // Found by rendering the panel at 820px and looking at it: flush against
    // 0 and `width`, the first and last dots came out as half-dots.
    const coords = pointCoords([{ events: 1 }, { events: 1 }], 1, 100, 50)
    expect(coords[0]?.x).toBe(INSET)
    expect(coords[1]?.x).toBe(100 - INSET)
  })

  it('spreads points evenly between the insets', () => {
    const xs = pointCoords([{ events: 1 }, { events: 1 }, { events: 1 }], 1, 100, 50).map(
      (c) => c.x,
    )
    expect(xs).toEqual([INSET, 50, 100 - INSET])
  })

  it('draws a single bucket as a flat line, not a dot in an empty box', () => {
    const path = linePath([{ events: 5 }], 10, 100, 50)
    expect(path.split(' ')).toHaveLength(2)
  })

  it('draws a flat floor when every value is zero, rather than dividing by it', () => {
    const path = linePath([{ events: 0 }, { events: 0 }], 0, 100, 50)
    expect(path).not.toContain('NaN')
    expect(path).toBe('6.00,50.00 94.00,50.00')
  })

  it('is empty for no points at all', () => {
    expect(linePath([], 10, 100, 50)).toBe('')
  })
})

describe('dotPath', () => {
  it('is a ZERO-LENGTH path, which is what makes a round cap render as a dot', () => {
    // Not a `<circle>`: the panel uses `preserveAspectRatio="none"`, so a
    // circle is stretched into a wide ellipse. Rendered side by side at
    // 820px, the circles came out roughly three times wider than tall.
    const d = dotPath({ x: 12, y: 34 })
    expect(d).toBe('M12.00,34.00 L12.00,34.00')
    const [, from, to] = d.match(/^M(.+) L(.+)$/) ?? []
    expect(from).toBe(to)
  })
})

describe('nearestIndex', () => {
  it('picks the first point at the left edge and the last at the right', () => {
    expect(nearestIndex(0, 5, 260)).toBe(0)
    expect(nearestIndex(1, 5, 260)).toBe(4)
  })

  it('picks the middle point in the middle', () => {
    expect(nearestIndex(0.5, 5, 260)).toBe(2)
  })

  it('clamps rather than returning an index off the end', () => {
    // Reachable: the pointer can sit inside the inset at either edge.
    expect(nearestIndex(-0.2, 5, 260)).toBe(0)
    expect(nearestIndex(1.4, 5, 260)).toBe(4)
  })

  it('is the only point when there is one, and nothing when there are none', () => {
    expect(nearestIndex(0.7, 1, 260)).toBe(0)
    expect(nearestIndex(0.7, 0, 260)).toBeNull()
  })
})

describe('compactCount', () => {
  it('is exact below a thousand, because 4 and 7 are a real difference', () => {
    expect(compactCount(0)).toBe('0')
    expect(compactCount(999)).toBe('999')
  })

  it('shortens above that', () => {
    expect(compactCount(1000)).toBe('1k')
    expect(compactCount(1500)).toBe('1.5k')
    expect(compactCount(12_400)).toBe('12k')
    expect(compactCount(1_500_000)).toBe('1.5M')
  })
})
