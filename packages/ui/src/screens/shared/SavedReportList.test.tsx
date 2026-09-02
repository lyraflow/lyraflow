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

  it('marks a stale row, and leaves an ordinary one unmarked', () => {
    renderRows([ROW, { ...ROW, id: 4, stale: true }])
    expect(screen.getByTestId('report-stale-4')).toHaveTextContent(/cannot be read/i)
    expect(screen.queryByTestId('report-stale-3')).toBeNull()
  })

  // #213. This badge used to be `variant="secondary"` -- the low-contrast
  // grey the design system uses for metadata -- so at a glance it read like
  // the timestamp beside it rather than as a warning that the report cannot
  // be reproduced as saved. The list is where an operator decides WHICH
  // report to open, so understating it there is the one place it costs
  // something.
  //
  // A deliberate exception, not a system-wide change. #213 assumed
  // `Funnels.tsx`'s own secondary badge was the same kind of thing and that
  // moving one alone traded one inconsistency for another. It is not: that
  // badge reads "Segment filter", which is genuine metadata, and Funnels
  // expresses staleness as TEXT in its step summary ("Steps cannot be
  // read"), never as a badge. The two say different kinds of thing, so
  // secondary stays correct there and is untouched.
  //
  // Asserted on the class, which is a tripwire and not a proof -- see #217
  // for the same honest limit on the two assertions above. The real
  // verification was rendering the list and looking at it.
  it('gives the stale badge warning weight, not the grey used for metadata', () => {
    renderRows([{ ...ROW, stale: true }])
    const badge = screen.getByTestId('report-stale-3')
    expect(badge.className).toContain('bg-destructive')
    expect(badge.className).not.toContain('bg-secondary')
  })
})
