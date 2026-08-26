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
    // Substring, because the peak now shares its line with the window's
    // total -- the two answer different questions ("how big did it get" and
    // "how much was there") and both are cheap to print once.
    expect(screen.getByText(/peak 7\b/)).toBeInTheDocument()
    rerender(<Sparkline buckets={[]} since={bucketIso(0)} until={bucketIso(1)} />)
    expect(screen.getByText(/peak 0\b/)).toBeInTheDocument()
  })

  it('charts a 90-day window without dying, and at day resolution', () => {
    // FOUND BY WIDENING THE RANGE IN A TEST, not by reading the code. This
    // chart assumed `1m` unconditionally, because the feed only ever asked
    // for sixty minutes -- so a 90-day window zero-filled by the minute is
    // 129,600 buckets, `Math.max(0, ...buckets)` spread that many arguments
    // onto the stack, and the whole screen died with a `RangeError` instead
    // of drawing anything. Not a rendering glitch: the Feed's own polling
    // test failed a completely unrelated assertion because of it.
    const until = new Date('2026-08-26T00:00:00.000Z')
    const since = new Date(until.getTime() - 90 * 24 * 3_600_000)
    render(
      <Sparkline
        buckets={[{ bucket: '2026-07-01T00:00:00.000Z', events: 4 }]}
        since={since.toISOString()}
        until={until.toISOString()}
        interval="1d"
      />,
    )
    const chart = screen.getByRole('img')
    // 90 days, one bucket each -- not 129,600, and not the one bucket the
    // API actually returned.
    expect(chart.getAttribute('aria-label')).toMatch(/over the last 90 days/)
    expect(chart.getAttribute('aria-label')).toMatch(/peaking at 4 in one day/)
  })

  it('names the unit it was actually asked for', () => {
    // The label read "per minute ... in one minute" whatever the window
    // was, which on a 7-day chart at hourly resolution is a false statement
    // about every number beside it.
    const until = new Date('2026-08-26T00:00:00.000Z')
    const since = new Date(until.getTime() - 6 * 3_600_000)
    render(
      <Sparkline
        buckets={[{ bucket: '2026-08-25T20:00:00.000Z', events: 2 }]}
        since={since.toISOString()}
        until={until.toISOString()}
        interval="1h"
      />,
    )
    const label = screen.getByRole('img').getAttribute('aria-label') ?? ''
    expect(label).toMatch(/per hour over the last 6 hours/)
    expect(label).not.toMatch(/minute/)
  })

  it('zero-fills on the requested interval’s own boundaries', () => {
    // The fill has to land on the same boundary `toStartOfInterval`
    // produces, or a returned bucket never finds its slot and reads as zero
    // beside a phantom bar. Six hourly slots, one of which has the data.
    const until = new Date('2026-08-26T05:30:00.000Z')
    const since = new Date('2026-08-26T00:30:00.000Z')
    render(
      <Sparkline
        buckets={[{ bucket: '2026-08-26T03:00:00.000Z', events: 9 }]}
        since={since.toISOString()}
        until={until.toISOString()}
        interval="1h"
      />,
    )
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/9 events, peaking at 9/)
  })

  it('names the unit in the VISIBLE caption, not only the accessible one', () => {
    // The bug this redesign started from. `aria-label` had been taught the
    // interval and the caption beside the chart had not, so a 90-day daily
    // chart printed "events/min" in the one place a sighted operator reads
    // -- with "peak 1,883" next to it, a per-DAY number.
    const until = new Date('2026-08-26T00:00:00.000Z')
    const since = new Date(until.getTime() - 5 * 86_400_000)
    render(
      <Sparkline
        buckets={[{ bucket: '2026-08-24T00:00:00.000Z', events: 7 }]}
        since={since.toISOString()}
        until={until.toISOString()}
        interval="1d"
      />,
    )
    expect(screen.getByText('events/day')).toBeInTheDocument()
    expect(screen.queryByText('events/min')).not.toBeInTheDocument()
  })

  it('names the hovered bucket at the resolution it was bucketed at', async () => {
    // `formatBucketTime` returned `HH:MM` unconditionally, so every bar on a
    // daily chart read "00:00" -- the same string ninety times, in the
    // readout whose entire job is to say WHICH bar you are pointing at.
    const until = new Date('2026-08-26T00:00:00.000Z')
    const since = new Date(until.getTime() - 3 * 86_400_000)
    render(
      <Sparkline
        buckets={[
          { bucket: '2026-08-24T00:00:00.000Z', events: 4 },
          { bucket: '2026-08-25T00:00:00.000Z', events: 9 },
        ]}
        since={since.toISOString()}
        until={until.toISOString()}
        interval="1d"
      />,
    )
    const columns = document.querySelectorAll('[data-bucket]')
    await userEvent.hover(columns[2] as Element)
    const readout = await screen.findByText(/9 events/)
    expect(readout.parentElement?.textContent).not.toMatch(/00:00/)
    expect(readout.parentElement?.textContent).toMatch(/Aug/)
  })

  it('marks the window’s start, middle and end under the plot', () => {
    // Ninety bars with nothing under them can say something spiked and not
    // when, and "when" is the whole question a spike raises. Taken from the
    // ZERO-FILLED series, so they are the window's own edges rather than
    // whichever buckets carried traffic -- on a sparse window those differ
    // by weeks.
    const until = new Date('2026-08-26T00:00:00.000Z')
    const since = new Date(until.getTime() - 4 * 86_400_000)
    render(
      <Sparkline
        buckets={[{ bucket: '2026-08-25T00:00:00.000Z', events: 3 }]}
        since={since.toISOString()}
        until={until.toISOString()}
        interval="1d"
      />,
    )
    // The window is 22-26 Aug; only the 25th carried traffic. All THREE
    // marks asserted -- checking the two ends alone let the middle one be
    // deleted with the suite green, found by mutation, and the middle is
    // the mark that makes the other two into a scale rather than a pair of
    // captions.
    expect(screen.getByText('Aug 22')).toBeInTheDocument()
    expect(screen.getByText('Aug 24')).toBeInTheDocument()
    expect(screen.getByText('Aug 26')).toBeInTheDocument()
  })

  it('lifts a small value clear of the floor beside a huge peak', () => {
    // THE READABILITY DEFECT, and the reason the scale is not linear. A real
    // 90-day window peaks near 1,883 events in a day against a baseline near
    // 5. Linearly the baseline is 0.3% of the peak, floors at the minimum
    // bar height, and eighty-five days of real traffic draw as one flat
    // line. This asserts the small bar is well clear of that floor -- which
    // a linear scale cannot satisfy at these numbers.
    render(
      <Sparkline
        buckets={[
          { bucket: '2026-08-24T00:00:00.000Z', events: 5 },
          { bucket: '2026-08-25T00:00:00.000Z', events: 1883 },
        ]}
      />,
    )
    const bars = document.querySelectorAll('[data-bucket] > div')
    const small = Number.parseFloat((bars[0] as HTMLElement).style.height)
    const big = Number.parseFloat((bars[1] as HTMLElement).style.height)
    expect(small).toBeGreaterThan(4)
    // ...and the spike still unmistakably dominates, which is what a
    // logarithmic scale would have cost: at these numbers log draws 1,883
    // barely three times a 5, and the one thing worth seeing stops looking
    // like an event.
    expect(big).toBeGreaterThan(small * 5)
  })

  it('still draws nothing at all for a bucket with no events', () => {
    // The scale must not lift zero off the baseline. A mark on a chart means
    // "some", and an hour of silence rendering as a dotted line of small
    // values is the false negative this screen exists to prevent.
    render(
      <Sparkline
        buckets={[
          { bucket: '2026-08-24T00:00:00.000Z', events: 0 },
          { bucket: '2026-08-25T00:00:00.000Z', events: 40 },
        ]}
      />,
    )
    const bars = document.querySelectorAll('[data-bucket] > div')
    expect(Number.parseFloat((bars[0] as HTMLElement).style.height)).toBe(0)
  })

  it('says which scale it is using, so a bar is not read as proportional', () => {
    render(
      <Sparkline
        buckets={[
          { bucket: '2026-08-24T00:00:00.000Z', events: 5 },
          { bucket: '2026-08-25T00:00:00.000Z', events: 50 },
        ]}
      />,
    )
    expect(screen.getByText(/square-root scale/i)).toBeInTheDocument()
  })
})
