import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { CreatedProject, Project } from '../api/types.js'
import { Button } from '../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { usePolling } from './feed/usePolling.js'
import { SnippetSection } from './settings/SnippetSection.js'

/**
 * How often the wizard polls for the operator's first event, in production.
 * A few seconds, matching `Feed`'s own `DEFAULT_POLL_INTERVAL_MS` -- this is
 * a poll against the same server, at the one moment it is also absorbing
 * whatever traffic the just-pasted snippet sends. Tests pass their own
 * `pollIntervalMs` rather than this changing; see this file's own test
 * "defaults the poll interval to a few seconds" for the pin.
 */
export const DEFAULT_WIZARD_POLL_INTERVAL_MS = 3000

/**
 * A placeholder used only when `onReady` must fire without ever having
 * resolved the freshly-created project's id (the list refetch below
 * failed). Every field the caller could plausibly read is present, but the
 * id (`-1`) can never collide with a real project, since real ids start at
 * 1. `App`'s `onReady` handler re-fetches the project list itself and does
 * not trust this value's fields -- it exists only so the callback's type
 * signature stays a `Project`, never `Project | null`, which would push a
 * null check onto every future caller for a path only the skip button
 * (and only a projects()-refetch failure within it) ever takes.
 */
function unresolvedProjectStub(name: string): Project {
  return {
    id: -1,
    name,
    slug: '',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
  }
}

/**
 * The first-run wizard: name a project, get the install snippet and the
 * project's one-time server key, then wait for a real event to arrive
 * before ever calling `onReady`. `App` renders this INSTEAD OF the normal
 * shell when the operator is authenticated but has no project yet -- see
 * `App.tsx`'s own comment on why this is a phase, not a route.
 *
 * The whole point of this screen (see the design doc it comes from): it
 * must never claim success on a timer. `onReady` fires exactly twice --
 * once when a poll of `events(projectId, { limit: 1 })` actually returns a
 * row, and once if the operator explicitly skips, for the case where the
 * site this snippet targets can't be deployed to right now. Nothing else
 * calls it.
 */
export function Wizard(props: {
  client: ApiClient
  onReady: (project: Project) => void
  pollIntervalMs?: number
}) {
  const { client, onReady, pollIntervalMs = DEFAULT_WIZARD_POLL_INTERVAL_MS } = props

  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedProject | null>(null)
  // Separate from `created`: `createProject`'s response (`CreatedProject`,
  // `api/types.ts`) carries no `id` -- only `name`/`slug`/the two one-time
  // keys -- so the numeric id `events()` needs to poll has to come from a
  // second call, `projects()`, matched back by slug. `created` (the
  // snippet/server-key panel) and `resolvedProject` (what polling and
  // `onReady` use) are set together, from the same successful path, so a
  // render with one set and not the other only happens if that lookup
  // itself failed -- handled below by falling back to a stub rather than
  // ever blocking on it.
  const [resolvedProject, setResolvedProject] = useState<Project | null>(null)

  // Guards `onReady` firing more than once. Both paths that can call it --
  // an arriving event and the skip button -- can in principle both become
  // true (a poll landing between a click and the parent unmounting this
  // component), and the parent's `onReady` is not documented as idempotent.
  const readyFired = useRef(false)

  function fireReady(project: Project) {
    if (readyFired.current) return
    readyFired.current = true
    onReady(project)
  }

  async function handleCreate() {
    setNameError(null)
    const trimmed = name.trim()
    if (trimmed === '') {
      setNameError('Project name is required.')
      return
    }
    setCreating(true)
    try {
      const createdProject = await client.createProject(trimmed)
      let match: Project | null = null
      try {
        const list = await client.projects()
        match = list.find((p) => p.slug === createdProject.slug) ?? null
      } catch {
        // The create itself already succeeded -- a failed refetch here
        // must not throw away the one-time keys. `resolvedProject` staying
        // null just means polling can't start until it's known; the skip
        // button (via `unresolvedProjectStub`) still gets the operator
        // through.
        match = null
      }
      setCreated(createdProject)
      setResolvedProject(match)
    } catch (err) {
      // The API slugifies the name, so "My App" and "my app" collide even
      // though neither is literally the other -- the ordinary outcome of
      // that, not a system failure. `created` is deliberately left unset
      // on every error path: advancing past step 1 here would show a
      // snippet for a project that doesn't exist.
      if (err instanceof ApiError && err.status === 409) {
        setNameError(`A project named "${trimmed}" already exists.`)
      } else {
        setNameError('Could not create the project. Try again.')
      }
    } finally {
      setCreating(false)
    }
  }

  // Before a project exists (or its id is still unresolved) this returns
  // without ever calling the API -- `usePolling` still runs its interval,
  // harmlessly, rather than this being wired up conditionally, so there is
  // one polling discipline instead of a second start/stop mechanism.
  const pollEvents = useCallback(async () => {
    if (resolvedProject == null) return { events: [], next_cursor: null }
    return client.events(resolvedProject.id, { limit: 1 })
  }, [client, resolvedProject])

  const pollState = usePolling(pollEvents, pollIntervalMs)
  // `pollState.error` is deliberately NOT consulted here -- a poll that
  // rejects (a passing 5xx, a network blip) is not "no event yet", and
  // `usePolling` already keeps retrying on the same interval; see
  // `usePolling`'s own doc comment. Treating an error as anything but
  // "keep waiting" is exactly the mutation this screen's tests pin against.
  const arrived = (pollState.data?.events.length ?? 0) > 0

  // `fireReady` is intentionally omitted from the dependency list below --
  // it is not memoized, but it only reads a ref and calls `onReady`;
  // including it would re-run this effect on every render for no reason
  // that changes `arrived` or `resolvedProject`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fireReady has no reactive state of its own, see comment above
  useEffect(() => {
    if (!arrived || resolvedProject == null) return
    fireReady(resolvedProject)
  }, [arrived, resolvedProject])

  function handleSkip() {
    fireReady(resolvedProject ?? unresolvedProjectStub(created?.name ?? name.trim()))
  }

  return (
    // `min-h-dvh`, not `h-dvh`: a fixed height combined with `justify-center`
    // is the classic flexbox "unsafe centering" trap -- once the "created"
    // state's extra content (the server-key panel, step 3) makes this taller
    // than the viewport, a FIXED-height centered flex container spills the
    // overflow equally on both edges, and the top spill lands at a negative
    // offset no scroll position can reach (found reviewing wizard-1180-light
    // screenshot: the "✦ Lyraflow" wordmark was clipped -12px above the
    // viewport origin, not merely tight against it). `min-h-dvh` is a FLOOR,
    // not a cap: short content still centers in a full viewport exactly as
    // before, but content taller than the viewport simply grows the
    // container instead of forcing centering to clip it -- the excess then
    // flows through ordinary page scroll like anything else.
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background p-4 text-foreground">
      <p className="text-lg font-semibold tracking-tight">✦ Lyraflow</p>
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>
            {created == null ? '1. Name your first project' : 'Your project is ready'}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {created == null ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="wizard-project-name">Project name</Label>
              <div className="flex flex-wrap items-center gap-3">
                <Input
                  id="wizard-project-name"
                  className="max-w-64"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={creating}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleCreate()
                    }
                  }}
                />
                <Button type="button" onClick={() => void handleCreate()} disabled={creating}>
                  Create
                </Button>
              </div>
              {nameError != null && (
                <p role="alert" className="text-sm text-destructive">
                  {nameError}
                </p>
              )}
            </div>
          ) : (
            <>
              {/* Keeps 1 numbered in its completed state -- without this,
               * the sequence read "Your project is ready" / "2." / "3.",
               * and a person reasonably wonders what happened to step 1
               * (Finding 3, fix round 1). Muted rather than foreground:
               * the same "done, de-emphasised" treatment CardDescription
               * uses elsewhere, so it reads as past rather than pending. */}
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-muted-foreground">1. Project created</p>
              </div>
              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-foreground">2. Paste this on your site</p>
              </div>
              <SnippetSection writeKey={created.write_key} />

              {/* The server key's one showing -- see `ProjectsSection`'s
               * matching panel in Settings. It matters more here than
               * there: this is the operator's very first interaction with
               * the product. An inline panel, not a dialog, for the same
               * reason as Settings' version -- a reflexive Escape or
               * outside click must not be able to lose a value that exists
               * nowhere else, ever. */}
              <div
                data-testid="wizard-server-key"
                className="flex flex-col gap-2 rounded-md border border-warning bg-muted p-4"
              >
                <span className="text-xs font-medium text-muted-foreground">Server key</span>
                <code className="break-all font-mono text-xs text-foreground">
                  {created.server_key}
                </code>
                <p className="text-sm text-destructive">
                  Copy the server key now -- it will not be shown again. Only its hash is stored, so
                  it cannot be recovered later; losing it means creating a new project.
                </p>
              </div>

              <div className="flex flex-col gap-1">
                <p className="text-sm font-medium text-foreground">
                  3. Waiting for your first event…
                </p>
                <p className="text-sm text-muted-foreground">
                  Send a pageview from the site you just added the snippet to. This updates on its
                  own the moment one arrives -- nothing to refresh.
                </p>
              </div>

              <div>
                <Button type="button" variant="ghost" size="sm" onClick={handleSkip}>
                  Skip to dashboard
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
