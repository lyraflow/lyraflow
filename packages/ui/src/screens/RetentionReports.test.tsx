import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { RetentionReports } from './RetentionReports.js'

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
  name: 'Signup to purchase',
  definition_version: 1,
  start_event: 'signup',
  return_event: 'purchase',
  start_where: [],
  return_where: [],
  granularity: 'week' as const,
  periods: 8,
  segment_id: null,
  stale: false,
  created_at: T,
  updated_at: T,
}

function renderList(reports: unknown[]) {
  const client = {
    retentionReports: vi.fn(async () => reports),
  } as unknown as ApiClient
  render(
    <MemoryRouter>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <RetentionReports client={client} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

function renderFailed() {
  const client = {
    retentionReports: vi.fn(async () => {
      throw new Error('boom')
    }),
  } as unknown as ApiClient
  render(
    <MemoryRouter>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <RetentionReports client={client} />
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

describe('RetentionReports', () => {
  it('lists saved retention reports with a definition summary', async () => {
    renderList([ROW])
    expect(await screen.findByRole('link', { name: /Signup to purchase/ })).toHaveAttribute(
      'href',
      '/retention/3',
    )
    expect(screen.getByText(/signup.*purchase.*weekly.*8 periods/i)).toBeInTheDocument()
  })

  it('says nothing is saved yet, and offers the way to make one', async () => {
    renderList([])
    expect(await screen.findByText(/no saved retention reports yet/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /new retention report/i })).toHaveAttribute(
      'href',
      '/retention/new',
    )
  })

  it('distinguishes a failed load from an empty list', async () => {
    // Issue #82's lesson, already learned by the feed and by trends: rendering
    // "nothing saved" when the request failed asserts something no query
    // established.
    renderFailed()
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument()
    expect(screen.queryByText(/no saved retention reports yet/i)).toBeNull()
  })

  it('marks a stale row without breaking the list', async () => {
    renderList([
      { ...ROW, id: 1, name: 'Fine', stale: false },
      { ...ROW, id: 2, name: 'Old grammar', stale: true },
    ])
    expect(await screen.findByText('Fine')).toBeInTheDocument()
    expect(screen.getByText('Old grammar')).toBeInTheDocument()
    expect(screen.getByTestId('report-stale-2')).toBeInTheDocument()
    expect(screen.queryByTestId('report-stale-1')).toBeNull()
  })
})

describe('RetentionReports — active project', () => {
  it('requests retention reports for the active project, not a fixed id', async () => {
    const client = { retentionReports: vi.fn(async () => [ROW]) } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <RetentionReports client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('link', { name: /Signup to purchase/ })
    expect(client.retentionReports).toHaveBeenCalledWith(1)
  })
})

describe('RetentionReports — unauthorized', () => {
  it('calls onUnauthorized on a 401, not the generic error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = {
      retentionReports: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <RetentionReports client={client} onUnauthorized={onUnauthorized} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
