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
import { ProjectProvider, useProject } from '../app/ProjectContext.js'
import { ROUTES } from '../app/Router.js'
import { Dashboard } from './Dashboard.js'
import { MAX_TILES } from './dashboards/tileRequest.js'

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

/** The home star's two accessible names. It carries no dashboard name here
 *  -- there is exactly one dashboard on this screen, so the label has
 *  nothing to disambiguate from. The list does pass one. */
const SET_HOME = 'Set as home dashboard'
const UNSET_HOME = 'Home dashboard — click to unset'

/** Filled or empty is an ATTRIBUTE, not text: lucide draws the outline with
 *  `fill="none"` and the filled variant overrides it. */
function starFill(button: HTMLElement): string | null {
  return button.querySelector('svg')?.getAttribute('fill') ?? null
}

const DASH: DashboardWire = {
  id: 7,
  name: 'Overview',
  tile_count: 2,
  is_home: false,
  definition_version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
  shared: false,
  share: null,
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

/**
 * A `patchDashboard` whose response carries a FRESH tiles array and fresh
 * tile objects -- what a real one does, since the response is parsed JSON.
 * `applied()` above deliberately returns `DASH.tiles` unchanged for a
 * name-only patch, which is the shape that hid I1: identical references make
 * a screen that re-runs every tile on rename look correct.
 */
function freshTiles(patch: DashboardPatch): DashboardWire {
  const d = applied(patch)
  return { ...d, tiles: d.tiles.map((t) => ({ ...t })) }
}

/** `n` trend tiles with distinct report ids, so a test can sit at the cap. */
function manyTiles(n: number): ResolvedTile[] {
  return Array.from({ length: n }, (_, i) => ({
    kind: 'trend' as const,
    report_id: i + 1,
    width: 'half' as const,
    report: { ...TREND, id: i + 1 },
  }))
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

/** A promise this test resolves by hand, so a PATCH can be left in flight
 *  while the screen is driven further. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const PROJECTS_TWO: Project[] = [
  ...PROJECTS,
  {
    id: 2,
    name: 'Beta',
    slug: 'beta',
    created_at: T,
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
  },
]

/** Project 2's dashboard 7 -- a different name and a different tile, so a
 *  response belonging to project 1 arriving late is visible rather than
 *  indistinguishable from what is already on screen. */
const BETA: DashboardWire = {
  ...DASH,
  name: 'Beta board',
  tile_count: 1,
  tiles: [{ kind: 'retention', report_id: 2, width: 'half', report: RETENTION }],
}

function SwitchProject(props: { to: number; label: string }) {
  const { setActiveId } = useProject()
  return (
    <button type="button" onClick={() => setActiveId(props.to)}>
      {props.label}
    </button>
  )
}

/** Like `renderScreen`, but the project can change while the screen stays
 *  mounted. */
function renderTwoProjectScreen(client: ApiClient, at: string) {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <ProjectProvider projects={PROJECTS_TWO} initialId={1}>
        <SwitchProject to={2} label="switch project" />
        <Routes>
          <Route path="/dashboards/:id" element={<Dashboard client={client} />} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
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
    // The home star is NOT an edit control: it is on screen in both modes,
    // which is the whole point of it being a star rather than a labelled
    // button buried behind Edit.
    expect(screen.getByRole('button', { name: SET_HOME, pressed: false })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull()
    expect(screen.queryByLabelText('Report to add')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    unmount()

    renderScreen({ at: '/dashboards/7?edit=1' })
    expect(await screen.findByLabelText('Dashboard name')).toHaveValue('Overview')
    expect(screen.getAllByRole('button', { name: 'Move down' })).toHaveLength(2)
    expect(screen.getByRole('button', { name: SET_HOME })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
    expect(await screen.findByLabelText('Report to add')).toBeInTheDocument()
  })

  // Now that the sidebar's Dashboards entry and the Lyraflow mark both open
  // the starred dashboard directly (`/dashboards/home`), the list is no
  // longer one click away from here -- this link is. In both modes, since
  // there was never a reason to bury it behind Edit.
  it('offers a link back to the list, in both view and edit mode', async () => {
    const { unmount } = renderScreen()
    expect(await screen.findByRole('link', { name: /all dashboards/i })).toHaveAttribute(
      'href',
      ROUTES.dashboards,
    )
    unmount()

    renderScreen({ at: '/dashboards/7?edit=1' })
    expect(await screen.findByRole('link', { name: /all dashboards/i })).toHaveAttribute(
      'href',
      ROUTES.dashboards,
    )
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

  it('the picker marks the reports already on the dashboard', async () => {
    renderScreen({ at: '/dashboards/7?edit=1' })
    const select = await screen.findByLabelText('Report to add')
    expect(within(select).getByRole('option', { name: /Signups by country/ })).toBeDisabled()
    expect(within(select).getByRole('option', { name: /Signup flow/ })).toBeDisabled()
    expect(within(select).getByRole('option', { name: 'Weekly return' })).toBeEnabled()
  })

  it('a just-added report is marked as soon as the patch lands', async () => {
    renderScreen({ at: '/dashboards/7?edit=1' })
    const select = await screen.findByLabelText('Report to add')
    await userEvent.selectOptions(select, 'retention:2')
    await userEvent.click(screen.getByRole('button', { name: 'Add tile' }))
    await screen.findByTestId('tile-retention-2')
    expect(
      await screen.findByText(/Every saved report is already on this dashboard\./i),
    ).toBeInTheDocument()
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

  it('the empty star sends { is_home: true } alone; the filled one then sends { is_home: false }', async () => {
    const { client } = renderScreen({ at: '/dashboards/7?edit=1' })
    const empty = await screen.findByRole('button', { name: SET_HOME })
    expect(starFill(empty)).toBe('none')
    await userEvent.click(empty)
    await waitFor(() => expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, { is_home: true }))

    const home = await screen.findByRole('button', { name: UNSET_HOME, pressed: true })
    expect(starFill(home)).toBe('currentColor')
    await userEvent.click(home)
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, { is_home: false }),
    )
  })

  // The star is the ONLY thing on this screen that says which dashboard `/`
  // opens, so its fill has to follow the fetched value and not just a click.
  it('renders a filled star for a dashboard that is already home', async () => {
    const client = fakeClient({ dashboard: vi.fn(async () => ({ ...DASH, is_home: true })) })
    renderScreen({ client })
    const star = await screen.findByRole('button', { name: UNSET_HOME, pressed: true })
    expect(starFill(star)).toBe('currentColor')
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

  // I1 (review): `patch()` replaces `dash` with the response, and a real
  // response is parsed JSON -- so `tiles` and every tile in it are fresh
  // references even when the layout is byte-identical. `DashboardTile`'s
  // effect fires on `tile` identity, so a rename dropped every tile to a
  // skeleton and re-queried the page. These two stub a response that behaves
  // the way the server's does.
  it('a rename does not re-run any tile', async () => {
    const client = fakeClient({
      patchDashboard: vi.fn(async (_p: number, _id: number, patch: DashboardPatch) =>
        freshTiles(patch),
      ),
    })
    renderScreen({ client, at: '/dashboards/7?edit=1' })
    await screen.findByTestId('tile-trend-1')
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(1))
    expect(client.runFunnel).toHaveBeenCalledTimes(1)

    const input = screen.getByLabelText('Dashboard name')
    await userEvent.clear(input)
    await userEvent.type(input, 'Weekly view{Enter}')
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, { name: 'Weekly view' }),
    )
    await screen.findByDisplayValue('Weekly view')

    expect(client.stats).toHaveBeenCalledTimes(1)
    expect(client.runFunnel).toHaveBeenCalledTimes(1)
  })

  it('set as home does not re-run any tile', async () => {
    const client = fakeClient({
      patchDashboard: vi.fn(async (_p: number, _id: number, patch: DashboardPatch) =>
        freshTiles(patch),
      ),
    })
    renderScreen({ client, at: '/dashboards/7?edit=1' })
    await screen.findByTestId('tile-trend-1')
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(1))
    expect(client.runFunnel).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: SET_HOME }))
    await screen.findByRole('button', { name: UNSET_HOME })

    expect(client.stats).toHaveBeenCalledTimes(1)
    expect(client.runFunnel).toHaveBeenCalledTimes(1)
  })

  // M2 (review): the server refuses a thirteenth tile with a field-level 400,
  // which reaches an operator as "This dashboard could not be read: …" for an
  // add. The cap is mirrored in `tileRequest.ts` and said here instead.
  it('at the tile cap the picker is replaced by the reason', async () => {
    const client = fakeClient({
      dashboard: vi.fn(async () => ({
        ...DASH,
        tile_count: MAX_TILES,
        tiles: manyTiles(MAX_TILES),
      })),
    })
    renderScreen({ client, at: '/dashboards/7?edit=1' })
    expect(await screen.findByText(/holds at most 12 tiles/i)).toBeInTheDocument()
    expect(screen.queryByLabelText('Report to add')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add tile' })).toBeNull()
  })

  it('one below the cap still offers the picker', async () => {
    const client = fakeClient({
      dashboard: vi.fn(async () => ({
        ...DASH,
        tile_count: MAX_TILES - 1,
        tiles: manyTiles(MAX_TILES - 1),
      })),
    })
    renderScreen({ client, at: '/dashboards/7?edit=1' })
    expect(await screen.findByLabelText('Report to add')).toBeInTheDocument()
    expect(screen.queryByText(/holds at most/i)).toBeNull()
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

  // C1 from the final whole-branch review, from this side: the screen sends
  // the WHOLE tile array on every edit, dangling tiles included. This pins
  // that it keeps doing so -- routing the edit around a deleted report
  // instead would silently drop the tile that is the only thing telling the
  // operator a report they relied on is gone.
  it('reorders a layout carrying a deleted report, and sends the dangling tile too', async () => {
    const dangling: ResolvedTile = { ...funnelTile, report: null }
    const withDangling: DashboardWire = { ...DASH, tiles: [trendTile, dangling] }
    const client = fakeClient({
      dashboard: vi.fn(async () => withDangling),
      patchDashboard: vi.fn(async () => ({ ...withDangling, tiles: [dangling, trendTile] })),
    })
    const { container } = renderScreen({ client, at: '/dashboards/7?edit=1' })
    const funnel = await screen.findByTestId('tile-funnel-3')
    expect(within(funnel).getByTestId('tile-deleted')).toBeInTheDocument()

    await userEvent.click(within(funnel).getByRole('button', { name: 'Move up' }))
    await waitFor(() =>
      expect(client.patchDashboard).toHaveBeenCalledWith(1, 7, {
        tiles: [funnelInput, trendInput],
      }),
    )
    await waitFor(() => expect(tileOrder(container)).toEqual(['tile-funnel-3', 'tile-trend-1']))
  })

  // I1 from the final whole-branch review: every layout control sends the
  // whole array as it stands on screen, so two clicks before the first
  // response lands both carry the PRE-EDIT array and the second write
  // silently replaces the first.
  it('shuts every layout control while a PATCH is in flight, and sends exactly one', async () => {
    const gate = deferred<DashboardWire>()
    const client = fakeClient({
      patchDashboard: vi.fn(() => gate.promise),
    })
    renderScreen({ client, at: '/dashboards/7?edit=1' })
    const trend = await screen.findByTestId('tile-trend-1')
    const funnel = screen.getByTestId('tile-funnel-3')

    // A chosen report, so `Add tile` is enabled on its own terms and the
    // assertion below is about `saving` rather than about an empty select.
    await userEvent.selectOptions(await screen.findByLabelText('Report to add'), 'retention:2')
    expect(screen.getByRole('button', { name: 'Add tile' })).toBeEnabled()

    await userEvent.click(within(trend).getByRole('button', { name: 'Move down' }))

    await waitFor(() =>
      expect(within(funnel).getByRole('button', { name: 'Move up' })).toBeDisabled(),
    )
    expect(within(trend).getByRole('button', { name: 'Move down' })).toBeDisabled()
    expect(within(trend).getByRole('button', { name: 'Full width' })).toBeDisabled()
    expect(within(trend).getByRole('button', { name: 'Remove' })).toBeDisabled()
    expect(within(funnel).getByRole('button', { name: 'Remove' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add tile' })).toBeDisabled()

    // The second click a disabled button is there to refuse.
    await userEvent.click(within(funnel).getByRole('button', { name: 'Move up' }))
    expect(client.patchDashboard).toHaveBeenCalledTimes(1)

    gate.resolve(applied({ tiles: [funnelInput, trendInput] }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add tile' })).toBeEnabled())
    expect(
      within(screen.getByTestId('tile-trend-1')).getByRole('button', { name: 'Remove' }),
    ).toBeEnabled()
    expect(client.patchDashboard).toHaveBeenCalledTimes(1)
  })

  // I2 from the final whole-branch review: the load effect has a `cancelled`
  // flag and `patch()` had none, so a PATCH still in flight when the project
  // changed applied the OLD project's dashboard over the new project's --
  // and every tile then ran the old project's questions scoped to the new
  // project's id.
  it('drops a PATCH response that lands after the project changed', async () => {
    const gate = deferred<DashboardWire>()
    const client = fakeClient({
      dashboard: vi.fn(async (projectId: number) => (projectId === 1 ? DASH : BETA)),
      patchDashboard: vi.fn(() => gate.promise),
    })
    renderTwoProjectScreen(client, '/dashboards/7?edit=1')
    const trend = await screen.findByTestId('tile-trend-1')
    await userEvent.click(within(trend).getByRole('button', { name: 'Move down' }))

    await userEvent.click(screen.getByRole('button', { name: 'switch project' }))
    expect(await screen.findByTestId('tile-retention-2')).toBeInTheDocument()
    expect(await screen.findByDisplayValue('Beta board')).toBeInTheDocument()

    gate.resolve(applied({ tiles: [funnelInput, trendInput] }))

    await waitFor(() => expect(client.dashboard).toHaveBeenCalledWith(2, 7))
    expect(screen.getByTestId('tile-retention-2')).toBeInTheDocument()
    expect(screen.queryByTestId('tile-trend-1')).toBeNull()
    expect(screen.queryByTestId('tile-funnel-3')).toBeNull()
    expect(screen.getByDisplayValue('Beta board')).toBeInTheDocument()
    expect(screen.queryByDisplayValue('Overview')).toBeNull()
  })

  // I4 from the final whole-branch review: `auto` sends no range at all, so
  // each endpoint applies its OWN default window and the tiles on one
  // dashboard show different periods side by side. The screen says so rather
  // than letting the picker's "Default for this resolution" imply one shared
  // window.
  it('says the tiles do not share a window under auto, and stops saying it under a preset', async () => {
    const { unmount } = renderScreen()
    await screen.findByTestId('tile-trend-1')
    expect(screen.getByText(/each tile uses its own report's default window/i)).toBeInTheDocument()
    unmount()

    renderScreen({ at: '/dashboards/7?range=7d' })
    await screen.findByTestId('tile-trend-1')
    expect(screen.queryByText(/each tile uses its own report's default window/i)).toBeNull()
  })
})

const SHARE = { token: 'T'.repeat(43), shared_at: T }

describe('Dashboard — sharing', () => {
  it('Share is offered in view mode and opens the card; Create link sends POST share once and the card shows the URL', async () => {
    const shareDashboard = vi.fn(async () => SHARE)
    const client = fakeClient({ shareDashboard })
    renderScreen({ client })
    await screen.findByTestId('tile-trend-1')
    expect(screen.queryByRole('button', { name: 'Create link' })).toBeNull()

    await userEvent.click(await screen.findByRole('button', { name: 'Share' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Create link' }))

    expect(client.shareDashboard).toHaveBeenCalledTimes(1)
    expect(client.shareDashboard).toHaveBeenCalledWith(1, 7)
    expect(screen.getByRole('textbox', { name: 'Share link' })).toHaveValue(
      `${window.location.origin}/shared/${SHARE.token}`,
    )
  })

  it('Revoke sends DELETE share and the card returns to its pre-link state', async () => {
    const unshareDashboard = vi.fn(async () => undefined)
    const client = fakeClient({
      dashboard: vi.fn(async () => ({ ...DASH, shared: true, share: SHARE })),
      unshareDashboard,
    })
    renderScreen({ client })
    await screen.findByTestId('tile-trend-1')
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }))
    expect(await screen.findByRole('textbox', { name: 'Share link' })).toHaveValue(
      `${window.location.origin}/shared/${SHARE.token}`,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Revoke link' }))
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    await waitFor(() => expect(client.unshareDashboard).toHaveBeenCalledWith(1, 7))
    expect(await screen.findByRole('button', { name: 'Create link' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Share link' })).toBeNull()
  })

  it('Share is not offered in edit mode, and entering edit mode closes an open card', async () => {
    renderScreen({ at: '/dashboards/7?edit=1' })
    await screen.findByLabelText('Dashboard name')
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'Done' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }))
    expect(await screen.findByRole('button', { name: 'Create link' })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.queryByRole('button', { name: 'Create link' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Share' })).toBeNull()
  })

  it('a failed share leaves an error on the card and the dashboard unchanged', async () => {
    const client = fakeClient({
      shareDashboard: vi.fn(async () => {
        throw new ApiError(500, 'server_error')
      }),
    })
    renderScreen({ client })
    await screen.findByTestId('tile-trend-1')
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Create link' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i)
    expect(screen.getByRole('button', { name: 'Create link' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Share link' })).toBeNull()
  })

  it('a failed revoke leaves an error on the card and the link in place', async () => {
    const client = fakeClient({
      dashboard: vi.fn(async () => ({ ...DASH, shared: true, share: SHARE })),
      unshareDashboard: vi.fn(async () => {
        throw new ApiError(500, 'server_error')
      }),
    })
    renderScreen({ client })
    await screen.findByTestId('tile-trend-1')
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }))
    await screen.findByRole('textbox', { name: 'Share link' })
    await userEvent.click(screen.getByRole('button', { name: 'Revoke link' }))
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i)
    expect(screen.getByRole('textbox', { name: 'Share link' })).toHaveValue(
      `${window.location.origin}/shared/${SHARE.token}`,
    )
  })

  it('routes a 401 on share to onUnauthorized rather than the card error', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      shareDashboard: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    renderScreen({ client, onUnauthorized })
    await screen.findByTestId('tile-trend-1')
    await userEvent.click(await screen.findByRole('button', { name: 'Share' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Create link' }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // Same discipline `patch()` already keeps for a stale response: a share
  // answer for a dashboard no longer on screen must not land on whatever IS
  // on screen now. Both dashboards carry id 7 -- project 1's response
  // landing on project 2's dashboard is the bug this guards, and it is
  // visible only if the card for project 2's dashboard is reopened AFTER
  // the stale response would otherwise have applied: the project switch
  // itself closes the card, so a card left shut can't show the leak either
  // way.
  it('drops a share response that lands after the project changed, even once its card is reopened', async () => {
    const gate = deferred<typeof SHARE>()
    const client = fakeClient({
      dashboard: vi.fn(async (projectId: number) => (projectId === 1 ? DASH : BETA)),
      shareDashboard: vi.fn(() => gate.promise),
    })
    renderTwoProjectScreen(client, '/dashboards/7')
    await screen.findByTestId('tile-trend-1')
    await userEvent.click(screen.getByRole('button', { name: 'Share' }))
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }))

    await userEvent.click(screen.getByRole('button', { name: 'switch project' }))
    expect(await screen.findByTestId('tile-retention-2')).toBeInTheDocument()

    // Reopen the card for project 2's dashboard 7 -- it has no share yet.
    await userEvent.click(screen.getByRole('button', { name: 'Share' }))
    expect(await screen.findByRole('button', { name: 'Create link' })).toBeInTheDocument()

    gate.resolve(SHARE)
    await waitFor(() => expect(client.dashboard).toHaveBeenCalledWith(2, 7))
    // Still no share -- project 1's response never reached project 2's
    // dashboard, even though both are id 7 and the card is open.
    expect(screen.getByRole('button', { name: 'Create link' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Share link' })).toBeNull()
  })
})
