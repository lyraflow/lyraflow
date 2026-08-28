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
 * **Anchored to the person at BOTH ends, not to now.** The first fetch
 * sends `until: lastSeen` AND `since: firstSeen`, both taken from the
 * profile read that already ran. `until` is inclusive (`timestamp <= until`
 * in the route) and so is `since` (`timestamp >= since`), so the pair spans
 * the person's whole history inclusive of their first and last event.
 *
 * **`since` is not redundant, and the reason is the whole point of this
 * component.** `GET /v1/events` defaults `since` to 24h ago whenever the
 * caller omits it and sends no cursor -- and `until` does NOT disable that
 * default; only a cursor does (`events/routes.ts`, the `else if (!cursor)`
 * branch). So `until: lastSeen` on its own compiles to `timestamp >=
 * now-24h AND timestamp <= lastSeen`, which is an EMPTY INTERSECTION for
 * every person last seen more than a day ago. Measured against the live
 * stack, not reasoned about: a person with events at -30h and -25h read
 * back `{"events":[]}` from that exact request, while the same request
 * with `since=first_seen` returned both. The screen's own header said "2
 * events" directly above a timeline saying there were none, with no
 * `prev_cursor` to offer a "Load older" click -- so the walk could not even
 * start, and the empty state was the permanent one.
 *
 * An earlier version of this component omitted `since` on the argument
 * that a floor at `first_seen` is "correct and redundant", since `before`
 * walks backwards and stops on its own once the person's events run out.
 * That argument is about the SECOND page onwards and does not reach the
 * first, which has no cursor and therefore gets the default. The worry
 * that went with it -- that an event landing between the two reads makes
 * them disagree -- cannot bite either: a new event can only move
 * `last_seen` forwards, never `first_seen` backwards, so a `first_seen`
 * read a moment ago is still a valid floor under this person's history.
 * Being one event short at the newest end is what `until` already accepts
 * (and what a page of 100 walking backwards makes invisible); being 24
 * hours short at the oldest end is a blank screen.
 *
 * **Only the first page carries it.** `loadOlder` sends `before` and
 * nothing else: a cursor is itself a lower bound on the scan, the route
 * suppresses the default whenever one is present, and adding a second
 * floor underneath a keyset walk is the exact defect that route's own
 * `!cursor` comment exists to prevent.
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
  /** The person's `first_seen`, from the same profile read `lastSeen` comes
   * from -- the first page's `since` floor. See this component's own
   * docstring for why the pair is required rather than merely tidy. */
  firstSeen: string
  /** Called once the anchored first page lands -- with its newest event, or
   * with `null` when that page came back EMPTY. Never called again after
   * that: a `before` page only ever adds events OLDER than what is already
   * shown, so the newest event never changes once the first page is in.
   *
   * **`null` is a real answer, not the absence of one.** The profile's
   * context panel reads its device/browser/location off this event, and it
   * has three states to tell apart, not two: not asked yet, asked and there
   * was nothing to read, asked and it failed. Firing only on a non-empty
   * page collapsed the first two, so a timeline that loaded perfectly well
   * and returned zero events left the panel claiming the timeline "has not
   * loaded" -- a claim about this screen's own progress that was simply
   * false. Not called at all on a failure, which is what keeps the third
   * state distinct from the second.
   *
   * Called from INSIDE the same `.then()` that sets this table's own state
   * below, not from a separate effect reacting to `events` -- React 18
   * batches every `setState` call made within one synchronous callback,
   * regardless of which component owns the state, so calling it here lands
   * the parent's context panel and this table in the same commit. A
   * separate effect watching `events` used to do this instead, and it
   * produced a real, observed race: the table's own commit could paint
   * before the effect ran, showing the timeline already populated while
   * the context panel above it still claimed "this person's timeline has
   * not loaded" -- caught by `People.test.tsx`'s "never shows the timeline
   * row and 'has not loaded' at the same time", which failed on ~60% of
   * runs against that version.
   *
   * Must be referentially stable across renders -- it is in this
   * component's fetch effect's dependency array, so a fresh closure every
   * render would re-fetch the first page forever. `People` wraps it in
   * `useCallback` for exactly that reason. */
  onNewestEvent?: (event: LyraEvent | null) => void
}) {
  const { client, projectId, personId, lastSeen, firstSeen, onNewestEvent } = props

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
      .events(projectId, {
        person: personId,
        // BOTH ends, and `since` is the one that is easy to drop -- see the
        // component docstring: without it the route's own 24h default
        // intersects `until` to nothing for anyone last seen over a day
        // ago.
        since: firstSeen,
        until: lastSeen,
        limit: TIMELINE_PAGE,
      })
      .then((page) => {
        if (cancelled) return
        setEvents(page.events)
        setCursor(page.prev_cursor)
        setEnded(page.events.length === 0)
        setStatus({ kind: 'ready' })
        // In the SAME batch as the state above, not a separate effect
        // reacting to `events` -- see `onNewestEvent`'s own doc comment on
        // the prop for why that used to be two commits instead of one.
        // Ascending order -- the LAST element is the newest. `.at(-1)`
        // rather than `page.events[page.events.length - 1]`: the two are
        // the same value once `page.events.length > 0`, and under
        // `noUncheckedIndexedAccess` `.at()` is already typed
        // `LyraEvent | undefined`, which is precisely the case `?? null`
        // has to carry rather than swallow.
        //
        // `?? null`, not a `!= null` guard around the call: an empty first
        // page is a fact the context panel needs told, not a reason to stay
        // silent -- see this prop's own doc comment.
        onNewestEvent?.(page.events.at(-1) ?? null)
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
    // `onNewestEvent` joins the dependency array now that it is called from
    // here -- safe against extra re-fetches only because every caller keeps
    // it referentially stable (see the prop's own doc comment). `People`
    // used to pass its `useState` dispatch function directly, which is
    // stable for free; it now passes a `useCallback`, since it has to map
    // the event-or-null into its own three-state context, and that is the
    // version this dependency is safe against.
    //
    // `firstSeen` joins it for the same reason `lastSeen` is already there:
    // it is part of the request, so a profile re-read that moved it must
    // re-anchor the walk rather than leave a stale bound in place.
  }, [client, projectId, personId, lastSeen, firstSeen, onNewestEvent])

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
