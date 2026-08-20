import { useState } from 'react'
import type { StatsBucket } from '../../api/types.js'
import { formatBucketTime } from './format.js'

const CHART_HEIGHT_PX = 56
const MIN_BAR_HEIGHT_PX = 2

/** Matches the `interval: '1m'` Feed always requests for this chart. */
const BUCKET_MS = 60_000

/**
 * Fills every minute between `since` and `until` with a zero bucket when
 * the API omitted it. `GET /v1/events/stats` groups by bucket with NO
 * zero-fill of its own -- it returns only minutes that had at least one
 * event -- so without this, a 40-minute outage inside a 60-minute window is
 * invisible: the 20 minutes that DID have traffic render as 20 healthy
 * adjacent bars packed to the left, indistinguishable from steady traffic
 * across the whole hour (Important 7 -- the exact false negative this
 * screen exists to prevent). `since`/`until` are floored to the same
 * bucket boundary ClickHouse's own `toStartOfInterval` produces, so a
 * returned bucket's ISO string always finds its slot in the map.
 */
function zeroFill(buckets: StatsBucket[], since: string, until: string): StatsBucket[] {
  const byBucket = new Map(buckets.map((b) => [b.bucket, b.events]))
  const start = Math.floor(new Date(since).getTime() / BUCKET_MS) * BUCKET_MS
  const end = Math.floor(new Date(until).getTime() / BUCKET_MS) * BUCKET_MS
  const out: StatsBucket[] = []
  for (let t = start; t <= end; t += BUCKET_MS) {
    const iso = new Date(t).toISOString()
    out.push({ bucket: iso, events: byBucket.get(iso) ?? 0 })
  }
  return out
}

/**
 * Where the hover readout sits over the chart. It is anchored to the
 * centre of the hovered column and would hang off either end of the card
 * at the edges of the window, so the two outermost tenths anchor by their
 * near edge instead -- the readout still points at its own bar, it just
 * grows inward rather than outward.
 */
function readoutTransform(centrePercent: number): string {
  if (centrePercent < 10) return 'translateX(0)'
  if (centrePercent > 90) return 'translateX(-100%)'
  return 'translateX(-50%)'
}

/**
 * Events-per-minute history, above the table. Still a glance-check -- "is
 * anything moving" -- with no axis and no charting dependency, but the
 * bars now divide the full width of the card between them rather than
 * being fixed at 6px each: at a 60-minute window on a desktop viewport
 * that left the chart occupying about a third of its container, with the
 * rest of the card empty, which reads as "the window ended early" rather
 * than "these are the minutes".
 *
 * Hovering a column names the value, since "is anything moving" turns into
 * "how much, and when" the moment the answer is yes. The hit area is the
 * column's full height, not the bar: a one-event bar is 2px tall and
 * cannot be pointed at.
 *
 * `since`/`until` are the window the stats poll actually requested
 * (`Feed.tsx`'s `STATS_WINDOW_MINUTES`), passed through so this component
 * can zero-fill against the window's TRUE edges rather than whatever
 * buckets happened to come back. Optional only because the first render,
 * before any poll has resolved, has neither -- that state falls back to
 * the raw (empty) `buckets` array, which correctly shows "No data yet".
 */
export function Sparkline(props: { buckets: StatsBucket[]; since?: string; until?: string }) {
  const { buckets: raw, since, until } = props
  const [hovered, setHovered] = useState<number | null>(null)
  const buckets = since !== undefined && until !== undefined ? zeroFill(raw, since, until) : raw

  // The tallest bucket actually observed, which is what the peak label
  // reports; `scale` floors it at 1 only so a window of pure zeros cannot
  // divide by zero. Reporting `scale` as the peak would print "peak 1"
  // over an hour of silence.
  const peak = Math.max(0, ...buckets.map((b) => b.events))
  const scale = Math.max(1, peak)
  const total = buckets.reduce((sum, b) => sum + b.events, 0)

  /**
   * A bar chart's entire value is showing shape across at least two
   * points. Below two points there is no trend to draw, so say that in
   * words instead of drawing a chart that implies more was measured than
   * was.
   */
  const hasTrend = buckets.length >= 2

  // Derived from the requested window's own width, not from how many of
  // its buckets happened to carry data (Important 7) -- after zero-fill
  // `buckets.length` already equals the window's bucket count regardless
  // of how sparse the traffic was, so the label reads "over the last 60
  // minutes" identically through an outage and through steady traffic.
  const windowMinutes =
    since !== undefined && until !== undefined
      ? Math.round((new Date(until).getTime() - new Date(since).getTime()) / BUCKET_MS)
      : buckets.length

  const active = hovered != null ? buckets[hovered] : undefined
  // Percent across the chart of the hovered column's centre -- the readout
  // anchors to this rather than to the pointer, so it names one bar
  // unambiguously instead of drifting between two.
  const activeCentre = hovered != null ? ((hovered + 0.5) / buckets.length) * 100 : 0

  return (
    <div className="flex items-stretch gap-4 rounded-lg border border-border bg-card px-4 py-3">
      {!hasTrend ? (
        <div
          className="flex flex-1 items-center text-sm text-muted-foreground"
          style={{ height: CHART_HEIGHT_PX }}
        >
          {buckets.length === 0 ? 'No data yet' : 'Not enough events yet to chart a trend'}
        </div>
      ) : (
        <div className="relative min-w-0 flex-1">
          {/* Anchored to the hovered column and drawn over the chart's own
           * top edge, so it never displaces the bars underneath it --
           * moving the pointer along the row must not reflow the thing
           * being pointed at. `pointer-events-none` for the same reason:
           * the readout sits between the pointer and the columns at the
           * top of a tall bar, and would otherwise take the hover it is
           * describing and flicker. */}
          {active !== undefined && (
            <div
              className="pointer-events-none absolute bottom-full z-20 mb-1.5 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-xs shadow-md"
              style={{ left: `${activeCentre}%`, transform: readoutTransform(activeCentre) }}
            >
              <span className="font-medium text-foreground">
                {active.events.toLocaleString()} {active.events === 1 ? 'event' : 'events'}
              </span>
              <span className="text-muted-foreground"> · {formatBucketTime(active.bucket)}</span>
            </div>
          )}
          {/* The baseline is the container's own bottom border rather than
           * a 3px stub under every empty minute: a stub is a mark on the
           * chart, and a mark on a chart means "some", so an hour of
           * silence used to render as a dotted line of small values. A
           * zero minute now draws nothing above the line, and the line
           * still shows the window is continuous. */}
          <div
            className="flex items-end gap-px border-border border-b"
            style={{ height: CHART_HEIGHT_PX }}
            role="img"
            aria-label={`Events per minute over the last ${windowMinutes} minutes: ${total.toLocaleString()} events, peaking at ${peak.toLocaleString()} in one minute`}
            onMouseLeave={() => setHovered(null)}
          >
            {buckets.map((bucket, index) => {
              const heightPx =
                bucket.events === 0
                  ? 0
                  : Math.max(
                      MIN_BAR_HEIGHT_PX,
                      Math.round((bucket.events / scale) * CHART_HEIGHT_PX),
                    )
              const dimmed = hovered != null && hovered !== index
              // buckets are a fixed-order time series from the API on every
              // poll, never reordered or filtered client-side, so position is
              // stable and there is no content-derived id to prefer over it.
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: see comment above
                  key={index}
                  data-bucket={bucket.bucket}
                  data-events={bucket.events}
                  className="flex h-full min-w-px flex-1 cursor-default items-end"
                  onMouseEnter={() => setHovered(index)}
                >
                  <div
                    className={`w-full rounded-t-xs transition-colors ${dimmed ? 'bg-primary/30' : 'bg-primary'}`}
                    style={{ height: heightPx }}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}
      <div className="flex shrink-0 flex-col justify-center text-right text-sm">
        <span className="text-muted-foreground">events/min</span>
        {/* The peak names what the tallest bar is worth. Without it the
         * bars are only shaped relative to each other, so one event in an
         * otherwise silent hour draws exactly the same chart as a
         * thousand. */}
        {hasTrend && (
          <span className="text-muted-foreground text-xs">peak {peak.toLocaleString()}</span>
        )}
      </div>
    </div>
  )
}
