import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { TrendReports } from './TrendReports.js'

const T = '2026-08-27T00:00:00.000Z'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
  },
]

const ROW = {
  id: 3,
  name: 'Signups by day',
  event: 'signup',
  interval: '1d' as const,
  group_by: 'attribute:country',
  created_at: T,
  updated_at: T,
}

function renderList(reports: unknown[]) {
  const client = {
    trendReports: vi.fn(async () => reports),
    deleteTrendReport: vi.fn(async () => {}),
  } as unknown as ApiClient
  render(
    <MemoryRouter>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <TrendReports client={client} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

function renderFailed() {
  const client = {
    trendReports: vi.fn(async () => {
      throw new Error('boom')
    }),
    deleteTrendReport: vi.fn(async () => {}),
  } as unknown as ApiClient
  render(
    <MemoryRouter>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <TrendReports client={client} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

async function click(name: RegExp) {
  const user = userEvent.setup({ delay: null })
  await user.click(screen.getByRole('button', { name }))
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('TrendReports', () => {
  it('lists saved trends with a definition summary', async () => {
    renderList([ROW])
    expect(await screen.findByRole('link', { name: /Signups by day/ })).toHaveAttribute(
      'href',
      '/trends/3',
    )
    expect(screen.getByText(/signup · daily · by country/i)).toBeInTheDocument()
  })

  it('says nothing is saved yet, and offers the way to make one', async () => {
    renderList([])
    expect(await screen.findByText(/no saved trends yet/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /new trend/i })).toHaveAttribute('href', '/trends/new')
  })

  it('distinguishes a failed load from an empty list', async () => {
    // Issue #82's lesson, already learned by the feed: rendering "nothing
    // saved" when the request failed asserts something no query
    // established.
    renderFailed()
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument()
    expect(screen.queryByText(/no saved trends yet/i)).toBeNull()
  })

  it('requires a confirm before deleting, then deletes for the active project', async () => {
    const client = renderList([ROW])
    await screen.findByRole('link', { name: /Signups by day/ })
    await click(/^delete$/i)
    expect(client.deleteTrendReport).not.toHaveBeenCalled()
    await click(/^confirm$/i)
    await waitFor(() => expect(client.deleteTrendReport).toHaveBeenCalledWith(1, 3))
  })

  it('removes the row from the list once the delete resolves', async () => {
    const client = renderList([ROW])
    await screen.findByRole('link', { name: /Signups by day/ })
    await click(/^delete$/i)
    await click(/^confirm$/i)
    await waitFor(() => expect(client.deleteTrendReport).toHaveBeenCalled())
    expect(await screen.findByText(/no saved trends yet/i)).toBeInTheDocument()
  })
})

describe('TrendReports — active project', () => {
  it('requests trend reports for the active project, not a fixed id', async () => {
    const client = { trendReports: vi.fn(async () => [ROW]) } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <TrendReports client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('link', { name: /Signups by day/ })
    expect(client.trendReports).toHaveBeenCalledWith(1)
  })
})

describe('TrendReports — unauthorized', () => {
  it('calls onUnauthorized on a 401, not the generic error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = {
      trendReports: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <TrendReports client={client} onUnauthorized={onUnauthorized} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
