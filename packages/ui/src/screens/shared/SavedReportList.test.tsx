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

  /**
   * WHAT THE NEXT TWO TESTS DO AND DO NOT COVER (#217).
   *
   * They assert class names. **That is a regression tripwire, not a proof of
   * layout**, and the distinction is worth stating because the names make
   * them sound like proofs. Each pins a real defect a screenshot found and no
   * query in this file could see -- a name that ran out of its own card, and
   * a link that read as prose -- but what they verify is that a string is
   * still in an attribute, not that anything wraps or is distinguishable.
   *
   * Specifically, they cannot see:
   *
   *   - a Tailwind upgrade renaming the utility, which passes here and
   *     silently drops the behaviour;
   *   - the surrounding layout changing so that wrapping no longer prevents
   *     the overflow it was added for;
   *   - whether the link's colour actually contrasts against the card.
   *
   * They CAN now see one thing the original pair could not, which was #217's
   * sharpest point: a second class arriving that neutralises the first.
   * `break-words` is inert next to `whitespace-nowrap`, `truncate` or a fixed
   * width, so the negative assertions below name every utility in this
   * codebase that would defeat it. That closes the "another rule neutralised
   * the wrapping" hole without pretending to measure anything.
   *
   * A real check needs a browser -- jsdom performs no layout, so
   * `scrollWidth` and `getComputedStyle` are useless here. The existing
   * Playwright suite is not the place: `playwright.config.ts` states it
   * exists to prove the built assets, static serving, cookie and API work
   * together, "not to cover behaviour", and it drives a full app on :3000.
   * A component-screenshot harness is the missing piece, and it is
   * infrastructure rather than a test -- left to #217 to decide rather than
   * bolted on here.
   *
   * The real verification for both fixes was a rendered screenshot at 390px.
   */

  /** Every utility in this codebase that makes `break-words` inert. */
  const WRAP_DEFEATING = ['whitespace-nowrap', 'truncate', 'text-nowrap', 'overflow-hidden']

  it('keeps a long report name wrapping, with nothing that would defeat it', () => {
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
    // `min-w-0` is half the fix and was never asserted: inside a flex row a
    // child will not shrink below its content without it, so the wrapping
    // class alone does not stop the overflow.
    expect(label.className).toContain('min-w-0')
    for (const defeat of WRAP_DEFEATING) {
      expect(label.className).not.toContain(defeat)
    }
  })

  it('renders "Create one" as a link and not as the last two words of the message', () => {
    renderRows([])
    const link = screen.getByRole('link', { name: /create one/i })
    // Distinguishable from the prose around it, and reachable -- the second
    // is real behaviour rather than a class string, so it is asserted as
    // behaviour.
    expect(link.className).toContain('text-primary')
    expect(link).toHaveAttribute('href', '/reports/new')
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
