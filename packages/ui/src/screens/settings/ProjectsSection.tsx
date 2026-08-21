import { useCallback, useEffect, useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { CreatedProject, Project } from '../../api/types.js'
import { useProject } from '../../app/ProjectContext.js'
import { Button } from '../../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'

type Mode = 'idle' | 'form' | 'created'

/**
 * One project, with the two things that can be done to it.
 *
 * Its own component because each row carries independent state -- one row
 * being renamed while another is being archived is the ordinary case on an
 * install with several sites, and a single set of "editing"/"busy" flags in
 * the parent would make those two rows fight over them.
 *
 * The write goes through `client.updateProject` and the ANSWER is merged
 * into context, never the optimistic value: `PATCH` returns the stored row,
 * so merging the response is what keeps the header switcher and this list
 * agreeing with what was actually saved. Same reasoning the create flow
 * gives for handing its response to `addProject` rather than re-fetching.
 */
function ProjectRow(props: {
  project: Project
  client: ApiClient
  onUpdated: (next: Project) => void
  onDeleted: (id: number) => void
  onSessionStale?: () => void
}) {
  const { project, client, onUpdated, onDeleted, onSessionStale } = props
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(project.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Archiving stops ingest, which is outward-facing and invisible from this
  // screen -- every page already carrying the snippet starts being refused.
  // So it is a two-step, the same shape `SegmentDetail`/`FunnelDetail` use
  // for delete. Restoring is one click: it can only ever admit more.
  const [confirmArchive, setConfirmArchive] = useState(false)
  const archived = project.disabled_at !== null

  // Delete's own two-step, distinct from archive's: the confirming action
  // has to name the slug, not just click through a warning, because unlike
  // archiving there is no restore on the other side of it.
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [typed, setTyped] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)
  // The deletion request's own id (from the 202 response), for polling.
  // `null` both before a delete is started AND after this row was RENDERED
  // already deleting (`project.deleting_at` set from a previous session or
  // another tab) -- in the latter case there is no id here to poll with,
  // only the fact reported by `GET /v1/projects` itself.
  const [deletionId, setDeletionId] = useState<number | null>(null)
  const deleting = project.deleting_at !== null || deletionId !== null

  async function save(patch: { name?: string; archived?: boolean }) {
    setBusy(true)
    setError(null)
    try {
      onUpdated(await client.updateProject(project.id, patch))
      setRenaming(false)
      setConfirmArchive(false)
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'That project no longer exists.'
          : 'Could not save that. Try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  async function startDelete() {
    setDeleteBusy(true)
    setError(null)
    try {
      const res = await client.deleteProject(project.id, project.slug)
      setDeletionId(res.id)
      setConfirmDelete(false)
      setTyped('')
      // Merges into context immediately, on the 202 -- not once the first
      // poll happens to land. The header switcher (`Shell.tsx`) filters on
      // `deleting_at` from context, not on this row's own local state, so
      // without this the switcher would keep offering the project for the
      // whole poll interval, exactly the risk its own filter exists to
      // close. Same precedent `save()` above follows for a rename/archive:
      // the write's own answer merges in, never a re-fetch. The DELETE
      // response itself carries no row to merge (`{ id, project_id, status
      // }`, not a `Project`), so the timestamp is stamped client-side --
      // its exact value doesn't matter, only that it is non-null.
      onUpdated({ ...project, deleting_at: new Date().toISOString() })
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onSessionStale?.()
      } else if (err instanceof ApiError && err.status === 409) {
        setError(
          err.code === 'slug_mismatch'
            ? 'That did not match the project slug.'
            : 'A deletion is already in progress for this project.',
        )
      } else if (err instanceof ApiError && err.status === 404) {
        setError('That project no longer exists.')
      } else {
        setError('Could not start the deletion. Try again.')
      }
    } finally {
      setDeleteBusy(false)
    }
  }

  // Polls the deletion request every 3s until it lands. A poll that FAILS
  // (network hiccup, a 5xx) is not a deletion that failed -- the teardown
  // runs server-side whether or not this tab is watching, so the catch
  // below leaves the row in its deleting state and tries again on the next
  // tick. Only a `failed` STATUS is a failure. Cleared on unmount and
  // whenever there is nothing to poll, so a closed tab or a row that never
  // started a delete never runs this timer.
  useEffect(() => {
    if (deletionId === null) return
    let cancelled = false
    const timer = setInterval(async () => {
      try {
        const status = await client.projectDeletion(deletionId)
        if (cancelled) return
        if (status.status === 'completed') {
          clearInterval(timer)
          onDeleted(project.id)
        } else if (status.status === 'failed') {
          clearInterval(timer)
          setError(status.error ?? 'The deletion did not finish.')
        }
      } catch {
        // See the comment above: a poll failure is not a deletion failure.
      }
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [deletionId, client, project.id, onDeleted])

  return (
    <li className="flex min-w-0 flex-col gap-1 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {renaming ? (
          <>
            <Label htmlFor={`rename-${project.id}`} className="sr-only">
              {`New name for ${project.name}`}
            </Label>
            <Input
              id={`rename-${project.id}`}
              value={draft}
              disabled={busy}
              className="h-8 max-w-64"
              onChange={(e) => setDraft(e.target.value)}
            />
            <Button
              type="button"
              size="sm"
              disabled={busy || draft.trim() === ''}
              onClick={() => save({ name: draft.trim() })}
            >
              Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(project.name)
                setRenaming(false)
                setError(null)
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <span className="min-w-0 truncate text-foreground text-sm">{project.name}</span>
            {/* The slug, because a rename does not change it -- and this is
             * the only screen that says so. An operator whose scripts call
             * `lyraflow seed-demo demo-data` needs to see that the name
             * they just edited is not the handle those use. */}
            <span className="truncate font-mono text-muted-foreground text-xs">{project.slug}</span>
            {archived && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                archived
              </span>
            )}
            {deleting && (
              <span className="rounded-sm bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">
                deleting
              </span>
            )}
            <span className="flex-1" />
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={deleting}
              onClick={() => {
                setDraft(project.name)
                setRenaming(true)
              }}
            >
              Rename
            </Button>
            {/* No controls below once a delete is in flight -- the badge
             * above is the only thing left to say about this row. */}
            {!deleting && (
              <>
                {archived ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => save({ archived: false })}
                  >
                    Restore
                  </Button>
                ) : confirmArchive ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => save({ archived: true })}
                    >
                      {`Archive ${project.name}`}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => setConfirmArchive(false)}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmArchive(true)}
                  >
                    Archive
                  </Button>
                )}
                {confirmDelete ? (
                  <>
                    <Label htmlFor={`delete-confirm-${project.id}`} className="sr-only">
                      {`Type ${project.slug} to confirm`}
                    </Label>
                    <Input
                      id={`delete-confirm-${project.id}`}
                      value={typed}
                      disabled={deleteBusy}
                      placeholder={project.slug}
                      className="h-8 max-w-32"
                      onChange={(e) => setTyped(e.target.value)}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      disabled={deleteBusy || typed !== project.slug}
                      onClick={startDelete}
                    >
                      {`Delete ${project.slug} permanently`}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={deleteBusy}
                      onClick={() => {
                        setConfirmDelete(false)
                        setTyped('')
                        setError(null)
                      }}
                    >
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmDelete(true)}
                  >
                    Delete
                  </Button>
                )}
              </>
            )}
          </>
        )}
      </div>

      {/* Said at the moment of asking, not after: archiving is reversible,
       * but it stops collection, and events refused while a project is
       * archived are not queued anywhere to arrive later. */}
      {confirmArchive && !archived && (
        <p className="text-muted-foreground text-xs">
          This stops Lyraflow accepting events for this project. Nothing is deleted, every report
          keeps working, and you can restore it here. Events sent while it is archived are refused,
          not queued.
        </p>
      )}
      {/* Said at the moment of asking too, and volunteering the opposite
       * limit from archive's: this is the one action on this screen
       * archiving's own copy explicitly contrasts itself with. */}
      {confirmDelete && (
        <p className="text-muted-foreground text-xs">
          This permanently destroys every event, person and report for this project, in both
          databases. It cannot be undone, and it cannot be recovered from anything but a backup.
          Archiving stops collection without destroying anything.
        </p>
      )}
      {error != null && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </li>
  )
}

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
export function ProjectsSection(props: {
  client: ApiClient
  /** Called when a completed deletion empties the project list -- see
   * `App.tsx`'s implementation for why the wizard-or-shell decision has to
   * happen there rather than here. Threaded straight through to each row
   * too, matching `onUnauthorized`'s own shape. */
  onSessionStale?: () => void
}) {
  const { client, onSessionStale } = props
  const { projects, addProject, updateProject, removeProject } = useProject()

  const [mode, setMode] = useState<Mode>('idle')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)
  const [createdProject, setCreatedProject] = useState<CreatedProject | null>(null)

  // A completed deletion that leaves other projects behind removes the row
  // as it always has. One that empties the list can't -- the shell above
  // has nothing left to show -- so it hands off to `onSessionStale` instead
  // of `removeProject`, never both. `projects.length === 1` reads the
  // CURRENT, authoritative list from context at the moment the poll lands,
  // not a value captured when the delete started -- the only other project
  // could itself have been deleted in the meantime.
  //
  // Memoized on `[projects, removeProject, onSessionStale]` rather than a
  // fresh closure every render: `ProjectRow`'s own poll effect depends on
  // this function's identity, and an unrelated re-render here (opening the
  // "New project" form, another row saving a rename) must not reset an
  // in-flight row's poll timer.
  const handleDeleted = useCallback(
    (id: number) => {
      if (projects.length === 1) {
        onSessionStale?.()
      } else {
        removeProject(id)
      }
    },
    [projects, removeProject, onSessionStale],
  )

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
        <ul className="flex flex-col divide-y divide-border border-border border-y">
          {projects.map((p) => (
            <ProjectRow
              key={p.id}
              project={p}
              client={client}
              onUpdated={(next) => updateProject(next.id, next)}
              onDeleted={handleDeleted}
              onSessionStale={onSessionStale}
            />
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
