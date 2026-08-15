import { useEffect, useState } from 'react'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { ProjectIdentity, Usage } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { LimitsSection } from './settings/LimitsSection.js'
import { ProjectsSection } from './settings/ProjectsSection.js'
import { SnippetSection } from './settings/SnippetSection.js'
import { UsageSection } from './settings/UsageSection.js'

/**
 * The install snippet, this month's usage, the editable limits for the
 * active project, and the project list with create-a-new-one.
 */
export function Settings(props: {
  client: ApiClient
  /**
   * Called when either of this screen's own fetches comes back 401 --
   * IMPORTANT 3 from the whole-branch review. `AppRouter` used to hand
   * `onUnauthorized` only to `Feed`, and `Feed` is the only screen that
   * polls, so an admin sitting on `/settings` with an expired session had
   * no unauthorized detector of its own -- only `App`'s hour-long session
   * poll would eventually notice, versus the 3-second poll interval that
   * bounces `/feed` to login. Optional so every existing test that doesn't
   * care about this path keeps working unchanged, matching `Feed`'s own
   * `onUnauthorized` prop.
   */
  onUnauthorized?: () => void
}) {
  const { client, onUnauthorized } = props
  const { activeId, projects, updateProject } = useProject()
  // The identity fields (write key) come from their own fetch below --
  // `ProjectIdentity` doesn't carry retention/quota. Those live on the
  // `Project` row context already holds, which is also what a successful
  // limits save writes back to via `updateProject`.
  const activeProject = activeId == null ? null : (projects.find((p) => p.id === activeId) ?? null)
  const [project, setProject] = useState<ProjectIdentity | null>(null)
  const [usage, setUsage] = useState<Usage | null>(null)
  // Neither fetch's fake in the test suite ever rejects, and a real one
  // can: an expired session or a flaky proxy on `GET /v1/project` must not
  // leave this screen showing an empty skeleton forever with an unhandled
  // rejection in the console.
  const [error, setError] = useState(false)

  useEffect(() => {
    if (activeId == null) return
    let cancelled = false
    setProject(null)
    setUsage(null)
    setError(false)
    // A 401 from either fetch means the session is gone, exactly as `Feed`
    // treats a 401 from any of ITS three polled endpoints -- reported via
    // `onUnauthorized` instead of the generic error banner below, which
    // would otherwise read as a transient hiccup forever with no route back
    // to login.
    client
      .project(activeId)
      .then((p) => {
        if (!cancelled) setProject(p)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setError(true)
      })
    client
      .usage(activeId)
      .then((u) => {
        if (!cancelled) setUsage(u)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, onUnauthorized])

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          Could not load this project&apos;s settings. Reload to try again.
        </p>
      )}

      <SnippetSection writeKey={project?.write_key ?? null} />
      {/* `quota` comes from context (`activeProject`), NOT `usage` -- see
       * `UsageSection`'s own doc comment (IMPORTANT 1 from the whole-branch
       * review). `updateProject` (below, via `LimitsSection.onSaved`)
       * updates this synchronously on save; `usage` only refreshes on the
       * next `[client, activeId]` fetch, which a quota save does not
       * trigger. Reading the quota from context keeps this card from ever
       * showing a value that disagrees with what was just saved. */}
      <UsageSection usage={usage} quota={activeProject?.monthly_event_quota ?? null} />
      <LimitsSection
        key={activeId ?? 'none'}
        client={client}
        project={activeProject}
        onSaved={(patch) => {
          if (activeId != null) updateProject(activeId, patch)
        }}
      />
      <ProjectsSection client={client} />
    </div>
  )
}
