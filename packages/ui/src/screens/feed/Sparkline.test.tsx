import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
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
    // 6 columns total (minutes 0..5 inclusive), not 3 -- the gap must be
    // present as zero-valued columns, not simply absent.
    const bars = document.querySelectorAll('[data-bucket]')
    expect(bars).toHaveLength(6)
    // The three gap minutes must each carry a literal 0 -- proof they were
    // filled, not dropped.
    const gapBars = Array.from(bars).filter((b) => b.getAttribute('data-events') === '0')
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

  // The chart used to draw a fixed 6px bar per minute inside a flex-1
  // container, so a 60-minute window occupied about a third of a desktop
  // card and left the rest blank -- which reads as "the window ended
  // early", not as "these are the minutes". Every column now takes an
  // equal share of the width instead, so the chart is as wide as the
  // window it describes.
  it('divides the full width between the columns rather than fixing a bar width', () => {
    render(
      <Sparkline
        buckets={[{ bucket: bucketIso(0), events: 4 }]}
        since={bucketIso(0)}
        until={bucketIso(3)}
      />,
    )
    for (const column of document.querySelectorAll('[data-bucket]')) {
      expect(column.className).toContain('flex-1')
    }
  })

  // A zero minute drawing a 3px stub is a mark on a chart, and a mark on a
  // chart means "some": an hour of silence rendered as a dotted line of
  // small values, which is the same false negative zero-fill exists to
  // prevent, one layer down. Zero now draws nothing above the baseline.
  it('draws no bar at all for a minute with no events', () => {
    render(
      <Sparkline
        buckets={[{ bucket: bucketIso(0), events: 10 }]}
        since={bucketIso(0)}
        until={bucketIso(1)}
      />,
    )
    const columns = document.querySelectorAll('[data-bucket]')
    const empty = columns[1]?.firstElementChild as HTMLElement
    expect(empty.style.height).toBe('0px')
    const filled = columns[0]?.firstElementChild as HTMLElement
    expect(Number.parseInt(filled.style.height, 10)).toBeGreaterThan(0)
  })

  it('names the value and the minute when a column is hovered', async () => {
    render(
      <Sparkline
        buckets={[
          { bucket: bucketIso(0), events: 10 },
          { bucket: bucketIso(1), events: 3 },
        ]}
        since={bucketIso(0)}
        until={bucketIso(1)}
      />,
    )
    expect(screen.queryByText(/3 events/)).not.toBeInTheDocument()
    const columns = document.querySelectorAll('[data-bucket]')
    await userEvent.hover(columns[1] as HTMLElement)
    expect(screen.getByText('3 events')).toBeInTheDocument()
    // Not "10 events" as well: the readout describes the column under the
    // pointer, not the chart.
    expect(screen.queryByText('10 events')).not.toBeInTheDocument()
  })

  it('says one event, not one events', async () => {
    render(
      <Sparkline
        buckets={[{ bucket: bucketIso(0), events: 1 }]}
        since={bucketIso(0)}
        until={bucketIso(1)}
      />,
    )
    await userEvent.hover(document.querySelectorAll('[data-bucket]')[0] as HTMLElement)
    expect(screen.getByText('1 event')).toBeInTheDocument()
  })

  // Bars are only shaped relative to each other, so one event in an
  // otherwise silent hour draws exactly the chart a thousand would. The
  // peak is what tells those two apart -- and it reports the tallest
  // bucket actually seen, not the floor of 1 the height scale uses to
  // avoid dividing by zero.
  it('reports the peak, and reports zero rather than the scale floor', () => {
    const { rerender } = render(
      <Sparkline
        buckets={[
          { bucket: bucketIso(0), events: 7 },
          { bucket: bucketIso(1), events: 2 },
        ]}
        since={bucketIso(0)}
        until={bucketIso(1)}
      />,
    )
    expect(screen.getByText('peak 7')).toBeInTheDocument()
    rerender(<Sparkline buckets={[]} since={bucketIso(0)} until={bucketIso(1)} />)
    expect(screen.getByText('peak 0')).toBeInTheDocument()
  })
})
