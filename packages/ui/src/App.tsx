import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from './api/client.js'
import { ApiError, createClient } from './api/client.js'
import type { Project } from './api/types.js'
import { ProjectProvider } from './app/ProjectContext.js'
import { AppRouter } from './app/Router.js'
import { applyTheme, readStoredTheme } from './app/ThemeToggle.js'
import { Button } from './components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js'
import { Login } from './screens/Login.js'
import { Wizard } from './screens/Wizard.js'

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
 *
 * `sessionPollIntervalMs` is a test seam too, for the same reason `Feed`'s
 * `pollIntervalMs` is (`screens/Feed.tsx`): CI found this the hard way --
 * a test that drove the production 1-hour default through
 * `vi.advanceTimersByTimeAsync` timed out on a constrained runner even
 * though it passed locally, because `shouldAdvanceTime: true` keeps the
 * fake clock moving in REAL time too, and simulating an hour of callbacks
 * is not free no matter how fast the assertions themselves are. A caller
 * that needs a fast cycle now passes a small value instead of the test
 * simulating a large span of time; see `App.test.tsx`'s tests for the
 * mechanism, and its separate constant-only assertion for the production
 * default, which no timer ever has to prove.
 */
export default function App(props: { client?: ApiClient; sessionPollIntervalMs?: number }) {
  const [client] = useState<ApiClient>(() => props.client ?? createClient())
  const sessionPollIntervalMs = props.sessionPollIntervalMs ?? SESSION_POLL_INTERVAL_MS
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
  //
  // A settle-then-reschedule chain, matching `usePolling`'s own discipline
  // (`screens/feed/usePolling.ts`) -- the whole-branch review's own
  // observation: this used to be a bare `setInterval`, which keeps firing
  // on the wall clock regardless of how long the previous `session()` call
  // is taking. A call that outran its interval could in principle stack.
  // `setTimeout` rescheduled only after the previous call settles closes
  // that the same way `usePolling` already does, so the app has one
  // polling discipline rather than two. Unlike `usePolling`, this does NOT
  // call `session()` immediately on effect start -- the mount-time check
  // above already did that; an immediate second call here would be
  // redundant and would also change what `App.test.tsx`'s call-count
  // assertions are pinning.
  useEffect(() => {
    if (phase.kind !== 'authenticated') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    function scheduleNext() {
      if (!cancelled) timer = setTimeout(tick, sessionPollIntervalMs)
    }

    async function tick() {
      try {
        await client.session()
        scheduleNext()
      } catch (err) {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          // The session is definitively gone -- no point rescheduling
          // another poll against it.
          setPhase({ kind: 'anonymous' })
          return
        }
        // A transient failure (a passing 5xx, a network blip): try again
        // next tick rather than giving up the renewal loop entirely.
        scheduleNext()
      }
    }

    scheduleNext()

    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [phase.kind, client, sessionPollIntervalMs])

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
  //
  // `useCallback` with NO dependencies, and it is not a micro-optimisation.
  // This is handed down as `onUnauthorized`, and `HomeEntry`, `Dashboard`
  // and `Feed` all list that callback in their load effects. As a plain
  // function declaration it was a new identity on every render of App, so
  // any state change up here re-fired all three -- dropping a dashboard's
  // tiles to skeletons and re-running the page. Both `DashboardTile` and
  // `AddTilePicker` leave `onUnauthorized` out of their own dependencies
  // precisely to survive a parent like that; the screens above them do not,
  // and this is the end of the chain that can actually be fixed.
  // `setPhase` is a state setter, so the identity is stable with no
  // dependencies at all.
  const handleSessionExpired = useCallback(() => {
    setPhase({ kind: 'anonymous' })
  }, [])

  function handleRetry() {
    setPhase({ kind: 'checking' })
    setRetryToken((t) => t + 1)
  }

  if (phase.kind === 'checking') return <BootScreen />
  if (phase.kind === 'unavailable') return <Unavailable onRetry={handleRetry} />
  if (phase.kind === 'anonymous') return <Login client={client} onSignedIn={handleSignedIn} />

  const { session } = phase

  // A full-screen takeover, not a route -- rendered INSTEAD OF the normal
  // shell, because nothing in the shell is useful with no project yet: a
  // project switcher with no project to switch to, and navigation to an
  // empty feed, are noise at the one moment the operator needs a single
  // obvious next step. This also means the wizard can never be reached by
  // URL once a project exists -- there is no route for it, only this
  // phase check.
  if (session.projects.length === 0) {
    return (
      <Wizard
        client={client}
        onReady={() => {
          // Re-fetches the project list and falls through to the normal
          // app on success. On failure, `unavailable` -- the same outcome
          // `handleSignedIn` uses for the equivalent load right after
          // signing in -- rather than leaving the operator stuck on a
          // wizard whose own job is already done.
          loadSession(client, session.email)
            .then((loaded) => setPhase({ kind: 'authenticated', session: loaded }))
            .catch(() => setPhase({ kind: 'unavailable' }))
        }}
      />
    )
  }

  return (
    <ProjectProvider projects={session.projects} initialId={session.projects[0]?.id ?? null}>
      <AppRouter
        client={client}
        email={session.email}
        onLogout={handleLogout}
        onUnauthorized={handleSessionExpired}
        onSessionStale={() => {
          // The project list changed underneath the shell in a way the shell
          // cannot represent -- today, the last project was destroyed. The
          // wizard-or-shell decision lives HERE, above ProjectProvider, so
          // the fix is to re-read the session and let that decision run
          // again rather than teach a screen below it to render an install
          // with no projects.
          loadSession(client, session.email)
            .then((loaded) => setPhase({ kind: 'authenticated', session: loaded }))
            .catch(() => setPhase({ kind: 'unavailable' }))
        }}
        // Re-read rather than patched in place: the header renders `email`
        // from this state, and `GET /v1/auth/session` is the thing that
        // knows what was actually stored -- taking the profile screen's
        // word for it would be two sources for one value. A failure here is
        // deliberately silent: the change already succeeded, and the only
        // consequence is a header showing the old address until the next
        // load, which is not worth an error banner over a saved change.
        onEmailChanged={() => {
          client
            .session()
            .then((s) =>
              // The PROJECTS are kept, not re-fetched: they did not change,
              // and replacing them from a second request would race
              // `ProjectContext`'s own additive edits (#89).
              setPhase({ kind: 'authenticated', session: { ...session, email: s.email } }),
            )
            .catch(() => {})
        }}
      />
    </ProjectProvider>
  )
}
