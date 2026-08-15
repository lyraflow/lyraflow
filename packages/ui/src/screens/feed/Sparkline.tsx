import type { StatsBucket } from '../../api/types.js'

const CHART_HEIGHT_PX = 32
const MIN_BAR_HEIGHT_PX = 3

/**
 * Events-per-minute history, above the table. Purely a glance-check --
 * "is anything moving" -- not a precise chart, so no axis, no tooltip
 * library, just bars sized against the tallest bucket in the window.
 */
export function Sparkline(props: { buckets: StatsBucket[] }) {
  const { buckets } = props
  const max = Math.max(1, ...buckets.map((b) => b.events))

  /**
   * A bar chart's entire value is showing shape across at least two
   * points. Buckets come back sparse -- the server only returns minutes
   * that had at least one event (`GROUP BY bucket` with no zero-fill) --
   * so one bucket is not "quiet", it is a single fact with nothing to
   * compare it to: one thin bar sitting alone in an otherwise-empty row
   * reads as a broken widget, not as "not much has happened". Below two
   * points there is no trend to draw, so say that in words instead of
   * drawing a chart that implies more was measured than was.
   */
  const hasTrend = buckets.length >= 2

  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
      {!hasTrend ? (
        <div
          className="flex h-8 flex-1 items-center text-sm text-muted-foreground"
          style={{ height: CHART_HEIGHT_PX }}
        >
          {buckets.length === 0 ? 'No data yet' : 'Not enough events yet to chart a trend'}
        </div>
      ) : (
        <div
          className="flex flex-1 items-end gap-0.5"
          style={{ height: CHART_HEIGHT_PX }}
          role="img"
          aria-label={`Events per minute over the last ${buckets.length} minutes`}
        >
          {buckets.map((bucket, index) => {
            const heightPx = Math.max(
              MIN_BAR_HEIGHT_PX,
              Math.round((bucket.events / max) * CHART_HEIGHT_PX),
            )
            // buckets are a fixed-order time series from the API on every
            // poll, never reordered or filtered client-side, so position is
            // stable and there is no content-derived id to prefer over it.
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: see comment above
                key={index}
                className="w-1.5 shrink-0 rounded-sm bg-primary"
                style={{ height: heightPx }}
                title={`${bucket.events} events at ${bucket.bucket}`}
              />
            )
          })}
        </div>
      )}
      <span className="shrink-0 text-sm text-muted-foreground">events/min</span>
    </div>
  )
}
