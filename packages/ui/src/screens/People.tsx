import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Person } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { IdentityHeader } from './people/IdentityHeader.js'
import { personPath, readPersonId } from './people/params.js'
import { AttributesSection, TraitsSection } from './shared/PersonFields.js'

/**
 * What the screen currently knows, independent of whether an id is even in
 * the URL -- `id === null` (no lookup attempted yet) is handled by the
 * caller before this ever matters, so every member here assumes a fetch was
 * or is being made.
 */
type Status =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'fragmented' }
  | { kind: 'error' }
  | { kind: 'loaded'; person: Person }

/**
 * The lookup box, shared by the empty state and by a 404 -- a failed lookup
 * returns HERE rather than to a dead end, with `draft` still holding what
 * was typed so it can be corrected rather than retyped (the same rule
 * `ProjectsSection` applies to its own confirm field).
 */
function LookupForm(props: {
  draft: string
  onChange: (value: string) => void
  onSubmit: () => void
  error?: ReactNode
}) {
  return (
    <form
      className="flex max-w-xl flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        props.onSubmit()
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="people-lookup">User id, anonymous id, or a device id</Label>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            id="people-lookup"
            className="max-w-64"
            value={props.draft}
            onChange={(e) => props.onChange(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={props.draft.trim() === ''}>
            Look up
          </Button>
        </div>
      </div>
      {props.error != null && (
        <p role="alert" className="text-destructive text-sm">
          {props.error}
        </p>
      )}
    </form>
  )
}

/**
 * A person profile -- one stitched identity, its traits, and (from Task 7)
 * the events it did.
 *
 * The id lives in the URL as `?id=`, read/written through
 * `people/params.ts` rather than a route param -- see that module's own
 * doc comment for why a path segment does not survive a hard refresh for a
 * caller-supplied id.
 *
 * A 404 here is not "no such person" -- `person.ts`'s own docstring names
 * three indistinguishable causes (never sent, erased by a deletion request,
 * or aged out under retention) and the copy below says all three, because
 * telling them apart is exactly what an operator checking an erasure needs
 * and "no such person" would answer wrong for two of the three causes.
 */
export function People(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const location = useLocation()
  const navigate = useNavigate()
  const id = readPersonId(location.search)

  const [draft, setDraft] = useState(id ?? '')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })

  // Keeps the lookup box in step with the URL -- both for a fresh navigation
  // (submitting the form below) and for a direct load of `/people?id=…`
  // (a pasted link, or a hard refresh on a 404): either way, whatever the
  // URL names is also what the box should show if the lookup fails.
  useEffect(() => {
    setDraft(id ?? '')
  }, [id])

  useEffect(() => {
    if (id === null || activeId == null) return
    let cancelled = false
    setStatus({ kind: 'loading' })
    client
      .person(activeId, id)
      .then((person) => {
        if (!cancelled) setStatus({ kind: 'loaded', person })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        if (err instanceof ApiError && err.status === 404) {
          setStatus({ kind: 'not-found' })
          return
        }
        if (
          err instanceof ApiError &&
          err.status === 400 &&
          err.code === 'person_history_too_fragmented'
        ) {
          setStatus({ kind: 'fragmented' })
          return
        }
        setStatus({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, id, onUnauthorized])

  function submit() {
    const trimmed = draft.trim()
    if (trimmed === '') return
    navigate(personPath(trimmed))
  }

  if (id === null) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-semibold text-lg">People</h1>
        <LookupForm draft={draft} onChange={setDraft} onSubmit={submit} />
      </div>
    )
  }

  if (status.kind === 'fragmented') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-semibold text-lg">People</h1>
        {/* The 400 copy, verbatim. Past `MAX_PERSON_RANGE_CLAUSES` (200)
         * device windows, this route refuses to assemble the profile in one
         * query -- a real answer, not a bug, and one this screen names
         * rather than rendering as a broken page. `lyraflow persons get`
         * still reads them, in chunks. */}
        <p>
          <strong>This person&apos;s history spans more than 200 device windows</strong>, which is
          more than this screen can assemble in one query. They are still readable through the API —{' '}
          <code className="font-mono">lyraflow persons get {id}</code> — which walks their history
          in chunks.
        </p>
      </div>
    )
  }

  if (status.kind === 'not-found') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-semibold text-lg">People</h1>
        <LookupForm
          draft={draft}
          onChange={setDraft}
          onSubmit={submit}
          error={
            <span data-testid="person-not-found">
              {/* The 404 copy, verbatim -- the sentence this task exists to
               * get right. A 404 here means one of three things and the API
               * cannot tell them apart (`person.ts`'s own docstring), so
               * this says all three rather than picking one and being wrong
               * for the other two. */}
              <strong>
                Nothing to show for <code className="font-mono">{id}</code>.
              </strong>{' '}
              That means one of three things and the API cannot tell them apart: no event was ever
              recorded under this id in this project; everything recorded was erased by a deletion
              request; or every event aged out under this project&apos;s retention window. If you
              expected someone here, check the id and the project.
            </span>
          }
        />
      </div>
    )
  }

  if (status.kind === 'error') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-semibold text-lg">People</h1>
        <p role="alert" className="text-destructive text-sm">
          Could not load this person. Reload to try again.
        </p>
      </div>
    )
  }

  if (status.kind === 'loading') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="font-semibold text-lg">People</h1>
      </div>
    )
  }

  const { person } = status
  return (
    <div className="flex flex-col gap-6">
      <IdentityHeader person={person} />
      {/* `AttributesSection` is fed by the timeline's newest event -- Task
       * 7's job. Until then there is no source to read context from, so
       * this renders the state the brief specifies (empty) rather than
       * inventing one: an empty source is truthful about what this task
       * built, not a placeholder pretending to be data. */}
      <AttributesSection source={{}} />
      <TraitsSection
        traits={person.traits}
        traits_num={person.traits_num}
        trait_total={person.trait_total}
        withheld={person.traits_withheld}
      />
      {/* Task 7 fills this in with the person's event timeline. */}
      <div
        data-testid="timeline-placeholder"
        className="rounded-md border border-border border-dashed p-6 text-center text-muted-foreground text-sm"
      >
        Event timeline coming soon.
      </div>
    </div>
  )
}
