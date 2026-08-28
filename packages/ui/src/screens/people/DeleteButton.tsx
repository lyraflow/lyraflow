import { useEffect, useState } from 'react'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { Button } from '../../components/ui/button.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'

/**
 * The destructive action on a person's profile, mirroring
 * `ProjectsSection`'s project-delete flow exactly rather than inventing a
 * second pattern for the same shape: a two-step confirm, a typed-id gate
 * (there is no slug here, so the person's own id stands in for it), a
 * 3-second poll, and -- the part most worth copying rather than
 * re-deriving -- the same distinction between a poll that FAILED (a
 * network blip; the worker's teardown is unaffected and keeps running
 * whether or not this tab is watching) and a deletion that was reported
 * `failed` (the worker itself gave up). Conflating the two would tell an
 * operator an erasure died when it is merely mid-flight, or silently stop
 * telling them anything at all.
 *
 * Also mirrors `ExportButton`'s 401 handling: a session expiring mid-action
 * is not the same event as the action itself failing, and every other
 * authenticated action on this branch routes it to `onUnauthorized` rather
 * than a message a retry cannot fix. Here that applies twice over -- once
 * for the request that starts the deletion, and once for every poll tick,
 * because a session can just as easily expire during the few seconds a
 * deletion is in flight as during the click that started it.
 */
export function DeleteButton(props: {
  client: ApiClient
  projectId: number
  personId: string
  onDeleted: () => void
  onUnauthorized?: () => void
}) {
  const { client, projectId, personId, onDeleted, onUnauthorized } = props
  const [confirming, setConfirming] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Set from the 202's `request_id`, the id every poll below uses. `null`
  // both before a delete is started and for the whole life of a row that
  // never starts one -- the poll effect below is a no-op in that state.
  const [deletionId, setDeletionId] = useState<number | null>(null)

  async function startDelete() {
    setBusy(true)
    setError(null)
    try {
      const res = await client.deletePerson(projectId, personId)
      setDeletionId(res.request_id)
      setConfirming(false)
      setTyped('')
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        onUnauthorized?.()
      } else {
        setError('Could not start the deletion. Try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  // Polls the deletion request every 3s until it lands. A poll that FAILS
  // (network hiccup, a 5xx) is not a deletion that failed -- the teardown
  // runs server-side whether or not this tab is watching, so the catch
  // below leaves this in its deleting state and tries again on the next
  // tick. Only a `failed` STATUS is a failure, and `completed` is the only
  // status that ever stops the poll on success (`onDeleted`, which lets
  // `People.tsx` re-read and render the 404 state that proves the erasure).
  //
  // `pending` carrying an `error` is neither of those: the route's own
  // docstring (`privacy/routes.ts`) is explicit that an attempt failed and
  // another WILL be tried, so this keeps polling (no `clearInterval`) but
  // still surfaces the error -- the operator should not read silence while
  // a retry is already scheduled.
  //
  // A 401 IS the one exception to "a poll failure is not a deletion
  // failure": an expired session will not resolve on the next tick either,
  // and treating it as an ordinary hiccup means this timer retries a
  // request that can only ever 401, every three seconds, for as long as the
  // tab stays open, while the screen shows nothing to explain why nothing
  // moves.
  useEffect(() => {
    if (deletionId === null) return
    let cancelled = false
    const timer = setInterval(async () => {
      try {
        const status = await client.deletion(projectId, deletionId)
        if (cancelled) return
        if (status.status === 'completed') {
          clearInterval(timer)
          onDeleted()
        } else if (status.status === 'failed') {
          clearInterval(timer)
          setError(status.error ?? 'The deletion did not finish.')
        } else if (status.status === 'pending' && status.error != null) {
          setError(`Will be retried -- the last attempt failed: ${status.error}`)
        }
        // `in_progress`, or `pending` with no error yet: nothing new to
        // say, keep polling.
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearInterval(timer)
          if (!cancelled) onUnauthorized?.()
          return
        }
        // See the comment above: any other poll failure is not a deletion
        // failure.
      }
    }, 3000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [deletionId, client, projectId, onDeleted, onUnauthorized])

  const deleting = deletionId !== null

  if (deleting) {
    return (
      <div className="flex flex-col gap-2">
        <span className="text-muted-foreground text-sm">Deleting…</span>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
    )
  }

  if (confirming) {
    return (
      <div className="flex flex-col gap-2">
        {/* The confirmation copy, verbatim -- the two facts an operator
         * cannot recover from and neither is obvious from a button: this
         * cannot be undone, AND it writes one permanent suppression row
         * per id the person owns, which is never removed (#19). */}
        <p data-testid="delete-warning" className="max-w-xl text-muted-foreground text-sm">
          <strong>This erases everything Lyraflow holds about this person</strong> — every event,
          trait and identity binding, in ClickHouse and in Postgres. It cannot be undone. It also
          writes one permanent suppression row per id they own, so that a restored backup cannot
          bring them back; those rows are never removed.
        </p>
        <Label htmlFor="delete-person-confirm" className="sr-only">
          {`Type ${personId} to confirm`}
        </Label>
        <Input
          id="delete-person-confirm"
          value={typed}
          disabled={busy}
          placeholder={personId}
          className="h-8 max-w-64"
          onChange={(e) => setTyped(e.target.value)}
        />
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant="destructive"
            disabled={busy || typed !== personId}
            onClick={startDelete}
          >
            Delete
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setConfirming(false)
              setTyped('')
              setError(null)
            }}
          >
            Cancel
          </Button>
        </div>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
      </div>
    )
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(true)}>
      Delete this person
    </Button>
  )
}
