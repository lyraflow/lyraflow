import type { TrendPoint } from '../../api/types.js'

/** One series, with its points in bucket order and its total over the window. */
export interface Series {
  name: string
  total: number
  points: { bucket: string; events: number }[]
}

/** The label the API gives the folded tail. Matched, not re-derived. */
export const OTHER = '(other)'

/**
 * Groups flat `(bucket, series, events)` points into one entry per series,
 * every one carrying a value for EVERY bucket in the window.
 *
 * Zero-filling is the part that matters. A series with no events in a bucket
 * simply has no row, and a line drawn through the rows that exist joins the
 * two sides of the gap -- so a series that stopped for a week renders as a
 * straight line across it, which is the one thing a trend chart must not do.
 *
 * Sorted by total, descending, with `(other)` forced last however big it is:
 * it is not a series anybody chose, and letting it sit at the top pushes the
 * ones they did choose down the page.
 */
export function toSeries(points: TrendPoint[]): Series[] {
  const buckets = [...new Set(points.map((p) => p.bucket))].sort()
  const byName = new Map<string, Map<string, number>>()

  for (const p of points) {
    const name = p.series ?? ''
    let slot = byName.get(name)
    if (!slot) {
      slot = new Map()
      byName.set(name, slot)
    }
    slot.set(p.bucket, (slot.get(p.bucket) ?? 0) + p.events)
  }

  const out: Series[] = [...byName.entries()].map(([name, slot]) => ({
    name,
    total: [...slot.values()].reduce((a, b) => a + b, 0),
    points: buckets.map((bucket) => ({ bucket, events: slot.get(bucket) ?? 0 })),
  }))

  return out.sort((a, b) => {
    if (a.name === OTHER) return 1
    if (b.name === OTHER) return -1
    return b.total - a.total || (a.name < b.name ? -1 : 1)
  })
}

/**
 * The peak across EVERY series, which is what all the panels share.
 *
 * A per-panel scale is the mistake small multiples exist to avoid: it makes a
 * series of 3 and a series of 3,000 draw the identical shape, so the
 * comparison the layout promises is exactly the one it cannot support.
 */
export function sharedPeak(series: Series[]): number {
  let peak = 0
  for (const s of series) for (const p of s.points) if (p.events > peak) peak = p.events
  return peak
}

/**
 * An SVG polyline for one series, in a `width` by `height` box.
 *
 * LINEAR, deliberately, and unlike the Feed's sparkline -- which is
 * square-root scaled because it answers "is anything moving" for one series
 * and needs a quiet baseline lifted off the floor. These panels answer "which
 * of these is bigger", and a non-linear scale would draw a series twice
 * another's size at 1.4 times its height. The two charts want opposite things
 * from their scale, which is why this is a second component rather than a
 * mode on that one.
 *
 * A single bucket renders as a flat line across the panel rather than a dot:
 * one point is not a trend, and a dot in the middle of an empty box reads as
 * a rendering failure.
 */
export function linePath(
  points: { events: number }[],
  peak: number,
  width: number,
  height: number,
): string {
  if (points.length === 0) return ''
  const y = (events: number) => (peak <= 0 ? height : height - (events / peak) * height)
  if (points.length === 1) {
    const only = y(points[0]?.events ?? 0)
    return `0,${only} ${width},${only}`
  }
  const step = width / (points.length - 1)
  return points.map((p, i) => `${(i * step).toFixed(2)},${y(p.events).toFixed(2)}`).join(' ')
}

/**
 * A count, shortened once it stops fitting in a panel's corner.
 *
 * Whole numbers below 1000 are exact, because a trend of 4 versus 7 is a real
 * difference and both fit. Above that the magnitude is what the reader is
 * comparing, and the exact figure is in the row beside it.
 */
export function compactCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const k = n / 1000
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`
  }
  const m = n / 1_000_000
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}M`
}
