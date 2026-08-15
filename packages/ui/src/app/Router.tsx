import { BrowserRouter, Route, Routes } from 'react-router'
import type { ApiClient } from '../api/client.js'
import { Feed } from '../screens/Feed.js'
import { Settings } from '../screens/Settings.js'
import { Shell } from './Shell.js'

/**
 * The app's client-side paths, named once so `Shell`'s nav links and this
 * file's own `<Route>`s can never drift apart. Both entries are deliberately
 * dot-free in their final segment: `packages/server/src/static.ts` only
 * hands a non-API GET to the SPA when the request's last path segment has
 * no dot in it (`looksLikeFile`) -- a route that violates that 404s on a
 * hard refresh instead of reaching this router at all. A future route added
 * here must keep that property too.
 */
export const ROUTES = {
  feed: '/feed',
  settings: '/settings',
} as const

/**
 * Wraps `Shell` in a `BrowserRouter` so the nav's links are real
 * navigation -- back/forward, modifier-click, middle-click and scroll
 * position all come from the library rather than being reinvented (see the
 * task brief this was written from for the "why a library" case). `Feed`
 * answers both `/` and `/feed` so a bare hard refresh at the root still
 * lands on it, and the catch-all keeps an unrecognized client-side path
 * (typo'd or stale) from rendering a blank shell -- the server already
 * hands any non-API GET to the SPA, so this router is the last place that
 * can still decide what shows.
 */
export function AppRouter(props: {
  client: ApiClient
  email: string | null
  onLogout(): void
  onUnauthorized?(): void
}) {
  const feed = <Feed client={props.client} onUnauthorized={props.onUnauthorized} />
  return (
    <BrowserRouter>
      <Shell email={props.email} onLogout={props.onLogout}>
        <Routes>
          <Route path="/" element={feed} />
          <Route path={ROUTES.feed} element={feed} />
          <Route path={ROUTES.settings} element={<Settings />} />
          <Route path="*" element={feed} />
        </Routes>
      </Shell>
    </BrowserRouter>
  )
}
