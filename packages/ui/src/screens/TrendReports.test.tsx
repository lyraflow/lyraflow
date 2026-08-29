import { render, screen, waitFor } from '@testing-library/react'
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
  where: [],
  definition_version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
}

function renderList(reports: unknown[]) {
  const client = {
    trendReports: vi.fn(async () => reports),
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

  it('names the filter in the summary, so a filtered report does not read as an unfiltered one', async () => {
    renderList([
      {
        ...ROW,
        id: 1,
        name: 'registers',
        event: '$page',
        group_by: null,
        where: [{ property: 'path', operator: '=', value: '/register' }],
      },
    ])
    expect(await screen.findByText(/\$page · daily · 1 filter/)).toBeInTheDocument()
  })

  it('pluralises the filter count', async () => {
    renderList([
      {
        ...ROW,
        id: 2,
        name: 'two',
        event: '$page',
        group_by: null,
        where: [
          { property: 'path', operator: '=', value: '/r' },
          { property: 'plan', operator: '=', value: 'pro' },
        ],
      },
    ])
    expect(await screen.findByText(/2 filters/)).toBeInTheDocument()
  })

  it('badges a report whose stored predicates no longer parse', async () => {
    renderList([{ ...ROW, id: 3, name: 'broken', event: '$page', group_by: null, stale: true }])
    expect(await screen.findByTestId('report-stale-3')).toBeInTheDocument()
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
