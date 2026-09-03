import { type ReactElement, useEffect, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router'
import { type ApiClient, ApiError } from '../api/client.js'
import { Dashboard } from '../screens/Dashboard.js'
import { DashboardNew } from '../screens/DashboardNew.js'
import { Dashboards } from '../screens/Dashboards.js'
import { Feed } from '../screens/Feed.js'
import { FunnelBuilder } from '../screens/FunnelBuilder.js'
import { FunnelDetail } from '../screens/FunnelDetail.js'
import { Funnels } from '../screens/Funnels.js'
import { People } from '../screens/People.js'
import { Profile } from '../screens/Profile.js'
import { Retention } from '../screens/Retention.js'
import { RetentionReports } from '../screens/RetentionReports.js'
import { SegmentBuilder } from '../screens/SegmentBuilder.js'
import { SegmentDetail } from '../screens/SegmentDetail.js'
import { Segments } from '../screens/Segments.js'
import { Settings } from '../screens/Settings.js'
import { TrendReports } from '../screens/TrendReports.js'
import { Trends } from '../screens/Trends.js'
import { hasRetentionDefinitionParams } from '../screens/retention/params.js'
import { hasTrendDefinitionParams } from '../screens/trends/params.js'
import { useProject } from './ProjectContext.js'
import { Shell } from './Shell.js'

/**
 * The app's client-side paths, named once so `Shell`'s nav links and this
 * file's own `<Route>`s can never drift apart. Every entry is deliberately
 * dot-free in their final segment: `packages/server/src/static.ts` only
 * hands a non-API GET to the SPA when the request's last path segment has
 * no dot in it (`looksLikeFile`) -- a route that violates that 404s on a
 * hard refresh instead of reaching this router at all. A future route added
 * here must keep that property too.
 */
export const ROUTES = {
  dashboards: '/dashboards',
  dashboardNew: '/dashboards/new',
  feed: '/feed',
  settings: '/settings',
  profile: '/profile',
  funnels: '/funnels',
  funnelNew: '/funnels/new',
  segments: '/segments',
  segmentNew: '/segments/new',
  retention: '/retention',
  retentionNew: '/retention/new',
  trends: '/trends',
  trendNew: '/trends/new',
  people: '/people',
} as const

/** Path builders for the parameterised routes. Numeric ids only, so no final
 * segment can ever acquire a dot. */
export const dashboardPath = (id: number) => `/dashboards/${id}`
export const funnelPath = (id: number) => `/funnels/${id}`
export const funnelEditPath = (id: number) => `/funnels/${id}/edit`
export const segmentPath = (id: number) => `/segments/${id}`
export const segmentEditPath = (id: number) => `/segments/${id}/edit`
export const trendReportPath = (id: number) => `/trends/${id}`
export const retentionReportPath = (id: number) => `/retention/${id}`

/**
 * `/` opens the project's home dashboard when one is marked, and the feed
 * otherwise -- a redirect rather than rendering the dashboard in place, so
 * the URL is truthful and the sidebar's active item is honest. Renders
 * nothing while the list loads: rendering the feed first would fire its
 * fetches for a screen about to be replaced. A failed list read falls
 * through to the feed; the feed does not depend on dashboards existing.
 * `/feed` never comes here.
 */
function HomeEntry(props: { client: ApiClient; feed: ReactElement; onUnauthorized?(): void }) {
  const { activeId } = useProject()
  const [home, setHome] = useState<number | null | 'loading'>('loading')
  useEffect(() => {
    if (activeId == null) return
    let cancelled = false
    setHome('loading')
    // `Promise.resolve().then(...)` rather than calling `dashboards`
    // directly: a stub (or a real client's own bug) that throws
    // synchronously instead of returning a rejected promise must land in
    // this same `.catch` rather than escaping the effect and unmounting
    // the tree.
    Promise.resolve()
      .then(() => props.client.dashboards(activeId))
      .then((list) => {
        if (!cancelled) setHome(list.find((d) => d.is_home)?.id ?? null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          props.onUnauthorized?.()
          return
        }
        setHome(null)
      })
    return () => {
      cancelled = true
    }
  }, [props.client, activeId, props.onUnauthorized])
  if (home === 'loading') return null
  if (home === null) return props.feed
  return <Navigate to={dashboardPath(home)} replace />
}

/**
 * `/trends` used to BE the builder; it is now the saved-trend list, and the
 * list never reads the query string. A bookmark or shared link built before
 * this task -- `/trends?event=signup&interval=1d` -- would otherwise open
 * an empty list with no trace of what was asked. This redirects such a URL
 * to `/trends/new`, carrying its search string across untouched, so the
 * link still answers the question it used to; a bare `/trends` (no
 * definition) renders the list as intended.
 *
 * `hasTrendDefinitionParams` is the SAME predicate `Trends.tsx`'s own seed
 * effect uses to decide whether a URL already carries a definition -- reused
 * rather than restated, so there is exactly one notion of "this URL carries
 * a trend" in the codebase.
 */
function TrendsEntry(props: { client: ApiClient; onUnauthorized?(): void }) {
  const [search] = useSearchParams()
  if (hasTrendDefinitionParams(search)) {
    return <Navigate to={{ pathname: ROUTES.trendNew, search: search.toString() }} replace />
  }
  return <TrendReports client={props.client} onUnauthorized={props.onUnauthorized} />
}

/** `/retention`'s counterpart to `TrendsEntry` above, for the same reason and
 * against the same failure -- see that component's own comment. */
function RetentionEntry(props: { client: ApiClient; onUnauthorized?(): void }) {
  const [search] = useSearchParams()
  if (hasRetentionDefinitionParams(search)) {
    return <Navigate to={{ pathname: ROUTES.retentionNew, search: search.toString() }} replace />
  }
  return <RetentionReports client={props.client} onUnauthorized={props.onUnauthorized} />
}

/**
 * Wraps `Shell` in a `BrowserRouter` so the nav's links are real
 * navigation -- back/forward and modifier-click (new-tab) and middle-click
 * come from the library rather than being reinvented (see the task brief
 * this was written from for the "why a library" case). `Feed` answers both
 * `/` and `/feed` so a bare hard refresh at the root still lands on it, and
 * the catch-all keeps an unrecognized client-side path (typo'd or stale)
 * from rendering a blank shell -- the server already hands any non-API GET
 * to the SPA, so this router is the last place that can still decide what
 * shows.
 */
export function AppRouter(props: {
  client: ApiClient
  email: string | null
  onLogout(): void
  onUnauthorized?(): void
  /** Called after the admin's email changes, so `App` can re-read the
   * session it renders the header from -- this screen has just made that
   * value stale, and the server already returns the new one. */
  onEmailChanged?(): void
  /** Called when a completed deletion empties the project list -- threaded
   * straight through to `Settings`, the only screen that can trigger it,
   * matching `onUnauthorized`'s own shape. */
  onSessionStale?(): void
}) {
  const dashboards = <Dashboards client={props.client} onUnauthorized={props.onUnauthorized} />
  const dashboardNew = <DashboardNew client={props.client} onUnauthorized={props.onUnauthorized} />
  const dashboard = <Dashboard client={props.client} onUnauthorized={props.onUnauthorized} />
  const feed = <Feed client={props.client} onUnauthorized={props.onUnauthorized} />
  // IMPORTANT 3 from the whole-branch review: `onUnauthorized` used to be
  // handed only to `Feed` here -- `Settings` has its own two fetches
  // (`GET /v1/project`, `GET /v1/project/usage`) that can 401 exactly the
  // same way, and it is the only screen with no unauthorized detector of
  // its own now that both destinations get one.
  const settings = (
    <Settings
      client={props.client}
      onUnauthorized={props.onUnauthorized}
      onSessionStale={props.onSessionStale}
    />
  )
  const profile = (
    <Profile
      client={props.client}
      email={props.email}
      onEmailChanged={() => props.onEmailChanged?.()}
    />
  )
  const funnels = <Funnels client={props.client} onUnauthorized={props.onUnauthorized} />
  const retentionEntry = (
    <RetentionEntry client={props.client} onUnauthorized={props.onUnauthorized} />
  )
  // Distinct `key`s for the same reason `trendNew`/`trendDetail` carry them
  // below: `<Routes>` reconciles its single child by TYPE AND POSITION, so
  // navigating /retention/7 -> /retention/new would otherwise hand the same
  // `Retention` instance a new route without remounting it, and the builder
  // would open still carrying the report just being viewed. `Retention`
  // itself is unchanged by this task -- it is still entirely
  // URL-search-param-driven -- so this is the only guard against that
  // carry-over until a later task teaches it to load a saved definition by
  // id.
  const retentionNew = (
    <Retention key="retention-new" client={props.client} onUnauthorized={props.onUnauthorized} />
  )
  const retentionDetail = (
    <Retention key="retention-detail" client={props.client} onUnauthorized={props.onUnauthorized} />
  )
  const trendsEntry = <TrendsEntry client={props.client} onUnauthorized={props.onUnauthorized} />
  // Distinct `key`s for the same reason `funnelNew`/`funnelEdit` and
  // `segmentNew`/`segmentEdit` carry them below: `<Routes>` reconciles its
  // single child by TYPE AND POSITION, so navigating /trends/7 -> /trends/new
  // would otherwise hand the same `Trends` instance a new route without
  // remounting it, and the builder would open still carrying the report just
  // being viewed. `Trends` itself is unchanged by this task -- it is still
  // entirely URL-search-param-driven -- so this is the only guard against
  // that carry-over until a later task teaches it to load a saved
  // definition by id.
  const trendNew = (
    <Trends key="trend-new" client={props.client} onUnauthorized={props.onUnauthorized} />
  )
  const trendDetail = (
    <Trends key="trend-detail" client={props.client} onUnauthorized={props.onUnauthorized} />
  )
  // Distinct `key`s for the same reason the segment builders carry them:
  // <Routes> reconciles its single child by TYPE AND POSITION, so navigating
  // /funnels/7/edit -> /funnels/new hands the same component instance a new
  // route without remounting it, and the create form opens carrying the
  // funnel just being edited (#119).
  //
  // DEFENCE IN DEPTH, AND DELIBERATELY UNPINNED. `FunnelBuilder` now resets
  // its own form whenever the address changes, so remounting produces exactly
  // the same observable result and removing these keys leaves the whole suite
  // green -- verified rather than assumed. A test here could only assert an
  // implementation detail (that the instance changed), and the builder's own
  // tests deliberately run WITHOUT keys so they hold the screen to the harder
  // case. The keys stay because a remount is the cheaper guarantee of the two
  // and costs nothing; they are not what makes the behaviour correct.
  const funnelNew = (
    <FunnelBuilder key="funnel-new" client={props.client} onUnauthorized={props.onUnauthorized} />
  )
  const funnelDetail = <FunnelDetail client={props.client} onUnauthorized={props.onUnauthorized} />
  const funnelEdit = (
    <FunnelBuilder key="funnel-edit" client={props.client} onUnauthorized={props.onUnauthorized} />
  )
  const segments = <Segments client={props.client} onUnauthorized={props.onUnauthorized} />
  // `<Routes>` renders the matched route's element as a SINGLE child, which
  // React reconciles by type and key -- with no key, navigating from
  // `/segments/:id/edit` to `/segments/new` keeps the same `SegmentBuilder`
  // instance and all of its state. Distinct keys make that navigation a
  // remount.
  //
  // DEFENCE IN DEPTH, deliberately not the fix. `SegmentBuilder`'s own load
  // effect resets every piece of its state at the start of each identity
  // change and refuses to save from a state it has not loaded, which is
  // what actually closes the edit -> new door; these keys are a second
  // mechanism for the same invariant, and the screen's tests pass with them
  // removed on purpose, so a future reader who deletes them has not
  // reopened anything.
  const segmentNew = (
    <SegmentBuilder key="segment-new" client={props.client} onUnauthorized={props.onUnauthorized} />
  )
  const segmentDetail = (
    <SegmentDetail client={props.client} onUnauthorized={props.onUnauthorized} />
  )
  const segmentEdit = (
    <SegmentBuilder
      key="segment-edit"
      client={props.client}
      onUnauthorized={props.onUnauthorized}
    />
  )
  const people = <People client={props.client} onUnauthorized={props.onUnauthorized} />
  return (
    <BrowserRouter>
      <Shell email={props.email} onLogout={props.onLogout} client={props.client}>
        <Routes>
          <Route
            path="/"
            element={
              <HomeEntry client={props.client} feed={feed} onUnauthorized={props.onUnauthorized} />
            }
          />
          <Route path={ROUTES.feed} element={feed} />
          {/*
           * No `key`s on this pair, unlike the funnel/segment/trend/retention
           * new-vs-detail pairs above: `/dashboards/new` (`DashboardNew`) and
           * `/dashboards/:id` (`Dashboard`) are different
           * component TYPES, so `<Routes>` remounts on navigation between them
           * without help. Keys only earn their place where the same
           * component serves both destinations.
           */}
          <Route path={ROUTES.dashboards} element={dashboards} />
          <Route path={ROUTES.dashboardNew} element={dashboardNew} />
          <Route path="/dashboards/:id" element={dashboard} />
          <Route path={ROUTES.settings} element={settings} />
          <Route path={ROUTES.profile} element={profile} />
          {/*
           * `<Routes>` ranks candidates by path specificity (via
           * `matchRoutes()`), not by declaration order -- verified directly:
           * moving these four funnel routes after the "*" catch-all below
           * still resolves `/funnels` to `funnels`, not `feed`. So JSX order
           * here is for a human reading top to bottom, not for the router.
           * "*" is the fallback for a path nothing else below matches --
           * it deliberately renders `Feed` rather than a blank shell for an
           * unrecognised client-side path (typo'd or stale).
           */}
          <Route path={ROUTES.funnels} element={funnels} />
          <Route path={ROUTES.funnelNew} element={funnelNew} />
          <Route path="/funnels/:id" element={funnelDetail} />
          <Route path="/funnels/:id/edit" element={funnelEdit} />
          <Route path={ROUTES.trends} element={trendsEntry} />
          <Route path={ROUTES.trendNew} element={trendNew} />
          <Route path="/trends/:id" element={trendDetail} />
          <Route path={ROUTES.retention} element={retentionEntry} />
          <Route path={ROUTES.retentionNew} element={retentionNew} />
          <Route path="/retention/:id" element={retentionDetail} />
          <Route path={ROUTES.segments} element={segments} />
          <Route path={ROUTES.segmentNew} element={segmentNew} />
          <Route path="/segments/:id" element={segmentDetail} />
          <Route path="/segments/:id/edit" element={segmentEdit} />
          <Route path={ROUTES.people} element={people} />
          <Route path="*" element={feed} />
        </Routes>
      </Shell>
    </BrowserRouter>
  )
}
