import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sparkline } from './Sparkline.js'

const START = new Date('2026-08-15T09:00:00.000Z')
const bucketIso = (minutesFromStart: number) =>
  new Date(START.getTime() + minutesFromStart * 60_000).toISOString()

describe('Sparkline', () => {
  // Important 7 from the whole-branch review. `GET /v1/events/stats` groups
  // by bucket with NO zero-fill -- it returns only minutes that had at
  // least one event -- so without client-side zero-fill, a gap in the
  // middle of the window is invisible: only the minutes that DID have
  // traffic ever reach this component, and they render as adjacent healthy
  // bars regardless of how much silence sits between them. This is the
  // exact scenario the finding describes: steady traffic, then an outage,
  // inside one window.
  it('zero-fills a gap in the middle of the window rather than packing bars left', () => {
    const since = bucketIso(0)
    const until = bucketIso(5)
    render(
      <Sparkline
        buckets={[
          { bucket: bucketIso(0), events: 10 },
          { bucket: bucketIso(1), events: 12 },
          // minutes 2, 3, 4 missing entirely -- the outage.
          { bucket: bucketIso(5), events: 8 },
        ]}
        since={since}
        until={until}
      />,
    )
    // 6 bars total (minutes 0..5 inclusive), not 3 -- the gap must be
    // present as zero-height bars, not simply absent.
    const bars = document.querySelectorAll('[title*="events at"]')
    expect(bars).toHaveLength(6)
    // The three gap minutes must each carry a literal "0 events" title --
    // proof they were filled, not dropped.
    const gapBars = Array.from(bars).filter((b) => b.getAttribute('title')?.startsWith('0 events'))
    expect(gapBars).toHaveLength(3)
  })

  // The other half of Important 7: the label must read the REQUESTED
  // window's width, not the count of buckets that happened to carry data --
  // otherwise "over the last 20 minutes" during a 40-minute outage inside a
  // 60-minute window reads as a SHORTER window instead of a gap inside the
  // real one.
  it('labels the chart from the requested window, not the sparse bucket count', () => {
    const since = bucketIso(0)
    const until = bucketIso(5)
    render(
      <Sparkline buckets={[{ bucket: bucketIso(0), events: 1 }]} since={since} until={until} />,
    )
    expect(screen.getByRole('img', { name: /over the last 5 minutes/i })).toBeInTheDocument()
  })

  it('falls back to the raw buckets when since/until are not yet known', () => {
    render(<Sparkline buckets={[]} />)
    expect(screen.getByText(/no data yet/i)).toBeInTheDocument()
  })
})
