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
    })
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    expect(await screen.findByText('person-0')).toBeInTheDocument()
    expect(screen.getByText('person-1')).toBeInTheDocument()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(fetchPage).toHaveBeenCalledWith(undefined)
  })

  it('says the population is exhausted when the walk ends naturally', async () => {
    renderMembers({ members: page(3), next_cursor: null, window_exhausted: false })
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
      })
      .mockResolvedValueOnce({ members: page(37, 100), next_cursor: null, window_exhausted: true })
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
      })
      .mockResolvedValueOnce({ members: page(100, 100), next_cursor: null, window_exhausted: true })
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

  it('a walk whose only page is short and flagged says what it showed, rather than guessing', async () => {
    // The shape the real server cannot produce -- the flag needs the whole
    // page budget spent, which takes ten pages -- and therefore the one
    // where nothing in the response reveals the page size. Pinned so the
    // choice is explicit: with no wider page to measure against, this falls
    // to the ambiguous ending, which claims nothing, rather than to
    // "everyone", which would be a guess.
    renderMembers({ members: page(37), next_cursor: null, window_exhausted: true })
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    const end = await screen.findByTestId('member-list-end')
    expect(end).toHaveAttribute('data-end', 'window-full')
    expect(end).toHaveTextContent('37')
    expect(end).not.toHaveTextContent(/that is everyone/i)
  })

  it('offers "Load more" when the walk is neither exhausted nor budget-spent, and sends next_cursor', async () => {
    const fetchPage: Mock = vi
      .fn()
      .mockResolvedValueOnce({
        members: page(100),
        next_cursor: 'cursor-1',
        window_exhausted: false,
      })
      .mockResolvedValueOnce({ members: page(50, 100), next_cursor: null, window_exhausted: false })
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
      .mockResolvedValueOnce({ members: page(1), next_cursor: null, window_exhausted: false })
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
      .mockResolvedValueOnce({ members: page(1), next_cursor: 'cursor-1', window_exhausted: false })
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

    resolveSecond({ members: page(1, 1), next_cursor: null, window_exhausted: false })
    await waitFor(() => expect(screen.getByTestId('member-list-end')).toBeInTheDocument())
  })
})
