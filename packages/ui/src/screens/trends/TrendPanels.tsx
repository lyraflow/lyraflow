import { useState } from 'react'
import type { StatsQuery } from '../../api/types.js'
import { formatBucketTime } from '../feed/format.js'
import type { Series } from './series.js'
import { compactCount, dotPath, linePath, nearestIndex, pointCoords, sharedPeak } from './series.js'

const PANEL_W = 260
const PANEL_H = 56

/**
 * Above this many buckets the dots merge into the line and stop being marks.
 * Below it every point gets one; above it only the hovered point does, so
 * there is still something saying where the pointer landed.
 */
const DOT_LIMIT = 45

/**
 * Small multiples: one panel per series, all on the same scale.
 *
 * **Why not overlaid lines with a colour legend.** The brand system has one
 * hue -- a copper ramp -- and `styles/theme.css` says in as many words why a
 * set of distinct hues is wrong for the funnel's ORDINAL stages. A trend
 * breakdown is the opposite kind of data: `pro`, `free` and `(not set)` have
 * no order, so a one-hue lightness ramp on them is that same error inverted,
 * spending the only channel there is on a rank the data does not have. There
 * is no categorical palette to reach for, and inventing hex values in a
 * component is exactly what the brand rules refuse -- a new palette is a
 * brand-tooling change that has to re-run its own contrast script.
 *
 * Small multiples need no categorical palette at all. They also read better
 * at this width: ten overlaid lines is a hairball whatever colours it is
 * drawn in.
 *
 * **One shared y-scale, stated on the screen.** Per-panel scaling would make
 * a series of 3 and a series of 3,000 draw the identical shape, which is
 * precisely the comparison this layout exists to support.
 *
 * **Hovering is SHARED across panels**, which is the payoff of the layout: a
 * pointer anywhere selects the same bucket in every panel, and each one reads
 * out its own value for it. Per-panel hover would answer "what is this
 * series doing" -- a question a single chart already answers -- instead of
 * "what were all of them doing at once".
 */
export function TrendPanels(props: { series: Series[]; interval?: StatsQuery['interval'] }) {
  const { series, interval = '1d' } = props
  const peak = sharedPeak(series)
  const [hovered, setHovered] = useState<number | null>(null)

  if (series.length === 0) {
    return (
      <p data-testid="trend-empty" className="text-muted-foreground text-sm">
        No events matched, so there is nothing to chart.
      </p>
    )
  }

  const bucketCount = series[0]?.points.length ?? 0

  return (
    <div data-testid="trend-panels" className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        Every panel is drawn on the same scale, peaking at {peak.toLocaleString()} events, so their
        heights are comparable. Hover a point to read its value.
      </p>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {series.map((s) => {
          const coords = pointCoords(s.points, peak, PANEL_W, PANEL_H)
          const at = hovered === null ? null : s.points[hovered]
          return (
            <li
              key={s.name}
              data-testid={`trend-panel-${s.name}`}
              className="flex flex-col gap-1 rounded-md border border-input p-3"
            >
              <div className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="truncate font-medium text-sm" title={s.name}>
                  {s.name}
                </span>
                {/* The readout replaces the total while hovering rather than
                 * sitting beside it: two numbers in a panel corner, one of
                 * which changes with the pointer, is a pair a reader has to
                 * work out. `formatBucketTime` is the feed's, so the same
                 * bucket reads the same way on both screens. */}
                {at ? (
                  <span
                    data-testid={`trend-readout-${s.name}`}
                    className="shrink-0 tabular-nums text-foreground text-xs"
                  >
                    {formatBucketTime(at.bucket, interval)} · {at.events.toLocaleString()}
                  </span>
                ) : (
                  <span className="shrink-0 tabular-nums text-muted-foreground text-xs">
                    {compactCount(s.total)}
                  </span>
                )}
              </div>
              <svg
                viewBox={`0 0 ${PANEL_W} ${PANEL_H}`}
                className="h-14 w-full"
                preserveAspectRatio="none"
                role="img"
                aria-label={`${s.name}: ${s.total} events`}
                onMouseLeave={() => setHovered(null)}
                onMouseMove={(e) => {
                  const box = e.currentTarget.getBoundingClientRect()
                  if (box.width === 0) return
                  setHovered(nearestIndex((e.clientX - box.left) / box.width, bucketCount, PANEL_W))
                }}
              >
                <polyline
                  points={linePath(s.points, peak, PANEL_W, PANEL_H)}
                  fill="none"
                  stroke="var(--color-primary)"
                  strokeWidth={1.5}
                  // Non-scaling, or `preserveAspectRatio="none"` would stretch
                  // the stroke with the box and draw a fat line on a wide
                  // panel and a hairline on a narrow one.
                  vectorEffect="non-scaling-stroke"
                  strokeLinejoin="round"
                />
                {coords.map((c, i) => {
                  const isHovered = i === hovered
                  if (!isHovered && coords.length > DOT_LIMIT) return null
                  return (
                    <path
                      // Keyed by the bucket, which is unique per series and
                      // stable across re-renders, rather than by index.
                      key={s.points[i]?.bucket ?? i}
                      d={dotPath(c)}
                      stroke="var(--color-primary)"
                      strokeWidth={isHovered ? 8 : 4.5}
                      strokeLinecap="round"
                      // A `<circle>` here would render as a wide ellipse --
                      // see `dotPath`, and the render that showed it.
                      vectorEffect="non-scaling-stroke"
                    />
                  )
                })}
              </svg>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
