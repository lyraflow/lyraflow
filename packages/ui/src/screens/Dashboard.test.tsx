import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type {
  DashboardPatch,
  DashboardTileInput,
  Dashboard as DashboardWire,
  Funnel,
  FunnelRunResult,
  Project,
  ResolvedTile,
  RetentionReport,
  RetentionResult,
  TrendReport,
} from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { ROUTES } from '../app/Router.js'
import { Dashboard } from './Dashboard.js'

const T = '2026-08-01T00:00:00.000Z'

const PROJECTS: Project[] = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: T,
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
  },
]

// The three report shapes, copied from `DashboardTile.test.tsx` so a tile and
// this screen cannot be exercised against two different ideas of what the
// server resolves into `tiles[]`.
const TREND: TrendReport = {
  id: 1,
  name: 'Signups by country',
  event: 'signup',
  interval: '1d',
  group_by: 'attribute:country',
  where: [],
  definition_version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
}

const RETENTION: RetentionReport = {
  id: 2,
  name: 'Weekly return',
  definition_version: 1,
  start_event: 'signed_up',
  return_event: 'project_created',
  start_where: [],
  return_where: [],
  granularity: 'week',
  periods: 8,
  segment_id: null,
  stale: false,
  created_at: T,
  updated_at: T,
}

const FUNNEL: Funnel = {
  id: 3,
  name: 'Signup flow',
  definition_version: 1,
  steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
  window_seconds: 604800,
  segment_id: null,
  stale: false,
  last_entered: 1204,
  last_converted: 491,
  last_evaluated_at: T,
  last_range: null,
  created_at: T,
  updated_at: T,
}

const trendTile: ResolvedTile = { kind: 'trend', report_id: 1, width: 'half', report: TREND }
const funnelTile: ResolvedTile = { kind: 'funnel', report_id: 3, width: 'half', report: FUNNEL }

/** What the screen must SEND for each of the fixture's tiles: the reference
 *  only. `report` is resolved server-side and has no place in a `PATCH`. */
const trendInput: DashboardTileInput = { kind: 'trend', report_id: 1, width: 'half' }
const funnelInput: DashboardTileInput = { kind: 'funnel', report_id: 3, width: 'half' }

const DASH: DashboardWire = {
  id: 7,
  name: 'Overview',
  tile_count: 2,
  is_home: false,
  definition_version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
  tiles: [trendTile, funnelTile],
}

const FUNNEL_RUN: FunnelRunResult = {
  entered: 10,
  converted: 4,
  conversion_rate: 0.4,
  partial_window_entrants: 0,
  range: { since: T, until: T },
  as_of: T,
  warnings: [],
  steps: [
    { index: 1, event: 'page_view', people: 10, from_previous: 1, from_start: 1 },
    { index: 2, event: 'signup_completed', people: 4, from_previous: 0.4, from_start: 0.4 },
  ],
}

const RETENTION_RUN: RetentionResult = {
  granularity: 'week',
  periods: 1,
  cohorts: [{ cohort: '2026-06-01', size: 4, retained: [4, 2] }],
  start_event: 'signed_up',
  return_event: 'project_created',
  since: T,
  until: T,
  computed_at: T,
  warnings: [],
}

/** A `DashboardTileInput` resolved back into a `ResolvedTile`, the way the
 *  server answers a `PATCH` that changed the layout. */
function resolveTile(t: DashboardTileInput): ResolvedTile {
  switch (t.kind) {
    case 'trend':
      return { kind: 'trend', report_id: t.report_id, width: t.width, report: TREND }
    case 'retention':
      return { kind: 'retention', report_id: t.report_id, width: t.width, report: RETENTION }
    case 'funnel':
      return { kind: 'funnel', report_id: t.report_id, width: t.width, report: FUNNEL }
  }
}

/** The `PATCH` response: the fixture with the patch applied, so the screen's
 *  "replace local state with the response" path is what the assertions see. */
function applied(patch: DashboardPatch): DashboardWire {
  return {
    ...DASH,
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.is_home === undefined ? {} : { is_home: patch.is_home }),
    ...(patch.tiles === undefined
      ? {}
      : { tiles: patch.tiles.map(resolveTile), tile_count: patch.tiles.length }),
  }
}

function fakeClient(over: Record<string, unknown> = {}): ApiClient {
  return {
    dashboard: vi.fn(async () => DASH),
    patchDashboard: vi.fn(async (_p: number, _id: number, patch: DashboardPatch) => applied(patch)),
    deleteDashboard: vi.fn(async () => undefined),
    stats: vi.fn(async () => ({ buckets: [] })),
    runRetention: vi.fn(async () => RETENTION_RUN),
    runFunnel: vi.fn(async () => FUNNEL_RUN),
    // `AddTilePicker` loads all three lists on mount in edit mode.
    trendReports: vi.fn(async () => [TREND]),
    retentionReports: vi.fn(async () => [RETENTION]),
    funnels: vi.fn(async () => [FUNNEL]),
    ...over,
  } as unknown as ApiClient
}

/** The address bar, so a test can pin what the screen wrote to the URL
 *  rather than inferring it from what re-rendered. */
function LocationEcho() {
  const loc = useLocation()
  return <span data-testid="loc">{`${loc.pathname}${loc.search}`}</span>
}

/** Drops `?edit=1` by NAVIGATING rather than through the screen's own Done
 *  button -- the browser Back case, which reaches edit mode's exit without
 *  passing through any handler the screen owns. */
function DropEditFlag() {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate('/dashboards/7')}>
      drop the edit flag
    </button>
  )
}

function renderScreen(opts: { client?: ApiClient; at?: string; onUnauthorized?: () => void } = {}) {
  const client = opts.client ?? fakeClient()
  const view = render(
    <MemoryRouter initialEntries={[opts.at ?? '/dashboards/7']}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route
            path="/dashboards/:id"
            element={
              <>
                <Dashboard client={client} onUnauthorized={opts.onUnauthorized} />
                <LocationEcho />
                <DropEditFlag />
              </>
            }
          />
          {/* Somewhere for the post-delete navigation to land. */}
          <Route path={ROUTES.dashboards} element={<p>dashboards list</p>} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
  return { client, ...view }
}

/** The two fixture cards, in document order. The inner states a tile renders
 *  (`tile-loading`, `tile-result`, …) share the `tile-` prefix, so this names
 *  the two card testids exactly rather than matching on the prefix. */
function tileOrder(container: HTMLElement): string[] {
  const cards = container.querySelectorAll(
    '[data-testid="tile-trend-1"], [data-testid="tile-funnel-3"], [data-testid="tile-retention-2"]',
  )
  return [...cards].map((c) => c.getAttribute('data-testid') ?? '')
}

describe('Dashboard', () => {
  it('fetches the dashboard for the active project and the id in the URL', async () => {
    const { client } = renderScreen()
    await waitFor(() => expect(client.dashboard).toHaveBeenCalledWith(1, 7))
  })

  it('renders one tile per resolved tile, in order', async () => {
    const { container } = renderScreen()
    await screen.findByTestId('tile-trend-1')
    expect(tileOrder(container)).toEqual(['tile-trend-1', 'tile-funnel-3'])
  })

  it('view mode shows no edit controls; ?edit=1 shows them', async () => {
    const { unmount } = renderScreen()
    await screen.findByTestId('tile-trend-1')
    expect(screen.queryByRole('button', { name: 'Move down' })).toBeNull()
    expect(screen.queryByLabelText('Dashboard name')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Set as home' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull()
    expect(screen.queryByLabelText('Report to add')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    unmount()

    renderScreen({ at: '/dashboards/7?edit=1' })
    expect(await screen.findByLabelText('Dashboard name')).toHaveValue('Overview')
    expect(screen.getAllByRole('button', { name: 'Move down' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Set as home' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
    expect(await screen.findByLabelText('Report to add')).toBeInTheDocument()
  })

  it('Edit toggles ?edit=1 into the URL; Done removes it', async () => {
    renderScreen()
    await userEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/dashboards/7?edit=1')
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.getByTestId('loc')).toHaveTextContent('/dashboards/7')
    expect(screen.getByTestId('loc').textContent).not.toContain('edit')
  })

  it('the range picker writes the URL and re-runs every tile, and never PATCHes', async () => {
    const { client } = renderScreen()
    await screen.findByTestId('tile-trend-1')
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(1))
    expect(client.runFunnel).toHaveBeenCalledTimes(1)

    await userEvent.selectOptions(screen.getByLabelText('Range'), '30d')
    expect(screen.getByTestId('loc')).toHaveTextContent('range=30d')
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(2))
    expect(client.runFunnel).toHaveBeenCalledTimes(2)
    expect(client.patchDashboard).not.toHaveBeenCalled()
  })

  it('an incomplete custom range says "Pick both dates" and runs nothing', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?range=custom&from=2026-06-01' })
    expect(await screen.findByText(/pick both dates/i)).toBeInTheDocument()
    await waitFor(() => expect(client.dashboard).toHaveBeenCalled())
    expect(screen.queryByTestId('tile-trend-1')).toBeNull()
    expect(client.stats).not.toHaveBeenCalled()
    expect(client.runFunnel).not.toHaveBeenCalled()
  })

  it('move down sends the reordered tiles array, nothing else', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?edit=1' })
    const trend = await screen.findByTestId('tile-trend-1')
    await userEvent.click(within(trend).getByRole('button', { name: 'Move down' }))
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, {
        tiles: [funnelInput, trendInput],
      }),
    )
  })

  it('move up on the first tile is disabled; move down on the last is disabled', async () => {
    renderScreen({ at: '/dashboards/7?edit=1' })
    const trend = await screen.findByTestId('tile-trend-1')
    const funnel = screen.getByTestId('tile-funnel-3')
    expect(within(trend).getByRole('button', { name: 'Move up' })).toBeDisabled()
    expect(within(trend).getByRole('button', { name: 'Move down' })).toBeEnabled()
    expect(within(funnel).getByRole('button', { name: 'Move up' })).toBeEnabled()
    expect(within(funnel).getByRole('button', { name: 'Move down' })).toBeDisabled()
  })

  it('width toggle changes exactly that tile', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?edit=1' })
    const trend = await screen.findByTestId('tile-trend-1')
    await userEvent.click(within(trend).getByRole('button', { name: 'Full width' }))
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, {
        tiles: [
          { kind: 'trend', report_id: 1, width: 'full' },
          { kind: 'funnel', report_id: 3, width: 'half' },
        ],
      }),
    )
  })

  it('remove drops exactly that index', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?edit=1' })
    const funnel = await screen.findByTestId('tile-funnel-3')
    await userEvent.click(within(funnel).getByRole('button', { name: 'Remove' }))
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, { tiles: [trendInput] }),
    )
    expect(await screen.findByTestId('tile-trend-1')).toBeInTheDocument()
    expect(screen.queryByTestId('tile-funnel-3')).toBeNull()
  })

  it('add appends a half tile', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?edit=1' })
    const select = await screen.findByLabelText('Report to add')
    await userEvent.selectOptions(select, 'retention:2')
    await userEvent.click(screen.getByRole('button', { name: 'Add tile' }))
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, {
        tiles: [trendInput, funnelInput, { kind: 'retention', report_id: 2, width: 'half' }],
      }),
    )
    expect(await screen.findByTestId('tile-retention-2')).toBeInTheDocument()
  })

  it('rename sends { name } alone, on blur and on enter', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?edit=1' })
    const input = await screen.findByLabelText('Dashboard name')
    await userEvent.clear(input)
    await userEvent.type(input, 'Weekly view')
    await userEvent.tab()
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, { name: 'Weekly view' }),
    )

    await userEvent.clear(input)
    await userEvent.type(input, 'Monthly view{Enter}')
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, { name: 'Monthly view' }),
    )
    expect(client.patchDashboard).toHaveBeenCalledTimes(2)
  })

  it('set as home sends { is_home: true } alone; the button then reads Home and sends { is_home: false }', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?edit=1' })
    await userEvent.click(await screen.findByRole('button', { name: 'Set as home' }))
    await waitFor(() => expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, { is_home: true }))

    const home = await screen.findByRole('button', { name: 'Home' })
    await userEvent.click(home)
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, { is_home: false }),
    )
  })

  it('a failed PATCH keeps the previous tiles on screen and shows the failure', async () => {
    const client = fakeClient({
      patchDashboard: vi.fn(async () => {
        throw new ApiError(500, 'server_error')
      }),
    })
    const { container } = renderScreen({ client, at: '/dashboards/7?edit=1' })
    const trend = await screen.findByTestId('tile-trend-1')
    await userEvent.click(within(trend).getByRole('button', { name: 'Move down' }))
    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument()
    expect(tileOrder(container)).toEqual(['tile-trend-1', 'tile-funnel-3'])
  })

  it('a 409 on rename says the name is taken', async () => {
    const client = fakeClient({
      patchDashboard: vi.fn(async () => {
        throw new ApiError(409, 'dashboard_name_taken')
      }),
    })
    renderScreen({ client, at: '/dashboards/7?edit=1' })
    const input = await screen.findByLabelText('Dashboard name')
    await userEvent.clear(input)
    await userEvent.type(input, 'Taken{Enter}')
    expect(await screen.findByText(/already exists/i)).toBeInTheDocument()
  })

  it('delete asks for confirmation, then deletes and navigates to the list', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?edit=1' })
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }))
    expect(client.deleteDashboard).not.toHaveBeenCalled()
    expect(screen.getByText(/delete this dashboard/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^delete dashboard$/i }))
    await waitFor(() => expect(client.deleteDashboard).toHaveBeenCalledWith(1, 7))
    expect(await screen.findByText('dashboards list')).toBeInTheDocument()
  })

  // Self-review: the confirmation panel used to render on `confirmingDelete`
  // alone, so `Done` left a `Delete dashboard` button on a screen with no
  // other edit control on it.
  it('Done withdraws an open delete confirmation', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?edit=1' })
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }))
    expect(screen.getByRole('button', { name: /^delete dashboard$/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('button', { name: /^delete dashboard$/i })).toBeNull()
    expect(client.deleteDashboard).not.toHaveBeenCalled()
    // And re-entering edit mode opens on the ordinary controls, not back
    // inside the confirmation.
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^delete dashboard$/i })).toBeNull()
  })

  it('an edit flag dropped from the URL withdraws the confirmation too', async () => {
    renderScreen({ at: '/dashboards/7?edit=1' })
    await userEvent.click(await screen.findByRole('button', { name: /^delete$/i }))
    expect(screen.getByRole('button', { name: /^delete dashboard$/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'drop the edit flag' }))
    expect(screen.getByTestId('loc').textContent).not.toContain('edit')
    expect(screen.queryByRole('button', { name: /^delete dashboard$/i })).toBeNull()
  })

  it('a 404 on load says the dashboard no longer exists and links back to the list', async () => {
    const client = fakeClient({
      dashboard: vi.fn(async () => {
        throw new ApiError(404, 'dashboard_not_found')
      }),
    })
    renderScreen({ client })
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/i)
    expect(screen.getByRole('link', { name: /back to dashboards/i })).toHaveAttribute(
      'href',
      ROUTES.dashboards,
    )
  })

  it('a non-numeric id says the dashboard no longer exists rather than fetching', async () => {
    const { client } = renderScreen({ at: '/dashboards/abc' })
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/i)
    expect(client.dashboard).not.toHaveBeenCalled()
  })

  it('a stale dashboard says its layout cannot be read and still offers Delete and Add tile', async () => {
    const client = fakeClient({
      dashboard: vi.fn(async () => ({ ...DASH, stale: true, tile_count: 0, tiles: [] })),
    })
    renderScreen({ client, at: '/dashboards/7?edit=1' })
    expect(await screen.findByText(/stored layout cannot be read/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Add tile' })).toBeInTheDocument()
  })

  it('routes a 401 to onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      dashboard: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    renderScreen({ client, onUnauthorized })
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('PATCH bodies never carry the range', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?edit=1&range=30d' })
    const trend = await screen.findByTestId('tile-trend-1')
    await userEvent.click(within(trend).getByRole('button', { name: 'Move down' }))
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, {
        tiles: [funnelInput, trendInput],
      }),
    )
  })

  // Task 8's review: the tile's run effect depends on the IDENTITY of `tile`,
  // `range` and `queue`. A screen that rebuilt any of the three on every
  // render would re-run every tile on any state change at all -- edit mode
  // toggling is the cheapest one to drive, and it also rewrites the URL, so
  // it catches a `range` derived from the whole search string rather than
  // from the three keys that make one.
  it('an unrelated re-render does not re-run any tile', async () => {
    const { client } = renderScreen()
    await screen.findByTestId('tile-trend-1')
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(1))
    expect(client.runFunnel).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await screen.findByRole('button', { name: 'Done' })
    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    await screen.findByRole('button', { name: 'Edit' })

    expect(client.stats).toHaveBeenCalledTimes(1)
    expect(client.runFunnel).toHaveBeenCalledTimes(1)
  })
})
