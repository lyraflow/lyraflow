import { useEffect, useState } from 'react'
import type { ApiClient } from './api/client.js'
import { ApiError, createClient } from './api/client.js'
import type { Project } from './api/types.js'
import { ProjectProvider } from './app/ProjectContext.js'
import { Shell } from './app/Shell.js'
import { Button } from './components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card.js'
import { Feed } from './screens/Feed.js'
import { Login } from './screens/Login.js'

interface Session {
  email: string
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

async function loadSession(client: ApiClient, email: string): Promise<Session> {
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

  function handleSignedIn(email: string) {
    setPhase({ kind: 'checking' })
    loadSession(client, email)
      .then((loaded) => setPhase({ kind: 'authenticated', session: loaded }))
      .catch(() => setPhase({ kind: 'unavailable' }))
  }

  function handleLogout() {
    client.logout().finally(() => setPhase({ kind: 'anonymous' }))
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
        <Feed client={client} />
      </Shell>
    </ProjectProvider>
  )
}
