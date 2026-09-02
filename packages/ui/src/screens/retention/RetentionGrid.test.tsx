import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { RetentionResult } from '../../api/types.js'
import { RetentionGrid } from './RetentionGrid.js'
import { MAX_TINT, MIN_TINT } from './grid.js'

const result = (over: Partial<RetentionResult> = {}): RetentionResult => ({
  granularity: 'week',
  periods: 3,
  cohorts: [
    { cohort: '2026-06-01', size: 4, retained: [4, 2, 1, null] },
    { cohort: '2026-06-08', size: 2, retained: [0, null, null, null] },
  ],
  start_event: 'signed_up',
  return_event: 'project_created',
  since: '2026-06-01T00:00:00.000Z',
  until: '2026-06-15T00:00:00.000Z',
  computed_at: '2026-06-20T00:00:00.000Z',
  warnings: [],
  ...over,
})

const rows = () => within(screen.getByTestId('retention-grid')).getAllByRole('row').slice(1)

/** The opacity of the tint layer behind one cell, or 0 when there is none. */
const tintOf = (row: number, cell: number): number => {
  const td = within(rows()[row] as HTMLElement).getAllByRole('cell')[cell]
  const layer = td?.querySelector('div')
  return layer ? Number(layer.style.opacity || 0) : 0
}

describe('RetentionGrid', () => {
  it('renders an unmeasured cell as a dash, never as 0%', () => {
    render(<RetentionGrid result={result()} />)
    const second = rows()[1] as HTMLElement
    const cells = within(second).getAllByRole('cell')
    // size, then periods 0..3. Period 0 is a real zero; the rest are dashes.
    expect(cells[1]).toHaveTextContent('0%')
    expect(cells[2]).toHaveTextContent('—')
    expect(cells[2]).not.toHaveTextContent('0%')
  })

  it('distinguishes a measured zero from an unmeasured cell', () => {
    // The pair that matters. If these ever render the same, the screen is
    // reporting "not yet" as "nobody came back".
    render(<RetentionGrid result={result()} />)
    const second = within(rows()[1] as HTMLElement).getAllByRole('cell')
    expect(second[1]?.textContent).not.toBe(second[2]?.textContent)
  })

  it('shows the percentage of the cohort, with the count beside it', () => {
    render(<RetentionGrid result={result()} />)
    const first = within(rows()[0] as HTMLElement).getAllByRole('cell')
    expect(first[2]).toHaveTextContent('50%')
    expect(first[2]).toHaveTextContent('(2)')
  })

  it('names period 0 rather than numbering it', () => {
    render(<RetentionGrid result={result()} />)
    expect(screen.getByRole('columnheader', { name: 'Same week' })).toBeInTheDocument()
  })

  it('says so when there are no cohorts, instead of drawing an empty table', () => {
    render(<RetentionGrid result={result({ cohorts: [] })} />)
    expect(screen.getByTestId('retention-empty')).toHaveTextContent(/signed_up/)
    expect(screen.queryByTestId('retention-grid')).toBeNull()
  })

  it('gives one column per period plus the cohort and size columns', () => {
    render(<RetentionGrid result={result()} />)
    expect(screen.getAllByRole('columnheader')).toHaveLength(2 + 4)
  })

  it('shades the strongest cell fully, even when it is nowhere near 100%', () => {
    // The bug: shading was linear against an absolute 100%, so a grid
    // narrowed by `where` predicates -- peaking around 51%, with most cells
    // under 15% -- rendered with no visible colour at all. Reported as "you
    // removed the gradient".
    render(
      <RetentionGrid
        result={result({
          cohorts: [
            { cohort: '2026-06-01', size: 100, retained: [51, 7, 0, null] },
            { cohort: '2026-06-08', size: 100, retained: [14, 0, null, null] },
          ],
        })}
      />,
    )
    expect(tintOf(0, 1)).toBeCloseTo(MAX_TINT, 5)
  })

  it('keeps a small cell visible rather than letting it fade to nothing', () => {
    render(
      <RetentionGrid
        result={result({
          cohorts: [{ cohort: '2026-06-01', size: 100, retained: [51, 7, 0, null] }],
        })}
      />,
    )
    const small = tintOf(0, 2)
    expect(small).toBeGreaterThanOrEqual(MIN_TINT)
    // ...and still clearly weaker than the strongest, or the shading says
    // nothing.
    expect(small).toBeLessThan(MAX_TINT * 0.8)
  })

  it('leaves a measured zero unshaded, so it cannot read as a small hit', () => {
    render(
      <RetentionGrid
        result={result({
          cohorts: [{ cohort: '2026-06-01', size: 100, retained: [51, 7, 0, null] }],
        })}
      />,
    )
    expect(tintOf(0, 3)).toBe(0)
  })

  // #215. `overflow-x-auto` means the grid DOES scroll -- 26 periods is
  // wider than a laptop by design -- but nothing said so. At 390px it was
  // cut off mid-column with no fade, no shadow and no scrollbar until the
  // reader happened to drag, so a table that continues looked like a table
  // that had been truncated.
  //
  // jsdom does no layout, so every scroll metric on the container is 0 and
  // an honest measurement is impossible here. These tests DEFINE the three
  // metrics the component reads and then fire a scroll, which is what lets
  // the decision be tested at all. What they cannot test is that the
  // gradient is visible -- that was checked in a browser at 390px.
  describe('the sideways-scroll affordance', () => {
    function scroller(): HTMLElement {
      return screen.getByTestId('retention-grid-scroller')
    }

    /** jsdom leaves scrollWidth/clientWidth/scrollLeft at 0 and read-only. */
    function setMetrics(
      el: HTMLElement,
      m: { scrollWidth: number; clientWidth: number; scrollLeft: number },
    ) {
      for (const [key, value] of Object.entries(m)) {
        Object.defineProperty(el, key, { value, configurable: true })
      }
      fireEvent.scroll(el)
    }

    it('marks the grid as continuing when it is wider than its container', () => {
      render(<RetentionGrid result={result()} />)
      setMetrics(scroller(), { scrollWidth: 900, clientWidth: 390, scrollLeft: 0 })
      expect(screen.getByTestId('retention-grid-more')).toBeInTheDocument()
    })

    it('stops marking it once the last column is in view', () => {
      render(<RetentionGrid result={result()} />)
      const el = scroller()
      setMetrics(el, { scrollWidth: 900, clientWidth: 390, scrollLeft: 0 })
      expect(screen.getByTestId('retention-grid-more')).toBeInTheDocument()
      setMetrics(el, { scrollWidth: 900, clientWidth: 390, scrollLeft: 510 })
      expect(screen.queryByTestId('retention-grid-more')).toBeNull()
    })

    it('marks nothing when the whole grid already fits', () => {
      render(<RetentionGrid result={result()} />)
      setMetrics(scroller(), { scrollWidth: 390, clientWidth: 390, scrollLeft: 0 })
      expect(screen.queryByTestId('retention-grid-more')).toBeNull()
    })

    // A fractional layout width leaves scrollLeft + clientWidth a hair under
    // scrollWidth at the true end. Without slack the affordance would pin on
    // forever at exactly the position it exists to say nothing about, which
    // is worse than not having it -- it would always claim there is more.
    it('treats a sub-pixel remainder at the end as the end', () => {
      render(<RetentionGrid result={result()} />)
      setMetrics(scroller(), { scrollWidth: 900.4, clientWidth: 390, scrollLeft: 510 })
      expect(screen.queryByTestId('retention-grid-more')).toBeNull()
    })

    it('is hidden from assistive technology -- it is decoration, not content', () => {
      render(<RetentionGrid result={result()} />)
      setMetrics(scroller(), { scrollWidth: 900, clientWidth: 390, scrollLeft: 0 })
      expect(screen.getByTestId('retention-grid-more')).toHaveAttribute('aria-hidden', 'true')
    })
  })

  it('says the shading is relative, and to what', () => {
    // Colour no longer means an absolute rate, so a reader comparing shades
    // across two grids would be wrong. The percentages are what compare.
    render(
      <RetentionGrid
        result={result({
          cohorts: [{ cohort: '2026-06-01', size: 100, retained: [51, 7, 0, null] }],
        })}
      />,
    )
    expect(screen.getByTestId('retention-scale')).toHaveTextContent('51%')
    expect(screen.getByTestId('retention-scale')).toHaveTextContent(/not comparable/i)
  })
})
