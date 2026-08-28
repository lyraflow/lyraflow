import { render, screen, within } from '@testing-library/react'
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
})
