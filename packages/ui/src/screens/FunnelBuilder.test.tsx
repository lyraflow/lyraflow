import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Funnel, FunnelRunResult } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { ROUTES, funnelEditPath } from '../app/Router.js'
import { FunnelBuilder } from './FunnelBuilder.js'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
  },
]

const FUNNEL: Funnel = {
  id: 7,
  name: 'Signup flow',
  definition_version: 1,
  steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
  window_seconds: 604800,
  segment_id: null,
  stale: false,
  last_entered: 1204,
  last_converted: 491,
  last_evaluated_at: '2026-08-15T11:58:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}

const RUN: FunnelRunResult = {
  entered: 1204,
  converted: 491,
  conversion_rate: 0.4078,
  partial_window_entrants: 312,
  range: { since: '2026-08-08T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' },
  as_of: '2026-08-15T11:58:00.000Z',
  warnings: [],
  steps: [
    { index: 1, event: 'page_view', people: 1204, from_previous: 1, from_start: 1 },
    {
      index: 2,
      event: 'signup_completed',
      people: 491,
      from_previous: 0.4078,
      from_start: 0.4078,
    },
  ],
}

function fakeBuilderClient(over: Record<string, unknown> = {}) {
  return {
    schemaEvents: vi.fn(async () => []),
    segments: vi.fn(async () => []),
    previewFunnel: vi.fn(async () => RUN),
    createFunnel: vi.fn(async () => ({ ...FUNNEL, id: 42 })),
    patchFunnel: vi.fn(async () => ({ ...FUNNEL, id: 42 })),
    funnel: vi.fn(async () => FUNNEL),
    ...over,
  } as unknown as ApiClient & {
    schemaEvents: Mock
    segments: Mock
    previewFunnel: Mock
    createFunnel: Mock
    patchFunnel: Mock
    funnel: Mock
  }
}

function renderBuilder(client: ApiClient = fakeBuilderClient(), editId?: number) {
  render(
    <MemoryRouter initialEntries={[editId != null ? funnelEditPath(editId) : ROUTES.funnelNew]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route path={ROUTES.funnelNew} element={<FunnelBuilder client={client} />} />
          <Route path="/funnels/:id/edit" element={<FunnelBuilder client={client} />} />
          {/* A successful save navigates to the detail route -- this harness
           * doesn't render `FunnelDetail`, just a placeholder so React Router
           * has somewhere to land instead of logging "no routes matched". */}
          <Route path="/funnels/:id" element={<p>saved</p>} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

/** Step 1 = page_view, Step 2 = signup_completed, via the same "type, then
 * Add step, then type" sequence the brief's own first test exercises --
 * this screen starts with exactly one empty step. Deliberately touches
 * neither the name field nor the window/segment controls, so every test
 * using this keeps the default window (7 days = 604800s) and segment
 * (Everyone = null) unless it changes them itself. */
async function fillTwoSteps() {
  await userEvent.type(screen.getByLabelText('Step 1'), 'page_view')
  await userEvent.click(screen.getByRole('button', { name: /add step/i }))
  await userEvent.type(screen.getByLabelText('Step 2'), 'signup_completed')
}

describe('FunnelBuilder', () => {
  it('requires at least two steps before preview or save is possible', async () => {
    renderBuilder()
    await userEvent.type(await screen.findByLabelText(/name/i), 'Signup')
    await userEvent.type(screen.getByLabelText('Step 1'), 'page_view')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /add step/i }))
    await userEvent.type(screen.getByLabelText('Step 2'), 'signup_completed')
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
  })

  it('previews without saving', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.click(screen.getByRole('button', { name: /preview/i }))
    await screen.findByTestId('funnel-step-1')
    expect(client.previewFunnel).toHaveBeenCalledTimes(1)
    expect(client.createFunnel).not.toHaveBeenCalled()
  })

  it('sends a flat body: name alongside steps, not nested under definition', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.type(screen.getByLabelText(/name/i), 'Signup')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(client.createFunnel).toHaveBeenCalled())
    const call = client.createFunnel.mock.calls[0]
    if (!call) throw new Error('createFunnel was not called')
    const [, name, definition] = call
    expect(name).toBe('Signup')
    expect(definition).toMatchObject({
      steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
      window_seconds: 604800,
    })
  })

  it('renders every warning the PREVIEW returned, not only the detail screen', async () => {
    // The spec requires warnings on both surfaces. #21 is open in this repo
    // precisely because one entry point omitted warnings the other returned;
    // the funnel routes avoided it server-side by sharing one execute(), and
    // the UI must not reintroduce the asymmetry.
    const client = fakeBuilderClient({
      previewFunnel: vi.fn(async () => ({
        ...RUN,
        warnings: [
          { path: 'range', reason: 'alpha reason' },
          { path: 'segment', reason: 'beta reason' },
        ],
      })),
    })
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.click(screen.getByRole('button', { name: /preview/i }))
    expect(await screen.findByText('alpha reason')).toBeInTheDocument()
    expect(screen.getByText('beta reason')).toBeInTheDocument()
  })

  it('surfaces a 409 on the name field rather than as a page error', async () => {
    const client = fakeBuilderClient({
      createFunnel: vi.fn(async () => {
        throw new ApiError(409, 'duplicate name')
      }),
    })
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i)
  })
})

// Invented beyond the brief, from the stub check and from probing the
// builder's own logic beyond what the five given tests reach.
describe('FunnelBuilder -- invented mutations', () => {
  it('preview is disabled with only one step, independent of the name field', async () => {
    renderBuilder()
    await userEvent.type(await screen.findByLabelText(/name/i), 'Signup')
    await userEvent.type(screen.getByLabelText('Step 1'), 'page_view')
    expect(screen.getByRole('button', { name: /preview/i })).toBeDisabled()
  })

  // A hardcoded call `previewFunnel(1, definition, {})` where `definition`
  // is a literal object satisfies "was called once" -- this is the one
  // that checks the SHAPE actually reflects what was typed, with a window
  // value (604800) that cannot pass by coincidence with its input (7 days).
  it('passes the exact typed steps and the default window to preview', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.click(screen.getByRole('button', { name: /preview/i }))
    await waitFor(() => expect(client.previewFunnel).toHaveBeenCalled())
    const call = client.previewFunnel.mock.calls[0]
    if (!call) throw new Error('previewFunnel was not called')
    const [projectId, definition, range] = call
    expect(projectId).toBe(1)
    expect(definition).toMatchObject({
      steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
      window_seconds: 604800,
      segment_id: null,
    })
    expect(range).toEqual({})
  })

  it('edit mode seeds every field from the fetched funnel, not the new-funnel defaults', async () => {
    const client = fakeBuilderClient({
      funnel: vi.fn(async () => ({
        ...FUNNEL,
        window_seconds: 3600,
        segment_id: 9,
      })),
    })
    renderBuilder(client, FUNNEL.id)
    expect(await screen.findByLabelText(/name/i)).toHaveValue('Signup flow')
    expect(screen.getByLabelText('Step 1')).toHaveValue('page_view')
    expect(screen.getByLabelText('Step 2')).toHaveValue('signup_completed')
    // 3600 seconds seeds as "1 hour", not the 7-day default a fresh builder
    // would show -- the one assertion that would fail if seeding silently
    // fell back to NEW_STEPS/defaults instead of reading the response.
    expect(screen.getByRole('spinbutton')).toHaveValue(1)
    expect(screen.getByRole('combobox', { name: /window unit/i })).toHaveValue('hours')
  })

  it('edit mode saves through patchFunnel, never createFunnel', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client, FUNNEL.id)
    await screen.findByLabelText(/name/i)
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.patchFunnel).toHaveBeenCalledTimes(1))
    expect(client.createFunnel).not.toHaveBeenCalled()
    const call = client.patchFunnel.mock.calls[0]
    if (!call) throw new Error('patchFunnel was not called')
    expect(call[0]).toBe(1)
    expect(call[1]).toBe(FUNNEL.id)
  })

  it('routes a 401 on save to onUnauthorized rather than an error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeBuilderClient({
      createFunnel: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    render(
      <MemoryRouter initialEntries={[ROUTES.funnelNew]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path={ROUTES.funnelNew}
              element={<FunnelBuilder client={client} onUnauthorized={onUnauthorized} />}
            />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await fillTwoSteps()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
