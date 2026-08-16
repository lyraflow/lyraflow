import { useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { CreatedProject } from '../../api/types.js'
import { useProject } from '../../app/ProjectContext.js'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'

type Mode = 'idle' | 'form' | 'created'

/**
 * The full project list plus "create a new one" -- the only place in the
 * app a project's server key is ever visible.
 *
 * The list itself is read from `useProject()`'s context, not a component-
 * local fetch: the header switcher (`Shell.tsx`'s `ProjectSwitcher`) reads
 * the same context, and two independently-fetched copies of "the projects"
 * is exactly the failure this app treats as worst on this screen -- the
 * header naming one project while the data underneath answers to another,
 * with neither looking wrong on its own. A successful create can't just
 * merge into context via `updateProject` (that only patches an existing
 * row by id), so it hands the create response straight to `addProject`
 * instead -- one source of truth, one write path.
 *
 * Deliberately NOT a re-fetch-and-replace (#89): `POST /v1/projects` now
 * returns every field a `Project` needs (`CreatedProject`, `api/types.ts`),
 * so there is nothing left to fetch. A `GET /v1/projects` issued here could
 * still be in flight when a concurrent `PATCH /v1/project` (this same
 * screen's own limits form) commits, and its stale response -- fetched
 * before that PATCH landed -- would win a whole-list replace even though
 * `updateProject`'s merge already applied the newer value.
 */
export function ProjectsSection(props: { client: ApiClient }) {
  const { client } = props
  const { projects, addProject } = useProject()

  const [mode, setMode] = useState<Mode>('idle')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createdProject, setCreatedProject] = useState<CreatedProject | null>(null)

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
      // Additive, straight from the create response -- no re-fetch. It
      // already carries every field a `Project` needs, so this is what
      // makes the header switcher (and this list) see the new project
      // without a reload, and without a `GET /v1/projects` that could race
      // a concurrent limits save (#89).
      addProject(created)
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
        <ul className="flex flex-col gap-1">
          {projects.map((p) => (
            <li key={p.id} className="text-sm text-foreground">
              {p.name}
            </li>
          ))}
        </ul>

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
