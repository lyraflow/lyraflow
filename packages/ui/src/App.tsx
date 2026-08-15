import { useEffect, useState } from 'react'
import type { ApiClient } from './api/client.js'
import { ApiError, createClient } from './api/client.js'
import type { Project } from './api/types.js'
import { ProjectProvider } from './app/ProjectContext.js'
import { Shell } from './app/Shell.js'
import { applyTheme, readStoredTheme } from './app/ThemeToggle.js'
import { Button } from './components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js'
import { Feed } from './screens/Feed.js'
import { Login } from './screens/Login.js'

interface Session {
  // MINOR from the whole-branch review: `GET /v1/auth/session` can answer
  // `{ email: null }` when the admin row itself is gone (the session cookie
  // is still valid, but the row it names is not) -- `ApiClient.session()`
  // used to type this `string` unconditionally, which was simply false for
  // that response, and `Shell` rendered it with no null check at all.
  email: string | null
  projects: Project[]
}

/**
 * The four things this screen can be showing, as one value rather than
 * several booleans that could disagree with each other (a `checking` flag
 * next to a `session` next to an `unavailable` flag can each be set
 * independently, and "checking AND unavailable AND has a session" is not a
 * state this app is ever supposed to reach but a boolean trio cannot rule
 * out on its own).
 */
type Phase =
  | { kind: 'checking' }
  | { kind: 'unavailable' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; session: Session }

async function loadSession(client: ApiClient, email: string | null): Promise<Session> {
  const projects = await client.projects()
  return { email, projects }
}

/**
 * Bounds the initial session check. Without this, a server that accepts the
 * connection and never answers -- as distinct from one that answers with an
 * error -- leaves `phase` at `checking` forever, and the screen stays on
 * the loading state with no indication anything is wrong. Long enough that
 * an ordinary slow response on a modest connection is never cut off short;
 * short enough that a person is not left watching a spinner for a length of
 * time they'd reasonably give up on first.
 */
export const SESSION_CHECK_TIMEOUT_MS = 8000

/**
 * Critical 2 from the whole-branch review. Before this, nothing in
 * `packages/ui` ever called `session()` again after mount -- the sliding
 * 30-day window the design spec requires ("The SPA must poll it") was dead
 * code from the UI's side, and an admin who only ever touched
 * project-scoped routes (the feed) was logged out at 30 days regardless of
 * activity. `sessions.ts` (server) only slides `expires_at` inside the
 * LAST 7 days of that 30-day window (`SESSION_RENEW_WITHIN_MS`), so this
 * interval only needs to land comfortably more than once inside that
 * 7-day renewal window, not to be frequent in any absolute sense -- once an
 * hour does that with enormous margin while costing one request an hour
 * per open tab.
 */
export const SESSION_POLL_INTERVAL_MS = 60 * 60 * 1000

function BootScreen() {
  return (
    <div className="flex h-dvh items-center justify-center bg-background p-4 text-foreground">
      <p className="text-sm text-muted-foreground">Loading…</p>
    </div>
  )
}

function Unavailable(props: { onRetry(): void }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Lyraflow is not responding</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p role="alert">
            The server did not respond. It may be restarting or temporarily unavailable.
          </p>
          <Button type="button" className="w-full" onClick={props.onRetry}>
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * `client` is a test seam -- production always falls through to
 * `createClient()`. It is read once via useState's lazy initializer, so a
 * caller that passes a different client on a later render is not expected
 * to be honoured; the app has exactly one client for its lifetime.
 */
export default function App(props: { client?: ApiClient }) {
  const [client] = useState<ApiClient>(() => props.client ?? createClient())
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' })
  // Bumped by the "Try again" button to force the check effect below to
  // re-run even though `client` itself never changes identity.
  const [retryToken, setRetryToken] = useState(0)

  // Applies the stored theme choice at app start, before authentication.
  // MINOR from the whole-branch review: `ThemeToggle` previously only
  // mounted inside `Shell`, so an explicit light/dark choice was ignored on
  // the login, boot and unavailable screens -- all three fell back to the
  // system preference no matter what an admin had picked last time.
  useEffect(() => {
    applyTheme(readStoredTheme())
  }, [])

  // `retryToken` is deliberately unused inside the effect body below -- it
  // exists only to force this effect to re-run on retry, since `client`
  // itself never changes identity (see the doc comment on `App` above).
  // Removing it from the dependency array is exactly the bug it exists to
  // prevent: "Try again" would stop doing anything.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    let cancelled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (!cancelled) setPhase({ kind: 'unavailable' })
    }, SESSION_CHECK_TIMEOUT_MS)

    client
      .session()
      .then((s) => loadSession(client, s.email))
      .then((loaded) => {
        if (!cancelled && !timedOut) setPhase({ kind: 'authenticated', session: loaded })
      })
      .catch((err: unknown) => {
        if (cancelled || timedOut) return
        // A 401 is the ordinary, expected outcome for a browser with no
        // session yet (or an expired one) -- the only case that should
        // reach the login form. Anything else -- a 5xx, a network failure
        // that never got an HTTP response at all -- means the server
        // itself could not be confirmed reachable, and bouncing to a login
        // form in that state teaches the user nothing until they have
        // already typed a password and watched it fail too. This is the
        // only place that distinction is made: `Login`'s own `authState()`
        // check has no independent reachability signal of its own and
        // falls through to its form on any failure, by design (see its own
        // comment).
        if (err instanceof ApiError && err.status === 401) {
          setPhase({ kind: 'anonymous' })
        } else {
          setPhase({ kind: 'unavailable' })
        }
      })
      .finally(() => {
        clearTimeout(timer)
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `client` never changes identity (see the doc comment above); this
    // effect re-runs on a `client` it already had only via `retryToken`.
  }, [client, retryToken])

  // Critical 2's other half. Polls `GET /v1/auth/session` on its own
  // interval once authenticated, independently of the feed's own polling
  // (`Feed`'s `onUnauthorized` covers the other trigger for the same
  // transition below) -- this is the ONLY caller that renews an admin who
  // never touches a project-scoped route at all. A 401 means the session
  // is gone and the SPA must hand off to the login screen exactly as it
  // does when a feed poll 401s; any other failure (a passing 5xx, a
  // network blip) is left for the next tick rather than bouncing to login
  // on what may be a transient hiccup.
  useEffect(() => {
    if (phase.kind !== 'authenticated') return
    const timer = setInterval(() => {
      client.session().catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          setPhase({ kind: 'anonymous' })
        }
      })
    }, SESSION_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [phase.kind, client])

  function handleSignedIn(email: string) {
    setPhase({ kind: 'checking' })
    loadSession(client, email)
      .then((loaded) => setPhase({ kind: 'authenticated', session: loaded }))
      .catch(() => setPhase({ kind: 'unavailable' }))
  }

  function handleLogout() {
    client.logout().finally(() => setPhase({ kind: 'anonymous' }))
  }

  // The other trigger for the same transition as the session-poll effect
  // above: any of the feed's own polled endpoints coming back 401. No
  // `client.logout()` call here -- unlike `handleLogout`, the session is
  // already gone server-side; there is nothing left to ask it to end.
  function handleSessionExpired() {
    setPhase({ kind: 'anonymous' })
  }

  function handleRetry() {
    setPhase({ kind: 'checking' })
    setRetryToken((t) => t + 1)
  }

  if (phase.kind === 'checking') return <BootScreen />
  if (phase.kind === 'unavailable') return <Unavailable onRetry={handleRetry} />
  if (phase.kind === 'anonymous') return <Login client={client} onSignedIn={handleSignedIn} />

  const { session } = phase
  return (
    <ProjectProvider projects={session.projects} initialId={session.projects[0]?.id ?? null}>
      <Shell email={session.email} onLogout={handleLogout}>
        <Feed client={client} onUnauthorized={handleSessionExpired} />
      </Shell>
    </ProjectProvider>
  )
}
