import { describe, expect, it } from 'vitest'
import { formatBucketTime, formatEventTime } from './format.js'

// Important 6 from the whole-branch review, second half: both tables
// rendered time-only (`toLocaleTimeString`), no date, so a rejection from
// 29 days ago was visually identical to one from a second ago -- exactly
// the false "ingest just broke" reading an operator with a bad deploy weeks
// behind them would draw from a stale Rejected tab.
describe('formatEventTime', () => {
  const now = new Date('2026-08-15T12:00:00.000Z')

  it('shows time only for a row from today', () => {
    const out = formatEventTime('2026-08-15T09:14:02.000Z', now)
    expect(out).not.toMatch(/Aug|15|2026/)
  })

  it('includes a date for a row from an earlier day', () => {
    const out = formatEventTime('2026-07-17T09:14:02.000Z', now)
    expect(out).toMatch(/Jul/)
  })

  it('returns the raw string for an unparseable timestamp', () => {
    expect(formatEventTime('not-a-date', now)).toBe('not-a-date')
  })
})

describe('formatBucketTime', () => {
  // Hour and minute only. The bucket is a whole minute wide, so seconds in
  // the sparkline's hover readout would claim a precision the bar does not
  // have -- and 24-hour, matching `formatEventTime`, so a reader comparing
  // the readout against a row in the table below is comparing two clocks
  // written the same way.
  it('renders hour and minute, without seconds', () => {
    const out = formatBucketTime('2026-08-15T09:14:00.000Z')
    expect(out).toMatch(/^\d{2}:\d{2}$/)
  })

  it('returns the raw string for an unparseable timestamp', () => {
    expect(formatBucketTime('not-a-date')).toBe('not-a-date')
  })
})
