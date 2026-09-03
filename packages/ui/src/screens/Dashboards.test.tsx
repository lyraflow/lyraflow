import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { Dashboards } from './Dashboards.js'

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
  name: 'Overview',
  tile_count: 4,
  is_home: true,
  definition_version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
}

function renderList(dashboards: unknown[]) {
  const client = {
    dashboards: vi.fn(async () => dashboards),
  } as unknown as ApiClient
  render(
    <MemoryRouter>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Dashboards client={client} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

function renderFailed() {
  const client = {
    dashboards: vi.fn(async () => {
      throw new Error('boom')
    }),
  } as unknown as ApiClient
  render(
    <MemoryRouter>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Dashboards client={client} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

describe('Dashboards', () => {
  it('lists a dashboard with its tile count and home badge', async () => {
    renderList([ROW])
    expect(await screen.findByRole('link', { name: /Overview/ })).toHaveAttribute(
      'href',
      '/dashboards/3',
    )
    expect(screen.getByText('4 tiles · home')).toBeInTheDocument()
  })

  it('singularises a one-tile dashboard', async () => {
    renderList([{ ...ROW, id: 1, name: 'lonely', tile_count: 1, is_home: false }])
    expect(await screen.findByText('1 tile')).toBeInTheDocument()
  })

  it('says 0 tiles and omits "· home" for a non-home dashboard', async () => {
    renderList([{ ...ROW, id: 2, name: 'empty one', tile_count: 0, is_home: false }])
    expect(await screen.findByText('0 tiles')).toBeInTheDocument()
    expect(screen.queryByText(/home/)).not.toBeInTheDocument()
  })

  it('badges a dashboard whose stored layout no longer parses', async () => {
    renderList([{ ...ROW, id: 5, name: 'broken', stale: true }])
    expect(await screen.findByTestId('report-stale-5')).toBeInTheDocument()
  })

  it('says nothing is saved yet, and offers the way to make one', async () => {
    renderList([])
    expect(await screen.findByText(/no dashboards yet/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /new dashboard/i })).toHaveAttribute(
      'href',
      '/dashboards/new',
    )
  })

  it('distinguishes a failed load from an empty list', async () => {
    renderFailed()
    expect(await screen.findByText(/could not load/i)).toBeInTheDocument()
    expect(screen.queryByText(/no dashboards yet/i)).toBeNull()
  })
})

describe('Dashboards — unauthorized', () => {
  it('calls onUnauthorized on a 401, not the generic error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = {
      dashboards: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Dashboards client={client} onUnauthorized={onUnauthorized} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
