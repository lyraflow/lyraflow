import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { SavedReportList } from './SavedReportList.js'
import type { SavedReportRow } from './SavedReportList.js'

const ROW: SavedReportRow = {
  id: 3,
  name: 'Signups by day',
  summary: 'signup · daily · by country',
  updatedAt: '2026-08-27T00:00:00.000Z',
}

function renderRows(
  rows: SavedReportRow[] | null,
  overrides: Partial<{ loadFailed: boolean }> = {},
) {
  render(
    <MemoryRouter>
      <SavedReportList
        rows={rows}
        loadFailed={overrides.loadFailed ?? false}
        hrefFor={(id) => `/reports/${id}`}
        newHref="/reports/new"
        emptyMessage="Nothing saved here yet."
      />
    </MemoryRouter>,
  )
}

describe('SavedReportList', () => {
  it('renders nothing while still loading', () => {
    render(
      <MemoryRouter>
        <SavedReportList
          rows={null}
          loadFailed={false}
          hrefFor={(id) => `/reports/${id}`}
          newHref="/reports/new"
          emptyMessage="Nothing saved here yet."
        />
      </MemoryRouter>,
    )
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/nothing saved here yet/i)).toBeNull()
  })

  it('links each row to hrefFor(id) and shows its summary', () => {
    renderRows([ROW])
    const link = screen.getByRole('link', { name: /Signups by day/ })
    expect(link).toHaveAttribute('href', '/reports/3')
    expect(screen.getByText('signup · daily · by country')).toBeInTheDocument()
  })

  it('shows the empty message and a way to create one, only when rows is an empty array', () => {
    renderRows([])
    expect(screen.getByText(/nothing saved here yet/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /create one/i })).toHaveAttribute(
      'href',
      '/reports/new',
    )
    expect(screen.queryByRole('list')).toBeNull()
  })

  // Both of these pin what a screenshot showed and no behavioural test
  // could: a class name is invisible to every query in this file, so the
  // list rendered "correctly" for a name that in fact ran out of its own
  // card, and offered a link that looked like prose.
  it('wraps a long report name with break-words, not break-all', () => {
    // A report name is typed by an operator and frequently has no spaces.
    // Unwrapped, this one overflowed the row by ~180px at 390px wide and
    // put the whole list into horizontal scroll. `break-all` would fix the
    // overflow too and is the wrong tool -- it splits ordinary names
    // mid-word even when they would fit.
    const name = 'checkout_funnel_weekly_breakdown_by_utm_source_and_plan_tier_v2'
    renderRows([{ ...ROW, name }])
    const label = screen.getByText(name)
    expect(label.className).toContain('break-words')
    expect(label.className).not.toContain('break-all')
  })

  it('renders "Create one" as a link and not as the last two words of the message', () => {
    renderRows([])
    expect(screen.getByRole('link', { name: /create one/i }).className).toContain('text-primary')
  })

  it('distinguishes a failed load from an empty list', () => {
    renderRows([], { loadFailed: true })
    expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i)
    expect(screen.queryByText(/nothing saved here yet/i)).toBeNull()
  })

  // No Delete control on a row -- it moved to the detail screen a row's
  // link opens (`Trends`/`Retention`), the same place `FunnelDetail` and
  // `SegmentDetail` already put it. This pins the negative: a row is a
  // link and nothing else.
  it('renders no button at all -- a row is a link, not an action', () => {
    renderRows([ROW])
    expect(screen.queryByRole('button')).toBeNull()
  })
})
