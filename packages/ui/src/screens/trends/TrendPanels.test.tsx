import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TrendPanels } from './TrendPanels.js'
import { OTHER, toSeries } from './series.js'

const series = (points: { bucket: string; series: string; events: number }[]) => toSeries(points)

describe('TrendPanels', () => {
  it('draws one panel per series', () => {
    render(
      <TrendPanels
        series={series([
          { bucket: 'b1', series: 'pro', events: 5 },
          { bucket: 'b1', series: 'free', events: 2 },
        ])}
      />,
    )
    expect(within(screen.getByTestId('trend-panels')).getAllByRole('listitem')).toHaveLength(2)
  })

  it('says the panels share one scale, and what its peak is', () => {
    // Without that sentence a reader cannot tell whether two panels of the
    // same height mean the same number -- which is the only thing this
    // layout is for.
    render(<TrendPanels series={series([{ bucket: 'b1', series: 'a', events: 1234 }])} />)
    expect(screen.getByTestId('trend-panels')).toHaveTextContent(/same scale/i)
    expect(screen.getByTestId('trend-panels')).toHaveTextContent('1,234')
  })

  it('scales every panel against the shared peak, not its own', () => {
    // The small series must draw near the floor. If each panel scaled itself
    // both polylines would be identical, which is the defect.
    render(
      <TrendPanels
        series={series([
          { bucket: 'b1', series: 'big', events: 0 },
          { bucket: 'b2', series: 'big', events: 100 },
          { bucket: 'b1', series: 'small', events: 0 },
          { bucket: 'b2', series: 'small', events: 1 },
        ])}
      />,
    )
    const paths = screen
      .getAllByRole('img')
      .map((svg) => svg.querySelector('polyline')?.getAttribute('points'))
    expect(paths[0]).not.toBe(paths[1])
  })

  it('names each panel and gives it an accessible label with its total', () => {
    render(<TrendPanels series={series([{ bucket: 'b1', series: 'pro', events: 7 }])} />)
    expect(screen.getByRole('img', { name: /pro: 7 events/ })).toBeInTheDocument()
  })

  it('uses a brand token for the stroke rather than a hard-coded colour', () => {
    // The rule the brand system does not bend: no hex values in a component.
    render(<TrendPanels series={series([{ bucket: 'b1', series: 'a', events: 1 }])} />)
    const stroke = screen.getByRole('img').querySelector('polyline')?.getAttribute('stroke')
    expect(stroke).toBe('var(--color-primary)')
  })

  it('says so when there is nothing to chart, rather than drawing an empty grid', () => {
    render(<TrendPanels series={[]} />)
    expect(screen.getByTestId('trend-empty')).toBeInTheDocument()
    expect(screen.queryByTestId('trend-panels')).toBeNull()
  })

  it('puts (other) last', () => {
    render(
      <TrendPanels
        series={series([
          { bucket: 'b1', series: OTHER, events: 900 },
          { bucket: 'b1', series: 'chosen', events: 1 },
        ])}
      />,
    )
    const names = within(screen.getByTestId('trend-panels'))
      .getAllByRole('listitem')
      .map((li) => li.getAttribute('data-testid'))
    expect(names).toEqual(['trend-panel-chosen', `trend-panel-${OTHER}`])
  })

  it('marks every point with a dot, so a reader knows where to hover', () => {
    render(
      <TrendPanels
        series={series([
          { bucket: '2026-06-01T00:00:00.000Z', series: 'a', events: 3 },
          { bucket: '2026-06-02T00:00:00.000Z', series: 'a', events: 5 },
          { bucket: '2026-06-03T00:00:00.000Z', series: 'a', events: 1 },
        ])}
      />,
    )
    const svg = screen.getByRole('img')
    expect(svg.querySelectorAll('path')).toHaveLength(3)
  })

  it('draws the dots as round-cap zero-length paths, never as circles', () => {
    // A `<circle>` under `preserveAspectRatio="none"` renders as a wide
    // ellipse -- confirmed by rendering both at 820px.
    render(<TrendPanels series={series([{ bucket: 'b1', series: 'a', events: 1 }])} />)
    const svg = screen.getByRole('img')
    expect(svg.querySelectorAll('circle')).toHaveLength(0)
    const dot = svg.querySelector('path')
    expect(dot?.getAttribute('stroke-linecap')).toBe('round')
    expect(dot?.getAttribute('vector-effect')).toBe('non-scaling-stroke')
  })

  it('reads out the bucket AND the value on hover, not just the value', () => {
    render(
      <TrendPanels
        interval="1d"
        series={series([
          { bucket: '2026-06-01T00:00:00.000Z', series: 'a', events: 3 },
          { bucket: '2026-06-02T00:00:00.000Z', series: 'a', events: 7 },
        ])}
      />,
    )
    const svg = screen.getByRole('img')
    svg.getBoundingClientRect = () => ({ left: 0, width: 260 }) as DOMRect
    fireEvent.mouseMove(svg, { clientX: 260 })
    const readout = screen.getByTestId('trend-readout-a')
    expect(readout).toHaveTextContent('7')
    // The X value too -- a number with no time on it does not say which point
    // the pointer is over, which is the whole reason to hover.
    expect(readout.textContent).toMatch(/\d/)
    expect(readout.textContent).toContain('·')
  })

  it('shares the hovered bucket across every panel, which is the point of the layout', () => {
    render(
      <TrendPanels
        interval="1d"
        series={series([
          { bucket: '2026-06-01T00:00:00.000Z', series: 'a', events: 3 },
          { bucket: '2026-06-02T00:00:00.000Z', series: 'a', events: 7 },
          { bucket: '2026-06-01T00:00:00.000Z', series: 'b', events: 100 },
          { bucket: '2026-06-02T00:00:00.000Z', series: 'b', events: 200 },
        ])}
      />,
    )
    const first = screen.getAllByRole('img')[0] as unknown as SVGElement
    first.getBoundingClientRect = () => ({ left: 0, width: 260 }) as DOMRect
    fireEvent.mouseMove(first, { clientX: 260 })
    // Hovering ONE panel reads out the same bucket in BOTH.
    expect(screen.getByTestId('trend-readout-a')).toHaveTextContent('7')
    expect(screen.getByTestId('trend-readout-b')).toHaveTextContent('200')
  })

  it('goes back to the total when the pointer leaves', () => {
    render(
      <TrendPanels
        series={series([
          { bucket: 'b1', series: 'a', events: 3 },
          { bucket: 'b2', series: 'a', events: 7 },
        ])}
      />,
    )
    const svg = screen.getByRole('img')
    svg.getBoundingClientRect = () => ({ left: 0, width: 260 }) as DOMRect
    fireEvent.mouseMove(svg, { clientX: 260 })
    expect(screen.queryByTestId('trend-readout-a')).not.toBeNull()
    fireEvent.mouseLeave(svg)
    expect(screen.queryByTestId('trend-readout-a')).toBeNull()
  })

  it('keeps the caption text identical while hovering, so panels below do not jump', () => {
    // The readout is in each panel's own corner, so the caption's "hover to
    // read its value" sentence stays true whether or not something is
    // hovered. Dropping it on hover used to shorten the paragraph and shift
    // every panel below on a narrow tile, then shift back on mouse-leave.
    render(
      <TrendPanels
        series={series([
          { bucket: 'b1', series: 'a', events: 3 },
          { bucket: 'b2', series: 'a', events: 7 },
        ])}
      />,
    )
    const caption = screen.getByTestId('trend-panels').querySelector('p')
    const before = caption?.textContent
    const svg = screen.getByRole('img')
    svg.getBoundingClientRect = () => ({ left: 0, width: 260 }) as DOMRect
    fireEvent.mouseMove(svg, { clientX: 260 })
    expect(screen.getByTestId('trend-readout-a')).toBeInTheDocument()
    expect(caption?.textContent).toBe(before)
  })

  it('stops drawing every dot once they would merge, but still marks the hovered one', () => {
    // Sixty DISTINCT buckets. The first version of this used `i % 28`, which
    // collapses to 28 once `toSeries` groups them -- under the limit, so the
    // test passed against the branch it was written for.
    const many = Array.from({ length: 60 }, (_, i) => ({
      bucket: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(),
      series: 'a',
      events: i,
    }))
    render(<TrendPanels series={series(many)} />)
    const svg = screen.getByRole('img')
    expect(svg.querySelectorAll('path')).toHaveLength(0)
    svg.getBoundingClientRect = () => ({ left: 0, width: 260 }) as DOMRect
    fireEvent.mouseMove(svg, { clientX: 130 })
    expect(svg.querySelectorAll('path')).toHaveLength(1)
  })
})
