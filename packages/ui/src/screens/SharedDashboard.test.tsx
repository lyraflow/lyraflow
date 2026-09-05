import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { ResolvedTile, SharedDashboard as SharedDashboardWire } from '../api/types.js'
import { SharedDashboard } from './SharedDashboard.js'

const T = '2026-08-01T00:00:00.000Z'
const TOKEN = 'A'.repeat(43)

const TREND = {
  id: 1,
  name: 'Signups by country',
  event: 'signup',
  interval: '1d' as const,
  group_by: 'attribute:country',
  where: [],
  definition_version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
}

const trendTile = (id: number, name: string): ResolvedTile => ({
  kind: 'trend',
  report_id: id,
  width: 'half',
  report: { ...TREND, id, name },
})

const dash = (over: Partial<SharedDashboardWire> = {}): SharedDashboardWire => ({
  name: 'Overview',
  updated_at: T,
  stale: false,
  tiles: [],
  ...over,
})

/** A run that never settles -- every tile stays on its skeleton, which is
 *  what lets the in-flight cap be counted. */
const pending = <T,>(): Promise<T> => new Promise<T>(() => {})

function stubClient(over: Record<string, unknown> = {}): ApiClient {
  return {
    sharedDashboard: vi.fn(async () => dash()),
    runSharedTile: vi.fn(() => pending()),
    ...over,
  } as unknown as ApiClient
}

beforeEach(() => {
  window.history.replaceState(null, '', `/shared/${TOKEN}`)
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('SharedDashboard', () => {
  it('loads by token, shows the name, a presets-only picker, the auto note and the footer', async () => {
    const client = stubClient()
    render(<SharedDashboard client={client} token={TOKEN} />)

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(client.sharedDashboard).toHaveBeenCalledWith(TOKEN)
    // Custom dates are not in the shared surface's vocabulary at all.
    expect(screen.queryByRole('option', { name: 'Between two dates…' })).toBeNull()
    expect(screen.getByText(/each tile uses its own report's default window/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Lyraflow/ })).toHaveAttribute(
      'href',
      'https://lyraflow.app',
    )
    expect(screen.getByText('This dashboard has no tiles yet.')).toBeInTheDocument()
  })

  // 404 is the ONE outcome that is not a fault: the link is spent. There is
  // nothing to retry, so there is no button -- a Try again that can only
  // ever fail again reads as "keep trying" and is worse than none.
  it('a 404 says the link is no longer valid, and offers no retry', async () => {
    const client = stubClient({
      sharedDashboard: vi.fn().mockRejectedValue(new ApiError(404, 'share_not_found')),
    })
    render(<SharedDashboard client={client} token={TOKEN} />)

    expect(await screen.findByText('This link is no longer valid.')).toBeInTheDocument()
    expect(
      screen.getByText('The dashboard it opened has been unshared or deleted.'),
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })

  it('a 5xx renders the not-responding card, whose Try again re-fetches', async () => {
    const client = stubClient({
      sharedDashboard: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
        .mockResolvedValueOnce(dash({ name: 'Overview' })),
    })
    render(<SharedDashboard client={client} token={TOKEN} />)

    expect(await screen.findByText(/Lyraflow is not responding/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(client.sharedDashboard).toHaveBeenCalledTimes(2)
  })

  it('changing the range writes ?range= and re-runs every tile', async () => {
    // These runs SETTLE, unlike the cap test's below. Cancelling a tile's
    // effect stops it reading the answer; it does not free the queue slot,
    // which only settling does -- so a page of never-settling runs would
    // queue the re-runs behind the originals forever and this test would be
    // counting the queue rather than the re-run.
    const client = stubClient({
      sharedDashboard: vi.fn(async () => dash({ tiles: [trendTile(1, 'A'), trendTile(2, 'B')] })),
      runSharedTile: vi.fn(async () => ({ kind: 'trend', result: { buckets: [] } })),
    })
    render(<SharedDashboard client={client} token={TOKEN} />)
    await waitFor(() => expect(client.runSharedTile).toHaveBeenCalledTimes(2))
    expect(client.runSharedTile).toHaveBeenNthCalledWith(1, TOKEN, 0, 'auto')

    await userEvent.selectOptions(screen.getByLabelText('Range'), '30d')

    await waitFor(() => expect(client.runSharedTile).toHaveBeenCalledTimes(4))
    expect(client.runSharedTile).toHaveBeenNthCalledWith(3, TOKEN, 0, '30d')
    expect(client.runSharedTile).toHaveBeenNthCalledWith(4, TOKEN, 1, '30d')
    expect(window.location.search).toBe('?range=30d')
    // The token stays in the path: this page has no router, so the range
    // write is the one call that could drop it.
    expect(window.location.pathname).toBe(`/shared/${TOKEN}`)
  })

  // A custom range cannot be expressed on this surface (the run route takes
  // only `SHARED_RANGE_PRESETS`), and the URL an operator is most likely to
  // paste is their OWN dashboard's, which can carry exactly that. It is
  // rewritten on mount rather than silently ignored, so the address bar and
  // the picker cannot disagree about what is on screen.
  it('rewrites a pasted ?range=custom URL to auto on mount', async () => {
    window.history.replaceState(
      null,
      '',
      `/shared/${TOKEN}?range=custom&from=2026-01-01&to=2026-01-02`,
    )
    const client = stubClient({
      sharedDashboard: vi.fn(async () => dash({ tiles: [trendTile(1, 'A')] })),
    })
    render(<SharedDashboard client={client} token={TOKEN} />)

    await screen.findByRole('heading', { name: 'Overview' })
    await waitFor(() => expect(window.location.search).toBe(''))
    expect(screen.getByLabelText('Range')).toHaveValue('auto')
    expect(client.runSharedTile).toHaveBeenCalledWith(TOKEN, 0, 'auto')
  })

  // The same cap the operator's dashboard runs under, and for the same
  // reason: a shared link can be opened by many people at once, and the
  // server allows only three runs in flight per token anyway.
  it('runs at most three tiles at once', async () => {
    const tiles = [1, 2, 3, 4, 5].map((i) => trendTile(i, `Report ${i}`))
    const client = stubClient({ sharedDashboard: vi.fn(async () => dash({ tiles })) })
    render(<SharedDashboard client={client} token={TOKEN} />)

    await waitFor(() => expect(client.runSharedTile).toHaveBeenCalledTimes(3))
    // And it stays three: nothing settles, so no slot ever frees.
    await Promise.resolve()
    expect(client.runSharedTile).toHaveBeenCalledTimes(3)
    expect(screen.getAllByTestId('tile-loading')).toHaveLength(5)
  })

  it('says so when the stored layout cannot be read', async () => {
    const client = stubClient({ sharedDashboard: vi.fn(async () => dash({ stale: true })) })
    render(<SharedDashboard client={client} token={TOKEN} />)
    expect(
      await screen.findByText("This dashboard's stored layout cannot be read by this version."),
    ).toBeInTheDocument()
    // The empty-tiles line would be a second, contradictory explanation for
    // the same blank page.
    expect(screen.queryByText('This dashboard has no tiles yet.')).toBeNull()
  })

  // The wire type carries no project at all, deliberately -- a viewer holding
  // a link is told what the dashboard shows and nothing about the install it
  // came from. This asserts the OUTCOME rather than the absent field, because
  // the field is not what a later change would add back: a header, a footer
  // line or a tile subtitle would be.
  it('mentions no project anywhere', async () => {
    const client = stubClient({
      sharedDashboard: vi.fn(async () =>
        dash({ tiles: [trendTile(1, 'Signups by country'), trendTile(2, 'Weekly actives')] }),
      ),
    })
    render(<SharedDashboard client={client} token={TOKEN} />)
    await screen.findByRole('heading', { name: 'Overview' })
    expect(screen.getByText('Signups by country')).toBeInTheDocument()
    expect(document.body.textContent?.toLowerCase()).not.toContain('project')
  })

  // Every report screen is behind a login this viewer does not have, so the
  // ONLY link on the page is the one in the footer.
  it('links nowhere but lyraflow.app', async () => {
    const client = stubClient({
      sharedDashboard: vi.fn(async () => dash({ tiles: [trendTile(1, 'A')] })),
    })
    const { container } = render(<SharedDashboard client={client} token={TOKEN} />)
    await screen.findByRole('heading', { name: 'Overview' })
    const links = within(container).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', 'https://lyraflow.app')
  })
})
