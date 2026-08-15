import { useEffect, useState } from 'react'
import type { ApiClient } from './api/client.js'
import { createClient } from './api/client.js'
import type { Project } from './api/types.js'
import { ProjectProvider } from './app/ProjectContext.js'
import { Shell } from './app/Shell.js'
import { Feed } from './screens/Feed.js'
import { Login } from './screens/Login.js'

interface Session {
  email: string
  projects: Project[]
}

async function loadSession(client: ApiClient, email: string): Promise<Session> {
  const projects = await client.projects()
  return { email, projects }
}

/**
 * `client` is a test seam -- production always falls through to
 * `createClient()`. It is read once via useState's lazy initializer, so a
 * caller that passes a different client on a later render is not expected
 * to be honoured; the app has exactly one client for its lifetime.
 */
export default function App(props: { client?: ApiClient }) {
  const [client] = useState<ApiClient>(() => props.client ?? createClient())
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)

  useEffect(() => {
    let cancelled = false
    client
      .session()
      .then((s) => loadSession(client, s.email))
      .then((loaded) => {
        if (!cancelled) setSession(loaded)
      })
      .catch(() => {
        // Any failure to confirm an existing session -- an explicit 401, a
        // network error, a 5xx -- means there is no session to trust. The
        // login screen is the only safe default; it makes its own,
        // independent check of server reachability via authState().
      })
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
    // `client` never changes identity (see the doc comment above), so this
    // effect still runs exactly once despite listing it as a dependency.
  }, [client])

  function handleSignedIn(email: string) {
    setChecking(true)
    loadSession(client, email)
      .then((loaded) => setSession(loaded))
      .finally(() => setChecking(false))
  }

  function handleLogout() {
    client.logout().finally(() => setSession(null))
  }

  if (checking) return null
  if (!session) return <Login client={client} onSignedIn={handleSignedIn} />

  return (
    <ProjectProvider projects={session.projects} initialId={session.projects[0]?.id ?? null}>
      <Shell email={session.email} onLogout={handleLogout}>
        <Feed client={client} />
      </Shell>
    </ProjectProvider>
  )
}
