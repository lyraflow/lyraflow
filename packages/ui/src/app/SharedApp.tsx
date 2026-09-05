import { useEffect, useState } from 'react'
import type { ApiClient } from '../api/client.js'
import { createClient } from '../api/client.js'
import { SharedDashboard } from '../screens/SharedDashboard.js'
import { applyTheme, readStoredTheme } from './ThemeToggle.js'
import { applyPalette, readStoredPalette } from './palette.js'

/**
 * The second entry point: the whole app a person holding a share link gets.
 *
 * The one thing it must never do is what `App` does first -- call
 * `GET /v1/auth/session`. A viewer has no session, so that request answers
 * 401 and `App` shows the login form, which is the wrong screen for
 * somebody who was sent a link to a dashboard. `main.tsx` chooses between
 * the two off the pathname BEFORE React mounts (`app/entry.ts`), so the
 * request is never made rather than made and then ignored. `SharedApp.test.tsx`
 * pins that by handing in a client whose `session` throws.
 *
 * No router, no `ProjectProvider`, no `Shell`: there is exactly one screen
 * here, it names no project, and every destination the shell offers is
 * behind the login this viewer does not have. `useSharedRange` writes the
 * range straight to the URL with `history.replaceState` for the same reason.
 *
 * `client` is a test seam, read once through `useState`'s lazy initialiser
 * -- production always falls through to `createClient()`, exactly as `App`
 * does.
 */
export function SharedApp(props: { token: string; client?: ApiClient }) {
  const [client] = useState<ApiClient>(() => props.client ?? createClient())

  // The stored theme and palette are this browser's, chosen on some other
  // page of this install (a self-hoster looking at their own share link is
  // the ordinary case). `App` applies both before authentication for the
  // same reason -- a login screen drawn in the wrong appearance is the bug
  // that taught it -- and this page has no `Shell`, so nothing else here
  // would ever apply them.
  useEffect(() => {
    applyTheme(readStoredTheme())
    applyPalette(readStoredPalette())
  }, [])

  return <SharedDashboard client={client} token={props.token} />
}
