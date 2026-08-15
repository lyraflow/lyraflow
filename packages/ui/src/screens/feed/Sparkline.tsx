import type { StatsBucket } from '../../api/types.js'

const CHART_HEIGHT_PX = 32
const MIN_BAR_HEIGHT_PX = 3

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
 * Events-per-minute history, above the table. Purely a glance-check --
 * "is anything moving" -- not a precise chart, so no axis, no tooltip
 * library, just bars sized against the tallest bucket in the window.
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
  const buckets = since !== undefined && until !== undefined ? zeroFill(raw, since, until) : raw
  const max = Math.max(1, ...buckets.map((b) => b.events))

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
          aria-label={`Events per minute over the last ${windowMinutes} minutes`}
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
