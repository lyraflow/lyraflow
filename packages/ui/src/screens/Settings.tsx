import { useEffect, useState } from 'react'
import type { ApiClient } from '../api/client.js'
import type { ProjectIdentity, Usage } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { SnippetSection } from './settings/SnippetSection.js'
import { UsageSection } from './settings/UsageSection.js'

/**
 * The install snippet and this month's usage, for the active project.
 * Editing project details and creating a new project are later tasks --
 * these two sections are read-only.
 */
export function Settings(props: { client: ApiClient }) {
  const { client } = props
  const { activeId } = useProject()
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
    client
      .project(activeId)
      .then((p) => {
        if (!cancelled) setProject(p)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    client
      .usage(activeId)
      .then((u) => {
        if (!cancelled) setUsage(u)
      })
      .catch(() => {
        if (!cancelled) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId])

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <h1 className="text-lg font-semibold">Settings</h1>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          Could not load this project&apos;s settings. Reload to try again.
        </p>
      )}

      <SnippetSection writeKey={project?.write_key ?? null} />
      <UsageSection usage={usage} />
    </div>
  )
}
