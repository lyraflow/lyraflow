import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { MemberRow } from '../../api/types.js'
import type { MemberPage } from './MemberList.js'
import { MemberList } from './MemberList.js'

function page(n: number, offset = 0): MemberRow[] {
  return Array.from({ length: n }, (_, i) => ({
    person_id: `person-${offset + i}`,
    first_seen: '2026-08-01T00:00:00.000Z',
    last_seen: '2026-08-10T00:00:00.000Z',
  }))
}

/** A `fetchPage` that always answers with the same page, regardless of the
 * cursor it is called with -- fine for a test that only ever fetches once. */
function renderMembers(response: MemberPage) {
  const fetchPage = vi.fn(async () => response)
  render(<MemberList fetchPage={fetchPage} />)
  return fetchPage
}

describe('MemberList', () => {
  it('fetches nothing until "Show people" is clicked', () => {
    const fetchPage = vi.fn(async () => ({
      members: page(1),
      next_cursor: null,
      window_exhausted: false,
      person_count: 10_000,
    }))
    render(<MemberList fetchPage={fetchPage} />)
    expect(screen.getByRole('button', { name: /show people/i })).toBeInTheDocument()
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('clicking "Show people" fetches the first page (no cursor) and renders rows', async () => {
    const fetchPage = renderMembers({
      members: page(2),
      next_cursor: null,
      window_exhausted: false,
      person_count: 10_000,
    })
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    expect(await screen.findByText('person-0')).toBeInTheDocument()
    expect(screen.getByText('person-1')).toBeInTheDocument()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(fetchPage).toHaveBeenCalledWith(undefined)
  })

  it('says the population is exhausted when the walk ends naturally', async () => {
    renderMembers({
      members: page(3),
      next_cursor: null,
      window_exhausted: false,
      person_count: 10_000,
    })
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    const end = await screen.findByTestId('member-list-end')
    expect(end).toHaveAttribute('data-end', 'exhausted')
    expect(end).toHaveTextContent(/that is everyone/i)
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  // --- the three endings ------------------------------------------------
  //
  // `window_exhausted: true` used to be rendered as "More people match than
  // this preview can show", full stop. The server raises that flag once the
  // walk has spent its page budget, INDEPENDENTLY of whether the last page
  // it served was full -- so every population that ended on a short final
  // page (a segment of 937, whose tenth page carries 37 rows) was told it
  // had been truncated when it had been shown in full. That is the same
  // conflation as reporting a truncated preview as "everyone", pointing the
  // other way. The three tests below are the three endings; the middle one
  // is the defect.
  //
  // The fixtures walk two pages rather than answering in one, because the
  // component learns the server's page size from the walk (see `endingFor`)
  // and a one-page walk has nothing to measure a short page against.

  it('says everyone was shown when the budget is spent on a SHORT final page', async () => {
    const fetchPage: Mock = vi
      .fn()
      .mockResolvedValueOnce({
        members: page(100),
        next_cursor: 'cursor-1',
        window_exhausted: false,
        person_count: 10_000,
      })
      .mockResolvedValueOnce({
        members: page(37, 100),
        next_cursor: null,
        window_exhausted: true,
        person_count: 10_000,
      })
    render(<MemberList fetchPage={fetchPage} />)

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    await userEvent.click(await screen.findByRole('button', { name: /load more/i }))

    const end = await screen.findByTestId('member-list-end')
    expect(end).toHaveAttribute('data-end', 'window-short')
    expect(end).toHaveTextContent(/that is everyone/i)
    // The claim that was false: this population was shown in full.
    expect(end).not.toHaveTextContent(/more people match/i)
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  it('claims neither everyone nor more when the budget is spent on a FULL final page, and says how many were shown', async () => {
    const fetchPage: Mock = vi
      .fn()
      .mockResolvedValueOnce({
        members: page(100),
        next_cursor: 'cursor-1',
        window_exhausted: false,
        person_count: 10_000,
      })
      .mockResolvedValueOnce({
        members: page(100, 100),
        next_cursor: null,
        window_exhausted: true,
        person_count: 10_000,
      })
    render(<MemberList fetchPage={fetchPage} />)

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    await userEvent.click(await screen.findByRole('button', { name: /load more/i }))

    const end = await screen.findByTestId('member-list-end')
    expect(end).toHaveAttribute('data-end', 'window-full')
    // Genuinely ambiguous: the population may be exactly 200 or far larger.
    // So the copy states the 200 it showed and asserts neither.
    expect(end).toHaveTextContent('200')
    expect(end).not.toHaveTextContent(/that is everyone/i)
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  // The multi-page mirror of the two single-page cases below, and the only
  // test that can tell "the whole walk" from "this page". Every other ending
  // fixture here is one page long, where those two are the same number -- so
  // comparing `page.members.length` against the count instead of the running
  // total passes all of them. It was written as a mutation and slipped
  // through until this existed.
  //
  // Two pages of 100 against a population of 200: everyone matching has been
  // shown, even though the final page alone is nowhere near 200.
  it('counts the whole walk, not the final page, when deciding it showed everyone', async () => {
    const fetchPage: Mock = vi
      .fn()
      .mockResolvedValueOnce({
        members: page(100),
        next_cursor: 'cursor-1',
        window_exhausted: false,
        person_count: 200,
      })
      .mockResolvedValueOnce({
        members: page(100, 100),
        next_cursor: null,
        window_exhausted: true,
        person_count: 200,
      })
    render(<MemberList fetchPage={fetchPage} />)

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    await userEvent.click(await screen.findByRole('button', { name: /load more/i }))

    const end = await screen.findByTestId('member-list-end')
    expect(end).toHaveAttribute('data-end', 'window-short')
    expect(end).toHaveTextContent(/that is everyone/i)
  })

  // UPDATED WITH #120, and the change is the point. This asserted
  // `window-full` -- the ambiguous ending -- because the old code measured
  // "short" against the widest page the walk had served, and a single short
  // page is its own widest, so nothing revealed the server's page size.
  // Falling to the ending that claims nothing was the right call while the
  // page size was unreachable.
  //
  // It is reachable now, and 37 < MEMBER_PAGE_SIZE, so this is simply a short
  // final page: the population ran out before the budget did, which is
  // `window-short` and genuinely IS everyone. The old expectation was a
  // limitation being pinned, not a behaviour worth keeping.
  it('a short flagged page is recognised as short against the real page size', async () => {
    renderMembers({
      members: page(37),
      next_cursor: null,
      window_exhausted: true,
      person_count: 37,
    })
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    const end = await screen.findByTestId('member-list-end')
    expect(end).toHaveAttribute('data-end', 'window-short')
    expect(end).toHaveTextContent(/that is everyone/i)
  })

  // The ambiguous ending, and the whole reason #120 exists: a FULL final page
  // at the window ceiling. The response's own count is what settles it, and
  // these two differ in nothing else.
  it('a full final page whose count matches what was shown says that is everyone', async () => {
    renderMembers({
      members: page(100),
      next_cursor: null,
      window_exhausted: true,
      person_count: 100,
    })
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    const end = await screen.findByTestId('member-list-end')
    expect(end).toHaveAttribute('data-end', 'window-short')
    expect(end).toHaveTextContent(/that is everyone/i)
  })

  it('a full final page whose count exceeds what was shown still claims neither', async () => {
    renderMembers({
      members: page(100),
      next_cursor: null,
      window_exhausted: true,
      person_count: 101,
    })
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    const end = await screen.findByTestId('member-list-end')
    expect(end).toHaveAttribute('data-end', 'window-full')
    expect(end).toHaveTextContent('100')
    expect(end).not.toHaveTextContent(/that is everyone/i)
  })

  it('offers "Load more" when the walk is neither exhausted nor budget-spent, and sends next_cursor', async () => {
    const fetchPage: Mock = vi
      .fn()
      .mockResolvedValueOnce({
        members: page(100),
        next_cursor: 'cursor-1',
        window_exhausted: false,
        person_count: 10_000,
      })
      .mockResolvedValueOnce({
        members: page(50, 100),
        next_cursor: null,
        window_exhausted: false,
        person_count: 10_000,
      })
    render(<MemberList fetchPage={fetchPage} />)

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    const loadMore = await screen.findByRole('button', { name: /load more/i })
    // A live population, not exhausted yet: neither ending sentence shows.
    expect(screen.queryByTestId('member-list-end')).toBeNull()

    await userEvent.click(loadMore)
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2))
    expect(fetchPage).toHaveBeenNthCalledWith(2, 'cursor-1')

    // The count is not re-requested per page -- rows from both pages
    // accumulate rather than the second page replacing the first.
    expect(await screen.findByText('person-0')).toBeInTheDocument()
    expect(screen.getByText('person-149')).toBeInTheDocument()
    expect(await screen.findByText(/that is everyone/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  it('shows an error and a Retry that re-issues the request that failed', async () => {
    const fetchPage: Mock = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        members: page(1),
        next_cursor: null,
        window_exhausted: false,
        person_count: 10_000,
      })
    render(<MemberList fetchPage={fetchPage} />)

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load/i)
    expect(screen.queryByTestId('member-list-end')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /retry/i }))
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2))
    expect(fetchPage).toHaveBeenNthCalledWith(2, undefined)
    expect(await screen.findByText(/that is everyone/i)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('disables "Load more" while its own fetch is in flight', async () => {
    let resolveSecond!: (v: MemberPage) => void
    const fetchPage: Mock = vi
      .fn()
      .mockResolvedValueOnce({
        members: page(1),
        next_cursor: 'cursor-1',
        window_exhausted: false,
        person_count: 10_000,
      })
      .mockImplementationOnce(
        () =>
          new Promise<MemberPage>((res) => {
            resolveSecond = res
          }),
      )
    render(<MemberList fetchPage={fetchPage} />)

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    const loadMore = await screen.findByRole('button', { name: /load more/i })
    await userEvent.click(loadMore)
    expect(screen.getByRole('button', { name: /load more/i })).toBeDisabled()

    resolveSecond({
      members: page(1, 1),
      next_cursor: null,
      window_exhausted: false,
      person_count: 10_000,
    })
    await waitFor(() => expect(screen.getByTestId('member-list-end')).toBeInTheDocument())
  })
})
