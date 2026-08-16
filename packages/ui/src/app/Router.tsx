import { BrowserRouter, Route, Routes } from 'react-router'
import type { ApiClient } from '../api/client.js'
import { Feed } from '../screens/Feed.js'
import { FunnelBuilder } from '../screens/FunnelBuilder.js'
import { FunnelDetail } from '../screens/FunnelDetail.js'
import { Funnels } from '../screens/Funnels.js'
import { SegmentBuilder } from '../screens/SegmentBuilder.js'
import { SegmentDetail } from '../screens/SegmentDetail.js'
import { Segments } from '../screens/Segments.js'
import { Settings } from '../screens/Settings.js'
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
  feed: '/feed',
  settings: '/settings',
  funnels: '/funnels',
  funnelNew: '/funnels/new',
  segments: '/segments',
  segmentNew: '/segments/new',
} as const

/** Path builders for the parameterised routes. Numeric ids only, so no final
 * segment can ever acquire a dot. */
export const funnelPath = (id: number) => `/funnels/${id}`
export const funnelEditPath = (id: number) => `/funnels/${id}/edit`
export const segmentPath = (id: number) => `/segments/${id}`
export const segmentEditPath = (id: number) => `/segments/${id}/edit`

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
}) {
  const feed = <Feed client={props.client} onUnauthorized={props.onUnauthorized} />
  // IMPORTANT 3 from the whole-branch review: `onUnauthorized` used to be
  // handed only to `Feed` here -- `Settings` has its own two fetches
  // (`GET /v1/project`, `GET /v1/project/usage`) that can 401 exactly the
  // same way, and it is the only screen with no unauthorized detector of
  // its own now that both destinations get one.
  const settings = <Settings client={props.client} onUnauthorized={props.onUnauthorized} />
  const funnels = <Funnels client={props.client} onUnauthorized={props.onUnauthorized} />
  const funnelNew = <FunnelBuilder client={props.client} onUnauthorized={props.onUnauthorized} />
  const funnelDetail = <FunnelDetail client={props.client} onUnauthorized={props.onUnauthorized} />
  const funnelEdit = <FunnelBuilder client={props.client} onUnauthorized={props.onUnauthorized} />
  const segments = <Segments client={props.client} onUnauthorized={props.onUnauthorized} />
  const segmentNew = <SegmentBuilder client={props.client} onUnauthorized={props.onUnauthorized} />
  const segmentDetail = (
    <SegmentDetail client={props.client} onUnauthorized={props.onUnauthorized} />
  )
  const segmentEdit = <SegmentBuilder client={props.client} onUnauthorized={props.onUnauthorized} />
  return (
    <BrowserRouter>
      <Shell email={props.email} onLogout={props.onLogout}>
        <Routes>
          <Route path="/" element={feed} />
          <Route path={ROUTES.feed} element={feed} />
          <Route path={ROUTES.settings} element={settings} />
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
          <Route path={ROUTES.segments} element={segments} />
          <Route path={ROUTES.segmentNew} element={segmentNew} />
          <Route path="/segments/:id" element={segmentDetail} />
          <Route path="/segments/:id/edit" element={segmentEdit} />
          <Route path="*" element={feed} />
        </Routes>
      </Shell>
    </BrowserRouter>
  )
}
