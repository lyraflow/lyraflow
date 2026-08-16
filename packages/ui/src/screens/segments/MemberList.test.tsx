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

  // Step 1's two failing tests, verbatim from the brief.

  it('says the population is exhausted when the walk ends naturally', async () => {
    renderMembers({ members: page(3), next_cursor: null, window_exhausted: false })
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    expect(await screen.findByText(/that is everyone/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })

  it('says there are more it cannot reach when the walk budget is spent', async () => {
    renderMembers({ members: page(100), next_cursor: null, window_exhausted: true })
    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    const end = await screen.findByTestId('member-list-end')
    expect(end).toHaveTextContent(/more people match/i)
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
