import { ProjectProvider } from './app/ProjectContext.js'
import { Shell } from './app/Shell.js'

// Placeholder wiring: real projects/session/logout arrive in Tasks 5 and 6,
// which add the login flow and mount the actual screens inside this shell.
const PLACEHOLDER_PROJECT = {
  id: 1,
  name: 'Cem Demo',
  slug: 'cem-demo',
  created_at: '',
  retention_months: 24,
  monthly_event_quota: null,
}

export default function App() {
  return (
    <ProjectProvider projects={[PLACEHOLDER_PROJECT]} initialId={PLACEHOLDER_PROJECT.id}>
      <Shell email="admin@localhost" onLogout={() => {}}>
        <p className="text-muted-foreground">The interface is being built.</p>
      </Shell>
    </ProjectProvider>
  )
}
