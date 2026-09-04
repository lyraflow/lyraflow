import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

/**
 * The home star, on the list.
 *
 * The server keeps "one home per project" as a database constraint, so a
 * successful `PATCH` that sets one dashboard home has ALREADY cleared the
 * previous one -- but it answers with the patched dashboard only, and says
 * nothing about the row it cleared. The screen mirrors that rule locally
 * rather than refetching the list: cheaper, and it cannot show two filled
 * stars for the moment a refetch would be in flight.
 */
const A = { ...ROW, id: 3, name: 'Overview', is_home: true }
const B = { ...ROW, id: 4, name: 'Growth', is_home: false }

const SET_A = 'Set "Overview" as home dashboard'
const UNSET_A = '"Overview" is the home dashboard — click to unset'
const SET_B = 'Set "Growth" as home dashboard'
const UNSET_B = '"Growth" is the home dashboard — click to unset'

function renderWithPatch(patchDashboard: ReturnType<typeof vi.fn>, onUnauthorized?: () => void) {
  const client = {
    dashboards: vi.fn(async () => [A, B]),
    patchDashboard,
  } as unknown as ApiClient
  render(
    <MemoryRouter>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Dashboards client={client} onUnauthorized={onUnauthorized} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

/** The wire answer to a `PATCH`: the row with the change applied, resolved
 *  tiles and all -- what `patchDashboard` really resolves to. */
function patched(row: typeof A, is_home: boolean) {
  return { ...row, is_home, tiles: [] }
}

describe('Dashboards — the home star', () => {
  it('sets a dashboard home, and clears the star on the one that was', async () => {
    const patchDashboard = vi.fn(async () => patched(B, true))
    const client = renderWithPatch(patchDashboard)

    await userEvent.click(await screen.findByRole('button', { name: SET_B }))
    await waitFor(() => expect(client.patchDashboard).toHaveBeenCalledWith(1, 4, { is_home: true }))

    // B is filled, A is not -- and the accessible names swapped with them.
    expect(await screen.findByRole('button', { name: UNSET_B, pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: SET_A, pressed: false })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: UNSET_A })).toBeNull()
  })

  it('clears the home dashboard when its filled star is clicked', async () => {
    const patchDashboard = vi.fn(async () => patched(A, false))
    const client = renderWithPatch(patchDashboard)

    await userEvent.click(await screen.findByRole('button', { name: UNSET_A }))
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 3, { is_home: false }),
    )
    expect(await screen.findByRole('button', { name: SET_A, pressed: false })).toBeInTheDocument()
    // Clearing one does not promote another.
    expect(screen.getByRole('button', { name: SET_B, pressed: false })).toBeInTheDocument()
  })

  it('says so and leaves both stars alone when the PATCH fails', async () => {
    const patchDashboard = vi.fn(async () => {
      throw new Error('boom')
    })
    renderWithPatch(patchDashboard)

    await userEvent.click(await screen.findByRole('button', { name: SET_B }))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not change the home dashboard/i,
    )
    expect(screen.getByRole('button', { name: UNSET_A, pressed: true })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: SET_B, pressed: false })).toBeInTheDocument()
  })

  it('routes a 401 to onUnauthorized rather than the generic failure line', async () => {
    const onUnauthorized = vi.fn()
    const patchDashboard = vi.fn(async () => {
      throw new ApiError(401, 'invalid_session')
    })
    renderWithPatch(patchDashboard, onUnauthorized)

    await userEvent.click(await screen.findByRole('button', { name: SET_B }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // A button nested inside the row's anchor would navigate on click as well
  // as toggle. It has to be a SIBLING of the link, and the link's own href
  // has to be untouched by any of this.
  it('keeps the star outside the row link, and the row link unchanged', async () => {
    const patchDashboard = vi.fn(async () => patched(B, true))
    renderWithPatch(patchDashboard)

    const star = await screen.findByRole('button', { name: SET_B })
    const link = screen.getByRole('link', { name: /Growth/ })
    expect(link).toHaveAttribute('href', '/dashboards/4')
    expect(link.contains(star)).toBe(false)
    expect(star.closest('li')).toBe(link.closest('li'))
  })
})

describe('Dashboards — the home star, while a PATCH is in flight', () => {
  it('sends one PATCH for two clicks, and releases the star when it lands', async () => {
    let resolve: ((d: unknown) => void) | undefined
    const patchDashboard = vi.fn(
      () =>
        new Promise((res) => {
          resolve = res
        }),
    )
    const client = renderWithPatch(patchDashboard as unknown as ReturnType<typeof vi.fn>)

    const star = await screen.findByRole('button', { name: SET_B })
    await userEvent.click(star)
    expect(star).toBeDisabled()

    // The second click is the one that matters: without `pending` this sends
    // a second `PATCH` for a state the first is already moving to, and the
    // two can land in either order.
    await userEvent.click(star)
    expect(client.patchDashboard).toHaveBeenCalledTimes(1)

    // Only THAT row is held shut -- the other star is still usable.
    expect(screen.getByRole('button', { name: UNSET_A })).not.toBeDisabled()

    resolve?.(patched(B, true))
    const filled = await screen.findByRole('button', { name: UNSET_B, pressed: true })
    expect(filled).not.toBeDisabled()
  })
})
