import type { Series } from './series.js'
import { compactCount, linePath, sharedPeak } from './series.js'

const PANEL_W = 260
const PANEL_H = 56

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
 */
export function TrendPanels(props: { series: Series[] }) {
  const { series } = props
  const peak = sharedPeak(series)

  if (series.length === 0) {
    return (
      <p data-testid="trend-empty" className="text-muted-foreground text-sm">
        No events matched, so there is nothing to chart.
      </p>
    )
  }

  return (
    <div data-testid="trend-panels" className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        Every panel is drawn on the same scale, peaking at {peak.toLocaleString()} events, so their
        heights are comparable.
      </p>
      <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {series.map((s) => (
          <li
            key={s.name}
            data-testid={`trend-panel-${s.name}`}
            className="flex flex-col gap-1 rounded-md border border-input p-3"
          >
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <span className="truncate font-medium text-sm" title={s.name}>
                {s.name}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground text-xs">
                {compactCount(s.total)}
              </span>
            </div>
            <svg
              viewBox={`0 0 ${PANEL_W} ${PANEL_H}`}
              // Scales with the panel; the viewBox keeps the geometry fixed.
              className="h-14 w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label={`${s.name}: ${s.total} events`}
            >
              <polyline
                points={linePath(s.points, peak, PANEL_W, PANEL_H)}
                fill="none"
                stroke="var(--color-primary)"
                strokeWidth={1.5}
                // Non-scaling, or `preserveAspectRatio="none"` would stretch
                // the stroke with the box and draw a fat line on a wide panel
                // and a hairline on a narrow one.
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </svg>
          </li>
        ))}
      </ul>
    </div>
  )
}
