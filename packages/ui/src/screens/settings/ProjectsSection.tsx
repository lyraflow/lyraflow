import { useEffect, useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { CreatedProject, Project } from '../../api/types.js'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { Skeleton } from '../../components/ui/skeleton.js'

type Mode = 'idle' | 'form' | 'created'

/**
 * The full project list plus "create a new one" -- the only place in the
 * app a project's server key is ever visible.
 *
 * The list is fetched here rather than read from `useProject()`'s context:
 * that context has no way to add a freshly-created project to itself (it
 * only merges a patch into an existing row), and there is no other screen
 * in this task that owns re-fetching the authoritative list. Refetching
 * after a successful create is what makes the new project appear without
 * a full page reload.
 */
export function ProjectsSection(props: { client: ApiClient }) {
  const { client } = props
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [listError, setListError] = useState(false)

  const [mode, setMode] = useState<Mode>('idle')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createdProject, setCreatedProject] = useState<CreatedProject | null>(null)

  useEffect(() => {
    let cancelled = false
    client
      .projects()
      .then((list) => {
        if (!cancelled) setProjects(list)
      })
      .catch(() => {
        if (!cancelled) setListError(true)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  function openForm() {
    setCreateError(null)
    setName('')
    setMode('form')
  }

  function cancelForm() {
    setCreateError(null)
    setName('')
    setMode('idle')
  }

  async function handleCreate() {
    setCreateError(null)
    const trimmed = name.trim()
    if (trimmed === '') {
      setCreateError('Project name is required.')
      return
    }
    setCreating(true)
    try {
      const created = await client.createProject(trimmed)
      setCreatedProject(created)
      setMode('created')
      // Best effort -- the create itself already succeeded, and a failed
      // refresh here must not hide the one-time keys panel above. The
      // person can always reload to see the list catch up.
      try {
        const fresh = await client.projects()
        setProjects(fresh)
      } catch {
        /* the list will be stale until the next successful fetch */
      }
    } catch (err) {
      // The API slugifies the name, so "My App" and "my app" collide even
      // though neither is literally the other. This is the ordinary
      // outcome of that, not a system failure -- report it plainly and
      // leave what was typed in place so it can be edited, not retyped.
      if (err instanceof ApiError && err.status === 409) {
        setCreateError(`A project named "${trimmed}" already exists.`)
      } else {
        setCreateError('Could not create the project. Try again.')
      }
    } finally {
      setCreating(false)
    }
  }

  function dismissKeys() {
    setCreatedProject(null)
    setMode('idle')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Projects</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {listError && (
          <p role="alert" className="text-sm text-destructive">
            Could not load the project list. Reload to try again.
          </p>
        )}

        {projects == null ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <ul className="flex flex-col gap-1">
            {projects.map((p) => (
              <li key={p.id} className="text-sm text-foreground">
                {p.name}
              </li>
            ))}
          </ul>
        )}

        {mode === 'created' && createdProject && (
          // An inline panel, not a dialog -- deliberately. The server key
          // below exists nowhere else, ever: only its SHA-256 is stored,
          // so this is the one moment it can be captured, and a panel a
          // reflexive Escape or outside click can dismiss would lose it
          // for someone. This stays until the explicit button below is
          // clicked; there is no other way to close it.
          <div
            data-testid="created-project-keys"
            className="flex flex-col gap-3 rounded-md border border-warning bg-muted p-4"
          >
            <p className="text-sm font-medium text-foreground">
              Project &quot;{createdProject.name}&quot; created.
            </p>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Write key</span>
              <code className="break-all font-mono text-xs text-foreground">
                {createdProject.write_key}
              </code>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Server key</span>
              <code className="break-all font-mono text-xs text-foreground">
                {createdProject.server_key}
              </code>
            </div>
            <p className="text-sm text-destructive">
              Copy the server key now -- it will not be shown again. Only its hash is stored, so it
              cannot be recovered later; losing it means creating a new project.
            </p>
            <div>
              <Button type="button" size="sm" onClick={dismissKeys}>
                I&apos;ve saved these keys
              </Button>
            </div>
          </div>
        )}

        {mode === 'idle' && (
          <div>
            <Button type="button" size="sm" onClick={openForm}>
              New project
            </Button>
          </div>
        )}

        {mode === 'form' && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="settings-new-project-name">Name</Label>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                id="settings-new-project-name"
                className="max-w-64"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={creating}
              />
              <Button type="button" size="sm" onClick={handleCreate} disabled={creating}>
                Create
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={cancelForm}
                disabled={creating}
              >
                Cancel
              </Button>
            </div>
            {createError && (
              <p role="alert" className="text-sm text-destructive">
                {createError}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
