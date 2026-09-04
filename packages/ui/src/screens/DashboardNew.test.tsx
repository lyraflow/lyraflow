import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { ROUTES } from '../app/Router.js'
import { DashboardNew } from './DashboardNew.js'

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

/** `/dashboards/:id` has no screen yet (Task 9 adds it) -- this stub renders
 * the location it lands on so a navigation to `/dashboards/9?edit=1` can be
 * asserted the same way the destination screen eventually would. */
function LocationProbe() {
  const { pathname, search } = useLocation()
  return <p data-testid="landed-on">{pathname + search}</p>
}

function renderNew(client: ApiClient, onUnauthorized?: () => void) {
  return render(
    <MemoryRouter initialEntries={[ROUTES.dashboardNew]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route
            path={ROUTES.dashboardNew}
            element={<DashboardNew client={client} onUnauthorized={onUnauthorized} />}
          />
          <Route path="/dashboards/:id" element={<LocationProbe />} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
}

describe('DashboardNew', () => {
  it('disables the submit button until a non-blank name is typed', async () => {
    const client = { createDashboard: vi.fn() } as unknown as ApiClient
    renderNew(client)
    const button = screen.getByRole('button', { name: /create dashboard/i })
    expect(button).toBeDisabled()
    await userEvent.type(screen.getByLabelText(/name/i), 'Overview')
    expect(button).toBeEnabled()
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), '   ')
    expect(button).toBeDisabled()
  })

  it('creates the dashboard with the trimmed name and navigates to it in edit mode', async () => {
    const client = {
      createDashboard: vi.fn(async () => ({ id: 9, name: 'Overview' })),
    } as unknown as ApiClient
    renderNew(client)
    await userEvent.type(screen.getByLabelText(/name/i), '  Overview  ')
    await userEvent.click(screen.getByRole('button', { name: /create dashboard/i }))
    expect(client.createDashboard).toHaveBeenCalledWith(1, { name: 'Overview' })
    expect(await screen.findByTestId('landed-on')).toHaveTextContent('/dashboards/9?edit=1')
  })

  it('shows "already exists" on a 409 and stays on the form', async () => {
    const client = {
      createDashboard: vi.fn(async () => {
        throw new ApiError(409, 'conflict')
      }),
    } as unknown as ApiClient
    renderNew(client)
    await userEvent.type(screen.getByLabelText(/name/i), 'Overview')
    await userEvent.click(screen.getByRole('button', { name: /create dashboard/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i)
    expect(screen.queryByTestId('landed-on')).not.toBeInTheDocument()
  })

  it('calls onUnauthorized on a 401', async () => {
    const onUnauthorized = vi.fn()
    const client = {
      createDashboard: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    } as unknown as ApiClient
    renderNew(client, onUnauthorized)
    await userEvent.type(screen.getByLabelText(/name/i), 'Overview')
    await userEvent.click(screen.getByRole('button', { name: /create dashboard/i }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
  })
})
