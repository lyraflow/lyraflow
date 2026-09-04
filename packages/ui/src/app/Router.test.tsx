import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { type ApiClient, ApiError } from '../api/client.js'
import { ProjectProvider } from './ProjectContext.js'
import { AppRouter } from './Router.js'

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

function renderAt(path: string, overrides: Partial<ApiClient> = {}) {
  window.history.pushState({}, '', path)
  const client = {
    events: vi.fn(async () => ({ events: [], next_cursor: null })),
    rejections: vi.fn(async () => ({ rejections: [], has_more: false, next_offset: 0 })),
    stats: vi.fn(async () => ({ buckets: [] })),
    project: vi.fn(async () => ({ name: 'Alpha', slug: 'alpha', write_key: 'wk_test' })),
    usage: vi.fn(async () => ({
      month: '2026-08',
      events_accepted: 0,
      events_rejected: 0,
      events_throttled: 0,
      events_bot: 0,
      monthly_event_quota: null,
      disabled_at: null,
    })),
    projects: vi.fn(async () => PROJECTS),
    /* Settings' Install card reads the running version on mount. Without
     * this every test that lands on /settings dies inside `AboutSection`,
     * which says nothing about the router. */
    meta: vi.fn(async () => ({ version: '0.10.0' })),
    dashboards: vi.fn(async () => []),
    /* `/dashboards/:id` fetches on mount and can rename, reorder or delete
     * from the same screen; all three are stubbed so a resolution test never
     * reaches an unstubbed method for a reason unrelated to routing. Tiles
     * are empty because this file is asserting which screen the router
     * picked, not what a tile renders. */
    dashboard: vi.fn(async () => ({
      id: 7,
      name: 'Overview',
      tile_count: 0,
      is_home: false,
      definition_version: 1,
      stale: false,
      created_at: '',
      updated_at: '',
      tiles: [],
    })),
    patchDashboard: vi.fn(async () => undefined),
    deleteDashboard: vi.fn(async () => undefined),
    funnels: vi.fn(async () => []),
    segments: vi.fn(async () => []),
    trendReports: vi.fn(async () => []),
    retentionReports: vi.fn(async () => []),
    /* `Trends` (now reachable at /trends/new) renders `EventCombobox`
     * unconditionally, which fetches event-name suggestions on mount --
     * without this, the /trends/new test would hit an unstubbed method
     * inside a timer callback and fail for a reason unrelated to routing. */
    schemaEvents: vi.fn(async () => []),
    ...overrides,
  } as never
  return render(
    <ProjectProvider projects={PROJECTS} initialId={1}>
      <AppRouter client={client} email="admin@localhost" onLogout={vi.fn()} />
    </ProjectProvider>,
  )
}

describe('AppRouter', () => {
  // Task 6: the dashboards list and its create form. Split into two tests
  // rather than the brief's single one -- this file renders once per test
  // (see every other resolution guard below), and a second `renderAt` in
  // the same test would mount a second tree beside the first instead of
  // replacing it.
  it('renders the dashboards list at /dashboards', async () => {
    renderAt('/dashboards')
    expect(await screen.findByRole('heading', { name: /^dashboards$/i })).toBeInTheDocument()
  })

  it('renders the dashboard create form at /dashboards/new', async () => {
    renderAt('/dashboards/new')
    expect(await screen.findByRole('heading', { name: /new dashboard/i })).toBeInTheDocument()
  })

  // Task 9: `/dashboards/:id`. `/dashboards/new` above must keep resolving to
  // the create form rather than to this screen with an id of "new" -- the
  // router ranks by specificity, and both tests here hold that.
  it('renders the dashboard screen at /dashboards/7', async () => {
    renderAt('/dashboards/7')
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
  })

  it('renders the feed at / when no dashboard is home', async () => {
    renderAt('/')
    expect(await screen.findByRole('tab', { name: /accepted/i })).toBeInTheDocument()
  })

  it('redirects / to the home dashboard when one is set, with replace', async () => {
    const historyLengthBefore = window.history.length
    renderAt('/', {
      dashboards: vi.fn(async () => [
        {
          id: 7,
          name: 'Overview',
          tile_count: 0,
          is_home: true,
          definition_version: 1,
          stale: false,
          created_at: '',
          updated_at: '',
        },
      ]),
    })
    expect(await screen.findByRole('heading', { name: /overview/i })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/dashboards/7')
    // +1, not +0: `renderAt` itself pushes the entry for `/` -- the redirect
    // to `/dashboards/7` must add none on top of that. A push instead of a
    // replace here would land on +2.
    expect(window.history.length).toBe(historyLengthBefore + 1)
  })

  it('renders the feed at / when the dashboard list fails to load', async () => {
    renderAt('/', {
      dashboards: vi.fn(async () => {
        throw new Error('network error')
      }),
    })
    expect(await screen.findByRole('tab', { name: /accepted/i })).toBeInTheDocument()
  })

  // A client whose `dashboards` throws synchronously (rather than
  // returning a rejected promise) must not crash `HomeEntry`'s effect --
  // same fall-through as the rejected-promise case above.
  it('renders the feed at / when the dashboard list throws synchronously', async () => {
    renderAt('/', {
      dashboards: vi.fn(() => {
        throw new Error('boom')
      }),
    })
    expect(await screen.findByRole('tab', { name: /accepted/i })).toBeInTheDocument()
  })

  it('/feed is always the feed, even with a home dashboard', async () => {
    renderAt('/feed', {
      dashboards: vi.fn(async () => [
        {
          id: 7,
          name: 'Overview',
          tile_count: 0,
          is_home: true,
          definition_version: 1,
          stale: false,
          created_at: '',
          updated_at: '',
        },
      ]),
    })
    expect(await screen.findByRole('tab', { name: /accepted/i })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/feed')
  })

  // `/dashboards/home` is `HomeEntry` again, with a different fallback: the
  // list rather than the feed. `/dashboards/:id` would otherwise also match
  // this path with `id` "home" -- `dashboardsHome` is declared as a
  // dot-free STATIC segment ahead of it, and `<Routes>` ranks a static
  // segment over a dynamic one regardless of declaration order (see the
  // comment on the funnel routes below), so this proves that ranking rather
  // than assuming it.
  it('/dashboards/home redirects to the home dashboard when one is set, with replace', async () => {
    const historyLengthBefore = window.history.length
    renderAt('/dashboards/home', {
      dashboards: vi.fn(async () => [
        {
          id: 7,
          name: 'Overview',
          tile_count: 0,
          is_home: true,
          definition_version: 1,
          stale: false,
          created_at: '',
          updated_at: '',
        },
      ]),
    })
    expect(await screen.findByRole('heading', { name: /overview/i })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/dashboards/7')
    expect(window.history.length).toBe(historyLengthBefore + 1)
  })

  it('/dashboards/home falls back to the list, not the feed, when no dashboard is home', async () => {
    const client = { dashboard: vi.fn() }
    renderAt('/dashboards/home', client)
    expect(await screen.findByRole('heading', { name: /^dashboards$/i })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/dashboards')
    expect(screen.queryByText(/no longer exists/i)).toBeNull()
    expect(client.dashboard).not.toHaveBeenCalled()
  })

  it('/dashboards/home falls back to the list when the dashboard list fails to load', async () => {
    renderAt('/dashboards/home', {
      dashboards: vi.fn(async () => {
        throw new Error('network error')
      }),
    })
    expect(await screen.findByRole('heading', { name: /^dashboards$/i })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/dashboards')
  })

  // Task 3 replaced the placeholder `Settings` with the real screen (the
  // install snippet and this month's usage) -- the page-level heading is
  // still exactly "Settings", so this assertion needed no change, but it's
  // now asserting on the real screen rather than a stand-in.
  it('renders settings at /settings', async () => {
    renderAt('/settings')
    expect(await screen.findByRole('heading', { name: /^settings$/i })).toBeInTheDocument()
  })

  // A full page reload was the old behaviour and it remounts the whole app,
  // re-running the bounded session check. The router exists to stop that.
  it('navigates between screens without a page load', async () => {
    renderAt('/feed')
    await userEvent.click(screen.getByRole('link', { name: /settings/i }))
    expect(await screen.findByRole('heading', { name: /^settings$/i })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/settings')
  })

  it('marks the current destination for assistive technology', async () => {
    renderAt('/settings')
    const link = await screen.findByRole('link', { name: /settings/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // Small fix from the whole-branch review: `<Route path="/">` renders the
  // same Feed element as `/feed`, but the Feed nav link's own `to="/feed"`
  // never matched `/` -- neither nav item got `aria-current` at the one
  // path every operator lands on right after login (or right after the
  // wizard, which has no route of its own to redirect through). Every
  // other test in this file starts at `/feed` or `/settings`, so this is
  // the one that actually exercises the root.
  it('marks Feed as current at the bare root, not only at /feed', async () => {
    renderAt('/')
    const link = await screen.findByRole('link', { name: /feed/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // An unknown client-side path must not render a blank shell. The server
  // already hands any non-API GET to the SPA, so this is the app's job.
  it('renders the feed for an unknown path rather than nothing', async () => {
    renderAt('/nope')
    expect(await screen.findByRole('tab', { name: /accepted/i })).toBeInTheDocument()
  })

  // Route RESOLUTION, not ordering -- `<Routes>` ranks candidates by path
  // specificity (via `matchRoutes()`), independently of the order `<Route>`s
  // are declared in `Router.tsx`; verified directly by moving the funnel
  // routes after the "*" catch-all and confirming this still passes. What
  // this pins instead: a typo'd `ROUTES.funnels`, a missing `<Route>`, or a
  // `path`/`element` mismatch would all make `/funnels` fall through to the
  // catch-all -- checked as a negative (no Feed tab reachable) alongside the
  // positive (Funnels' own heading), so a component that renders *something*
  // at both destinations can't pass this by accident.
  it('resolves /funnels to Funnels, not the feed catch-all', async () => {
    renderAt('/funnels')
    expect(await screen.findByRole('heading', { name: /^funnels$/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /accepted/i })).not.toBeInTheDocument()
  })

  it('marks Funnels as current at /funnels', async () => {
    renderAt('/funnels')
    const link = await screen.findByRole('link', { name: /funnels/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // There is no declaration-order guarantee to pin
  // (`<Routes>` ranks by path specificity via `matchRoutes()`, verified on
  // the funnels branch by moving routes after the catch-all and watching
  // every test stay green) -- so this pins resolution instead, exactly
  // mirroring the funnels test above: the positive (Segments' own heading)
  // alongside the negative (no Feed tab reachable), so a component that
  // renders *something* at both destinations can't pass by accident.
  it('resolves /segments to Segments, not the feed catch-all', async () => {
    renderAt('/segments')
    expect(await screen.findByRole('heading', { name: /^segments$/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /accepted/i })).not.toBeInTheDocument()
  })

  it('marks Segments as current at /segments', async () => {
    renderAt('/segments')
    const link = await screen.findByRole('link', { name: /segments/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // Task 5: `/trends` used to render the URL-driven builder/viewer directly
  // (`Trends`) -- it now renders the saved-trends list (`TrendReports`)
  // instead, with `Trends` itself moved to `/trends/new` and `/trends/:id`.
  // Both screens share the "Trends" heading, so the heading alone cannot
  // tell them apart -- the list's own "New trend" link and the builder's
  // "Run" control are what distinguish them, checked as a pair in each
  // direction below (same shape as funnels' and segments' own resolution
  // guards: a positive alongside a negative, so a component that renders
  // *something* at both destinations can't pass by accident).
  it('resolves /trends to the saved-trends list, not the builder', async () => {
    renderAt('/trends')
    expect(await screen.findByRole('heading', { name: /^trends$/i })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: /new trend/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /accepted/i })).not.toBeInTheDocument()
  })

  it('marks Trends as current at /trends', async () => {
    renderAt('/trends')
    const link = await screen.findByRole('link', { name: /trends/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // `/trends/new` still resolves to the URL-driven screen -- proves the
  // route was added and points at `Trends`, not left to fall through to the
  // list or the catch-all.
  it('resolves /trends/new to the trend builder, not the list', async () => {
    renderAt('/trends/new')
    expect(await screen.findByRole('heading', { name: /^trends$/i })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^run$/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /new trend/i })).not.toBeInTheDocument()
  })

  // I1 from the whole-branch review: `/trends` used to BE the builder, so a
  // bookmark or shared link built before this task names an event, an
  // interval, a breakdown -- straight in the query string. Repointing
  // `/trends` at the list without teaching it to read that string would
  // open it empty, with no trace of what was asked. `TrendsEntry` forwards
  // a definition-carrying URL to the builder instead, search intact, so
  // the link still answers the question it used to.
  it('forwards a definition-carrying /trends to the builder, search intact', async () => {
    renderAt('/trends?event=signup&interval=1d')
    expect(await screen.findByRole('button', { name: /^run$/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /new trend/i })).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/trends/new')
    expect(window.location.search).toBe('?event=signup&interval=1d')
  })

  // Task 7: `/retention` used to render the URL-driven builder/viewer
  // directly (`Retention`) -- it now renders the saved-retention-reports
  // list (`RetentionReports`) instead, with `Retention` itself moved to
  // `/retention/new` and `/retention/:id`. Both screens share the
  // "Retention" heading, so the heading alone cannot tell them apart -- the
  // list's own "New retention report" link and the builder's "Run" control
  // are what distinguish them, checked as a pair in each direction below,
  // same shape as the trends guard above.
  it('resolves /retention to the saved-retention-reports list, not the builder', async () => {
    renderAt('/retention')
    expect(await screen.findByRole('heading', { name: /^retention$/i })).toBeInTheDocument()
    expect(await screen.findByRole('link', { name: /new retention report/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument()
  })

  it('marks Retention as current at /retention', async () => {
    renderAt('/retention')
    // Anchored, unlike the other nav-current checks above: the page's own
    // "New retention report" link also contains the substring "retention",
    // so a bare /retention/i here matches two elements and
    // `findByRole` throws rather than picking one.
    const link = await screen.findByRole('link', { name: /^retention$/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // `/retention/new` still resolves to the URL-driven screen -- proves the
  // route was added and points at `Retention`, not left to fall through to
  // the list or the catch-all.
  it('resolves /retention/new to the retention builder, not the list', async () => {
    renderAt('/retention/new')
    expect(await screen.findByRole('heading', { name: /^retention$/i })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /^run$/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /new retention report/i })).not.toBeInTheDocument()
  })

  // I1's counterpart for /retention -- see the matching /trends test above
  // for why. A pre-existing bookmark like this one named the two events, the
  // granularity and a `where` clause; the whole point is that it still does.
  it('forwards a definition-carrying /retention to the builder, search intact', async () => {
    renderAt('/retention?start=signed_up&return=project_created&granularity=day')
    expect(await screen.findByRole('button', { name: /^run$/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /new retention report/i })).not.toBeInTheDocument()
    expect(window.location.pathname).toBe('/retention/new')
    expect(window.location.search).toBe('?start=signed_up&return=project_created&granularity=day')
  })

  // Same resolution guard as Funnels' and Segments' own pair above, for the
  // route Task 6 adds. `/people` with no `?id=` renders the lookup state
  // (no fetch to mock), so the plain `renderAt` client above is enough.
  it('resolves /people to People, not the feed catch-all', async () => {
    renderAt('/people')
    expect(await screen.findByRole('heading', { name: /^people$/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /accepted/i })).not.toBeInTheDocument()
  })

  it('marks People as current at /people', async () => {
    renderAt('/people')
    const link = await screen.findByRole('link', { name: /people/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // IMPORTANT 3 from the whole-branch review: `onUnauthorized` used to be
  // handed only to `Feed` -- an admin on `/settings` with an expired
  // session had no unauthorized detector of its own, only `App`'s hour-long
  // session poll. This proves `AppRouter` now wires it into `Settings` too.
  it('hands onUnauthorized to Settings, not only Feed', async () => {
    window.history.pushState({}, '', '/settings')
    const onUnauthorized = vi.fn()
    const client = {
      events: vi.fn(async () => ({ events: [], next_cursor: null })),
      rejections: vi.fn(async () => ({ rejections: [], has_more: false, next_offset: 0 })),
      stats: vi.fn(async () => ({ buckets: [] })),
      project: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
      usage: vi.fn(async () => ({
        month: '2026-08',
        events_accepted: 0,
        events_rejected: 0,
        events_throttled: 0,
        events_bot: 0,
        monthly_event_quota: null,
        disabled_at: null,
      })),
      projects: vi.fn(async () => PROJECTS),
      meta: vi.fn(async () => ({ version: '0.10.0' })),
    } as never
    render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <AppRouter
          client={client}
          email="admin@localhost"
          onLogout={vi.fn()}
          onUnauthorized={onUnauthorized}
        />
      </ProjectProvider>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
  })
})
