import { useState } from 'react'
import type { StatsBucket } from '../../api/types.js'
import { formatBucketTime } from './format.js'

/** Tall enough that a bar has somewhere to go. At 56 -- what this was --
 * ninety days of a quiet baseline against one spike drew as a featureless
 * strip with a hook on the end. */
const CHART_HEIGHT_PX = 96
const MIN_BAR_HEIGHT_PX = 2

/**
 * Bar heights are on a SQUARE-ROOT scale, and the chart says so in words.
 *
 * A linear scale is the honest default and it stops working at this shape.
 * A real 90-day window here peaks at 1,883 events in a day against a
 * baseline near 5: linearly the baseline is 0.3% of the peak, floors at the
 * minimum bar height, and eighty-five days of real traffic render as one
 * flat line. The chart answers "is anything moving", and it was answering it
 * with a shrug.
 *
 * Square root rather than logarithmic, and that was chosen by rendering all
 * three. Log makes the baseline fully readable and costs too much for it: at
 * these numbers a 1,883-event spike draws barely three times a 5-event day,
 * so the one thing an operator opened the screen to see stops looking like
 * an event at all. Square root keeps the spike unmistakably dominant while
 * lifting the baseline off the floor.
 *
 * Zero is still exactly zero and order is still preserved, so nothing the
 * chart claims becomes false -- but a bar is no longer proportional to its
 * count, which is why the caption states the scale rather than leaving the
 * reader to assume the usual one. The exact number is on the hover readout
 * and the peak is on the header.
 */
function barFraction(events: number, peak: number): number {
  if (events <= 0 || peak <= 0) return 0
  return Math.sqrt(events) / Math.sqrt(peak)
}

/**
 * How wide one bucket is, per resolution the stats route can return.
 *
 * This chart used to assume `1m` and nothing else, because the feed always
 * asked for sixty minutes at minute resolution. Once the range became a
 * choice that assumption became a crash: a 90-day window zero-filled by the
 * minute is 129,600 buckets, `Math.max(0, ...buckets)` spread that many
 * arguments onto the stack, and the screen died with a `RangeError` rather
 * than drawing anything. Found by widening the range in a test, not by
 * reading the code.
 */
const BUCKET_MS_BY_INTERVAL = {
  '1m': 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  // No feed range asks for this one today -- the widest is 90 days at `1d`.
  // It is here because `FeedRange.interval` is derived from the ENDPOINT's
  // interval set (`StatsQuery['interval']`), so the moment the server learned
  // `1w` for trends this map became the narrower of the two, and the gap is a
  // compile error rather than something anyone would notice at review. Adding
  // the width keeps the two in step; the alternative is redeclaring the feed's
  // own narrower union and letting them drift instead.
  '1w': 7 * 24 * 60 * 60_000,
} as const

export type SparklineInterval = keyof typeof BUCKET_MS_BY_INTERVAL

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
function zeroFill(
  buckets: StatsBucket[],
  since: string,
  until: string,
  bucketMs: number,
): StatsBucket[] {
  const byBucket = new Map(buckets.map((b) => [b.bucket, b.events]))
  const start = Math.floor(new Date(since).getTime() / bucketMs) * bucketMs
  const end = Math.floor(new Date(until).getTime() / bucketMs) * bucketMs
  const out: StatsBucket[] = []
  for (let t = start; t <= end; t += bucketMs) {
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
export function Sparkline(props: {
  buckets: StatsBucket[]
  since?: string
  until?: string
  /** The resolution the buckets were requested at. Defaults to `1m`, which
   * is what this chart assumed unconditionally before the feed's range
   * became a choice. */
  interval?: SparklineInterval
}) {
  const { buckets: raw, since, until, interval = '1m' } = props
  const bucketMs = BUCKET_MS_BY_INTERVAL[interval]
  const unit = interval === '1m' ? 'minute' : interval === '1h' ? 'hour' : 'day'
  const unitShort = interval === '1m' ? 'min' : unit
  const [hovered, setHovered] = useState<number | null>(null)
  const buckets =
    since !== undefined && until !== undefined ? zeroFill(raw, since, until, bucketMs) : raw

  // The tallest bucket actually observed, which is what the peak label
  // reports; `scale` floors it at 1 only so a window of pure zeros cannot
  // divide by zero. Reporting `scale` as the peak would print "peak 1"
  // over an hour of silence.
  // `reduce`, never `Math.max(0, ...buckets)`: a spread passes one argument
  // per bucket and overflows the stack once there are enough of them, which
  // is how the 90-day window crashed the screen.
  //
  // BELT AND BRACES, and worth saying so plainly -- putting the spread back
  // does NOT reproduce that crash and no test here fails for it. What fixes
  // it is `interval`, which keeps the bucket count near a hundred instead of
  // near a hundred thousand. Read this line as the guard and you might
  // "simplify" the interval plumbing away, which is the change that actually
  // breaks.
  const peak = buckets.reduce((m, b) => (b.events > m ? b.events : m), 0)
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
  const windowUnits =
    since !== undefined && until !== undefined
      ? Math.round((new Date(until).getTime() - new Date(since).getTime()) / bucketMs)
      : buckets.length

  /** First, middle and last bucket -- the marks under the plot. Taken from
   * the ZERO-FILLED series, so they are the window's own edges rather than
   * whichever buckets happened to carry traffic; on a sparse window the two
   * differ by weeks. */
  const edges: [string, string, string] =
    buckets.length > 0
      ? [
          (buckets[0] as StatsBucket).bucket,
          (buckets[Math.floor((buckets.length - 1) / 2)] as StatsBucket).bucket,
          (buckets[buckets.length - 1] as StatsBucket).bucket,
        ]
      : ['', '', '']

  const active = hovered != null ? buckets[hovered] : undefined
  // Percent across the chart of the hovered column's centre -- the readout
  // anchors to this rather than to the pointer, so it names one bar
  // unambiguously instead of drifting between two.
  const activeCentre = hovered != null ? ((hovered + 0.5) / buckets.length) * 100 : 0

  return (
    /* A COLUMN, not a row. The unit and the peak used to sit in a fixed
     * block down the right-hand side, which on a wide card spent a couple
     * of hundred pixels of chart width on two short strings -- and chart
     * width is bars. Above the plot they cost one line and give it back. */
    <div className="flex min-w-0 flex-col rounded-lg border border-border bg-card px-4 py-3">
      <div className="mb-2.5 flex items-baseline justify-between gap-4">
        <span className="font-medium text-foreground text-xs">events/{unitShort}</span>
        {hasTrend && (
          /* The peak names what the tallest bar is worth. Without it the
           * bars are only shaped relative to each other, so one event in an
           * otherwise silent hour draws exactly the same chart as a
           * thousand -- and under a square-root scale that is truer still,
           * because height is no longer proportional to count. */
          <span className="tabular-nums text-muted-foreground text-xs">
            peak {peak.toLocaleString()} · {total.toLocaleString()} total
          </span>
        )}
      </div>
      {!hasTrend ? (
        <div
          className="flex items-center text-muted-foreground text-sm"
          style={{ height: CHART_HEIGHT_PX }}
        >
          {buckets.length === 0 ? 'No data yet' : 'Not enough events yet to chart a trend'}
        </div>
      ) : (
        <div className="relative min-w-0">
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
              <span className="text-muted-foreground">
                {' '}
                · {formatBucketTime(active.bucket, interval)}
              </span>
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
            aria-label={`Events per ${unit} over the last ${windowUnits} ${unit}s: ${total.toLocaleString()} events, peaking at ${peak.toLocaleString()} in one ${unit}`}
            onMouseLeave={() => setHovered(null)}
          >
            {buckets.map((bucket, index) => {
              const heightPx =
                bucket.events === 0
                  ? 0
                  : Math.max(
                      MIN_BAR_HEIGHT_PX,
                      Math.round(barFraction(bucket.events, scale) * CHART_HEIGHT_PX),
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
                    className={`w-full rounded-t-[2px] transition-colors ${dimmed ? 'bg-primary/30' : 'bg-primary'}`}
                    style={{ height: heightPx }}
                  />
                </div>
              )
            })}
          </div>
          {/* WHEN, in three marks. Ninety bars with nothing under them can
           * show that something spiked and not when -- and "when" is the
           * whole question an operator brings to a spike. Three rather than
           * one per bar: a tick under every column is unreadable at this
           * density, and the ends plus the middle are enough to place
           * anything by eye. */}
          <div
            className="mt-1.5 flex justify-between tabular-nums text-[11px] text-muted-foreground"
            aria-hidden="true"
          >
            <span>{formatBucketTime(edges[0], interval)}</span>
            <span>{formatBucketTime(edges[1], interval)}</span>
            <span>{formatBucketTime(edges[2], interval)}</span>
          </div>
          {/* The scale, said plainly. A bar is not proportional to its count
           * and a reader is entitled to assume it is unless told. */}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Heights use a square-root scale, so a quiet {unit} stays visible beside a spike.
          </p>
        </div>
      )}
    </div>
  )
}
