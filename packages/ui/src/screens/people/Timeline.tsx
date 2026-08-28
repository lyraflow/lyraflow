import { useEffect, useState } from 'react'
import type { ApiClient } from '../../api/client.js'
import { ApiError } from '../../api/client.js'
import type { LyraEvent } from '../../api/types.js'
import { Button } from '../../components/ui/button.js'
import { AcceptedTable } from '../feed/AcceptedTable.js'
import { formatDate } from '../shared/format.js'

/**
 * One page of the backward walk this screen fetches at a time -- well under
 * `EVENTS_MAX_LIMIT` (500, `packages/server/src/events/routes.ts`), so a
 * profile that has genuinely fragmented into hundreds of device windows
 * (`person_history_too_fragmented`, handled below) never trips the route's
 * own ceiling on the very first click either.
 */
export const TIMELINE_PAGE = 100

/** What the walk currently knows, independent of how many pages it has
 * fetched -- `person_history_too_fragmented` gets its own branch because its
 * copy names the real cause rather than reading as a generic outage. */
type Status = { kind: 'loading' } | { kind: 'fragmented' } | { kind: 'error' } | { kind: 'ready' }

/**
 * A person's event history, walked backwards from `last_seen` a page at a
 * time -- the identity header's counterpart for "what did this person
 * actually do".
 *
 * **Anchored to the person, not to now.** The first fetch sends `until:
 * lastSeen` and no `since`. Without `until`, `GET /v1/events` applies its
 * own 24h `since` default (`STATS_DEFAULT_WINDOW_MS` is the stats route's
 * equivalent; the feed route's is unconditional) and a person last seen in
 * June would open to an empty timeline with no explanation, on a screen
 * whose whole purpose is their history. `until` is inclusive
 * (`timestamp <= until` in the route), so this includes their last event
 * rather than stopping one short of it.
 *
 * `since` is deliberately never set to the person's `first_seen`: it would
 * be correct and redundant -- `before` walks backwards and stops on its own
 * once their events run out -- and it only creates a way for two reads
 * (the profile fetch and this one) to disagree if an event lands between
 * them.
 *
 * **Kept in ascending order internally, the same order every `/v1/events`
 * response already arrives in** -- an older page's events are PREPENDED as
 * they load, keeping the whole accumulated walk in true chronological
 * order. `AcceptedTable` already reverses an ascending array exactly once,
 * for display (see its own docstring) -- reversing here too, before handing
 * it that array, would cancel the two reversals out and put the OLDEST
 * event on top instead of the newest. Leaning on the one reversal
 * `AcceptedTable` already has, rather than adding a second, is also what
 * keeps two pages from ever disagreeing about direction: there is exactly
 * one place in this whole pipeline that ever reverses anything, applied to
 * the complete accumulated list every time, so a first page and a later
 * page can never end up ordered against each other.
 *
 * **The walk ends when a page comes back with zero events**, not when a
 * cursor happens to be `null` -- `prev_cursor` is built from a page's own
 * first row and so is only ever `null` on an empty page in the first
 * place, but this checks the row count directly rather than leaning on
 * that being true forever.
 */
export function Timeline(props: {
  client: ApiClient
  projectId: number
  personId: string
  lastSeen: string
  /** Called with the newest event once the anchored page lands, so the
   * profile's context panel has something to read. Never called again after
   * that: a `before` page only ever adds events OLDER than what is already
   * shown, so the newest event never changes once the first page is in. */
  onNewestEvent?: (event: LyraEvent) => void
}) {
  const { client, projectId, personId, lastSeen, onNewestEvent } = props

  const [events, setEvents] = useState<LyraEvent[]>([])
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  const [cursor, setCursor] = useState<string | null>(null)
  const [ended, setEnded] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [olderError, setOlderError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setStatus({ kind: 'loading' })
    setEvents([])
    setCursor(null)
    setEnded(false)
    setOlderError(false)
    client
      .events(projectId, { person: personId, until: lastSeen, limit: TIMELINE_PAGE })
      .then((page) => {
        if (cancelled) return
        setEvents(page.events)
        setCursor(page.prev_cursor)
        setEnded(page.events.length === 0)
        setStatus({ kind: 'ready' })
      })
      .catch((err: unknown) => {
        if (cancelled) return
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
  }, [client, projectId, personId, lastSeen])

  useEffect(() => {
    // Ascending order -- the LAST element is the newest. `.at(-1)` rather
    // than `events[events.length - 1]`: the two are the same value once
    // `events.length > 0`, but only the `!= null` check on the `.at()` read
    // proves that to the compiler under `noUncheckedIndexedAccess`.
    const newest = events.at(-1)
    if (newest != null) onNewestEvent?.(newest)
  }, [events, onNewestEvent])

  function loadOlder() {
    if (cursor == null || loadingOlder) return
    setLoadingOlder(true)
    setOlderError(false)
    client
      .events(projectId, { person: personId, before: cursor, limit: TIMELINE_PAGE })
      .then((page) => {
        // Prepended, not appended: an older page is chronologically BEFORE
        // everything already held, so it belongs at the front of the
        // ascending array for the accumulated walk to stay ascending.
        setEvents((prev) => [...page.events, ...prev])
        setCursor(page.prev_cursor)
        setEnded(page.events.length === 0)
      })
      .catch(() => {
        setOlderError(true)
      })
      .finally(() => {
        setLoadingOlder(false)
      })
  }

  if (status.kind === 'loading') return null

  if (status.kind === 'fragmented') {
    return (
      <p role="alert" className="text-destructive text-sm">
        Could not load the timeline — this person&apos;s history spans too many devices to fetch in
        one query.
      </p>
    )
  }

  if (status.kind === 'error') {
    return (
      <p role="alert" className="text-destructive text-sm">
        Could not load this person&apos;s timeline. Reload to try again.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {events.length > 0 && <AcceptedTable events={events} />}

      {olderError && (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            Could not load older events.
          </p>
          <Button type="button" size="sm" variant="outline" onClick={loadOlder}>
            Retry
          </Button>
        </div>
      )}

      {/* `cursor != null` alongside `ended`: `ended` is only ever set from an
       * actually-empty response, on purpose (see the docstring above), so a
       * page that came back with events but somehow carried no cursor to
       * continue from still needs to not offer a click with nothing to send
       * it -- `loadOlder` itself guards the same condition, this just keeps
       * the button from rendering as a click that silently does nothing. */}
      {!ended && !olderError && cursor != null && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={loadOlder}
          disabled={loadingOlder}
        >
          {loadingOlder ? 'Loading…' : 'Load older'}
        </Button>
      )}

      {ended &&
        (() => {
          // `.at()`, not `[0]`/`[-1]`, for the same reason `segments/routes.ts`
          // uses it -- `noUncheckedIndexedAccess` makes either read
          // `LyraEvent | undefined`, and the `!= null` check below is what
          // actually proves to the compiler (not just to the reader) that
          // this branch only runs once `events.length > 0`.
          const first = events.at(0)
          const last = events.at(-1)
          if (first == null || last == null) {
            return (
              <p className="text-muted-foreground text-sm">No events recorded for this person.</p>
            )
          }
          // Never "everything" on a page that still carries a cursor -- this
          // only renders once a page has come back genuinely empty, which is
          // the one moment the walk can say so and mean it.
          return (
            <p className="text-muted-foreground text-sm">
              That is their whole history — {events.length.toLocaleString('en-US')}{' '}
              {events.length === 1 ? 'event' : 'events'}, from {formatDate(first.timestamp)} to{' '}
              {formatDate(last.timestamp)}.
            </p>
          )
        })()}
    </div>
  )
}
