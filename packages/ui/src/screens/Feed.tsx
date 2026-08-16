import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../api/client.js'
import { ApiError, DEFAULT_LIMIT } from '../api/client.js'
import { useProject } from '../app/ProjectContext.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js'
import { AcceptedTable } from './feed/AcceptedTable.js'
import { RejectionsTable } from './feed/RejectionsTable.js'
import { Sparkline } from './feed/Sparkline.js'
import { usePolling } from './feed/usePolling.js'
import { formatRelative } from './funnels/format.js'

/**
 * How often the feed re-polls, in production. Three polled endpoints at
 * this interval is roughly one request per second per open tab against
 * Postgres (events, rejections) and ClickHouse (stats) -- on a self-hosted
 * box that may also be serving ingest, that has to stay conservative. Tests
 * that need a faster cycle pass their own `pollIntervalMs` rather than
 * this changing; see `Feed.test.tsx`'s "defaults to polling every 3
 * seconds" for the pin.
 */
export const DEFAULT_POLL_INTERVAL_MS = 3000

/**
 * `GET /v1/events` defaults `since` to the last 24 hours when the caller
 * omits it (routes.ts, `DEFAULT_SINCE_MS`); `GET /v1/events/rejections` has
 * no default of its own -- its only bound is the dead-letter table's 30-day
 * TTL. Left alone, the Accepted and Rejected tabs' counts describe two
 * different spans (Important 6): "last 24 hours" beside "last 30 days",
 * shown as if they were comparable. The events poll below keeps relying on
 * the server's own 24h default (so it stays in sync with that route even if
 * the default ever changes); the rejections poll has to state the matching
 * window explicitly, since it has no default of its own to inherit.
 */
const REJECTIONS_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Fixed lookback for the sparkline's own stats poll, sent explicitly so the
 * client always knows the window's true edges. Needed to zero-fill minutes
 * the API omitted (Important 7): `GET /v1/events/stats` groups by bucket
 * with NO zero-fill, returning only minutes that had at least one event --
 * without a known window to fill against, a 40-minute outage inside a
 * 60-minute window is indistinguishable from 20 minutes of steady traffic.
 */
const STATS_WINDOW_MINUTES = 60

/**
 * A fetched page at exactly `limit` means there is more behind it that
 * this poll didn't fetch -- shown as "N+" rather than a number that reads
 * as exact when it isn't.
 */
function formatCount(n: number, limit: number): string {
  return n >= limit ? `${limit}+` : n.toLocaleString()
}

export function Feed(props: {
  client: ApiClient
  pollIntervalMs?: number
  /**
   * Called when any polled request comes back 401 -- an expired or revoked
   * session, indistinguishable from "the server is down" to an operator
   * staring at frozen rows behind the generic error banner below (Critical
   * 2). `App` wires this to the same transition its own session poll uses,
   * so either signal returns the SPA to the login screen. Optional so every
   * existing test that doesn't care about this path keeps working
   * unchanged.
   */
  onUnauthorized?: () => void
}) {
  const { client, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, onUnauthorized } = props
  const { activeId } = useProject()
  const [tab, setTab] = useState('accepted')

  const pollEvents = useCallback(async () => {
    if (activeId == null) return { events: [], next_cursor: null }
    // No cursor, on purpose: this is a poll for the head of the stream, not
    // a page. Paging forward from an old `next_cursor` here would silently
    // skip anything that arrived past whatever page was fetched first.
    return client.events(activeId, { limit: DEFAULT_LIMIT })
  }, [client, activeId])

  const pollRejections = useCallback(async () => {
    if (activeId == null) return { rejections: [], has_more: false, next_offset: 0 }
    return client.rejections(activeId, {
      limit: DEFAULT_LIMIT,
      since: new Date(Date.now() - REJECTIONS_WINDOW_MS).toISOString(),
    })
  }, [client, activeId])

  const pollStats = useCallback(async () => {
    const until = new Date()
    const since = new Date(until.getTime() - STATS_WINDOW_MINUTES * 60_000)
    if (activeId == null) {
      return { buckets: [], since: since.toISOString(), until: until.toISOString() }
    }
    const page = await client.stats(activeId, {
      interval: '1m',
      since: since.toISOString(),
      until: until.toISOString(),
    })
    return { ...page, since: since.toISOString(), until: until.toISOString() }
  }, [client, activeId])

  const eventsState = usePolling(pollEvents, pollIntervalMs)
  const rejectionsState = usePolling(pollRejections, pollIntervalMs)
  const statsState = usePolling(pollStats, pollIntervalMs)

  const events = eventsState.data?.events ?? []
  const rejections = rejectionsState.data?.rejections ?? []
  const buckets = statsState.data?.buckets ?? []

  // An operator does not care which of the three requests hiccuped, only
  // that the numbers on screen might be a beat stale. Whichever rows are
  // already up stay up regardless -- usePolling never clears `data` on a
  // failed poll -- so this is additive, never a replacement for the table.
  const error = eventsState.error ?? rejectionsState.error ?? statsState.error

  // Whether ANYTHING has been confirmed for the currently selected project
  // yet -- across all three polls, not just events. `usePolling` resets
  // `data` to `null` the moment `activeId` changes (see its own "Important
  // 9" comment), so right after a project switch this is false until the
  // first poll of *any* kind lands. Used to decide, below, whether an error
  // means "could not load" (nothing to show yet) or "could not refresh"
  // (something is already on screen, just possibly stale).
  const hasData =
    eventsState.data != null || rejectionsState.data != null || statsState.data != null

  // The most recent moment any of the three polls actually succeeded --
  // used to say WHEN the data currently on screen is from, not merely that
  // it might be stale. `Math.max` over an empty/all-null set would be
  // `-Infinity`; that only happens when `hasData` is false, and the banner
  // below never reads this value in that case.
  const lastUpdatedAt = [
    eventsState.updatedAt,
    rejectionsState.updatedAt,
    statsState.updatedAt,
  ].reduce<number | null>(
    (latest, t) => (t != null && (latest == null || t > latest) ? t : latest),
    null,
  )

  // Per-table, not the merged `hasData`/`error` above: whether THIS
  // resource specifically has never been confirmed while erroring. Using
  // the merged flags here would let one poll's success (rejections, say)
  // paper over another's total failure (events) -- e.g. "No events yet"
  // would still render as long as *some* poll succeeded, even though the
  // events poll itself never has. Each table's empty-state claim is only
  // ever honest about its own resource.
  const eventsLoadFailed = eventsState.error != null && eventsState.data == null
  const rejectionsLoadFailed = rejectionsState.error != null && rejectionsState.data == null

  // Critical 2: a 401 from ANY of the three polls means the session is
  // gone, not that the server is having a bad moment -- the generic banner
  // above would otherwise read as a transient hiccup forever, at roughly
  // one request per second, with no route back to login. Checked on every
  // render rather than only inside usePolling itself, since all three polls
  // share this one screen's fate.
  useEffect(() => {
    if (error instanceof ApiError && error.status === 401) {
      onUnauthorized?.()
    }
  }, [error, onUnauthorized])

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Sparkline buckets={buckets} since={statsState.data?.since} until={statsState.data?.until} />

      {/*
       * Issue #82: this used to be one message regardless of whether there
       * was anything on screen to be "showing" -- claiming to show data
       * that a project switch had just cleared. `hasData` (merged across
       * all three polls; see above) decides which of two true things to
       * say instead. Never both, and never the table's own empty-state
       * copy alongside the "could not load" branch -- see `eventsLoadFailed`
       * / `rejectionsLoadFailed` passed to the tables below.
       */}
      {error != null && !hasData && (
        <p role="alert" className="text-sm text-destructive">
          Could not load the feed. It will keep retrying on its own.
        </p>
      )}
      {error != null && hasData && lastUpdatedAt != null && (
        <p role="alert" className="text-sm text-destructive">
          Could not refresh the feed. Showing the last data received, as of{' '}
          {formatRelative(new Date(lastUpdatedAt).toISOString(), new Date())}.
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab} className="min-w-0">
        {/*
         * `max-w-full` plus `overflow-x-auto` here for the same reason the
         * event/rejection tables below get their own scroll container: the
         * two trigger labels ("Accepted N" / "Rejected N") have a combined
         * natural width that doesn't fit next to a 224px sidebar at a
         * phone-width viewport. Without a cap this list -- being `w-fit` --
         * refuses to shrink and pushes the whole page into horizontal
         * scroll instead of scrolling in place.
         */}
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="accepted">
            Accepted {formatCount(events.length, DEFAULT_LIMIT)}
          </TabsTrigger>
          {/* The rejected count lives on this trigger even while "accepted"
           * is the active tab -- Radix renders every TabsTrigger regardless
           * of which TabsContent is mounted. That's the whole point of this
           * screen: an operator on Accepted must see something is being
           * refused without going looking for it. */}
          <TabsTrigger value="rejected">
            Rejected {formatCount(rejections.length, DEFAULT_LIMIT)}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="accepted" className="min-w-0">
          <AcceptedTable events={events} loadFailed={eventsLoadFailed} />
        </TabsContent>
        <TabsContent value="rejected" className="min-w-0">
          <RejectionsTable rejections={rejections} loadFailed={rejectionsLoadFailed} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
