/** True when `d` falls on the same local calendar day as `now`. */
function isSameLocalDay(d: Date, now: Date): boolean {
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

/**
 * Time-only for a row from today -- the common case, and what both tables
 * showed before this fix. A row from an earlier day gets a date prefix too
 * (Important 6): time-only made a rejection from 29 days ago render
 * identically to one from a second ago, which is exactly the "ingest just
 * broke" false reading an operator with a bad deploy weeks behind them
 * would draw from a stale Rejected tab.
 *
 * `now` is a parameter, not read internally, so a test can pin it rather
 * than depending on the real clock at the instant it happens to run.
 */
/** The resolutions `GET /v1/events/stats` can bucket at. */
export type BucketInterval = '1m' | '1h' | '1d'

export function formatEventTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const time = d.toLocaleTimeString(undefined, { hour12: false })
  if (isSameLocalDay(d, now)) return time
  const date = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${date} ${time}`
}

/**
 * One bar's minute, for the sparkline's hover readout. Hour and minute
 * only: the bucket is a whole minute wide, so rendering seconds would
 * claim a precision the bar does not have. 24-hour, like
 * `formatEventTime`, so a reader comparing the readout against a row in
 * the table below is comparing two clocks written the same way.
 *
 * Unparseable input falls back to the raw string for the same reason it
 * does above -- a tooltip that says "Invalid Date" tells an operator
 * nothing about which minute it came from.
 */
export function formatBucketTime(iso: string, interval: BucketInterval = '1m'): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // NAMED AT THE RESOLUTION IT WAS BUCKETED AT. This returned `HH:MM`
  // unconditionally, which was right while the feed only ever charted sixty
  // minutes -- and once the window became a choice it meant every bar on a
  // 90-day chart read "00:00", the same string ninety times, in the readout
  // whose whole job is to say WHICH bar you are pointing at.
  if (interval === '1d') {
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  }
  if (interval === '1h') {
    return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString(
      undefined,
      { hour: '2-digit', minute: '2-digit', hour12: false },
    )}`
  }
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
}
