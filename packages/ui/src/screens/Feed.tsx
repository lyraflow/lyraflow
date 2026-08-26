import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router'
import type { ApiClient } from '../api/client.js'
import { ApiError, DEFAULT_LIMIT } from '../api/client.js'
import { useProject } from '../app/ProjectContext.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js'
import { AcceptedTable } from './feed/AcceptedTable.js'
import { FeedFilters } from './feed/FeedFilters.js'
import { RejectionsTable } from './feed/RejectionsTable.js'
import { Sparkline } from './feed/Sparkline.js'
import { readFeedParams, writeFeedParams } from './feed/params.js'
import { type FeedRange, LIVE_POLL_MS, rangeWindow } from './feed/range.js'
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
 *
 * It is now the LIVE cadence from `range.ts` rather than its own literal --
 * the poll rate follows the chosen range, and the default range is a live
 * one, so this is what the screen still opens at. Kept exported because
 * `App` and `Wizard` pace themselves against the feed's rhythm.
 */
export const DEFAULT_POLL_INTERVAL_MS = LIVE_POLL_MS

/*
 * THE WINDOW IS CHOSEN, ONCE, AND ALL THREE POLLS SEND IT.
 *
 * Every one of them used to pick its own and none of them said which. The
 * events poll sent no `since` at all and inherited the server's 24-hour
 * default; the rejections poll asked for 24 hours explicitly, to keep the
 * two tab counts comparable; and the chart above them was hard-coded to
 * sixty minutes at `1m` resolution. So the chart and the table under it
 * disagreed by a factor of twenty-four, permanently and invisibly.
 *
 * Reported as a screen showing nothing on a project that has data -- which
 * was true, and the copy made it worse by saying "No events yet", a claim
 * about the project that a query bounded at 24 hours cannot support.
 *
 * `rangeWindow` is called INSIDE each poll rather than once per render, so a
 * feed left open keeps asking for the last N minutes as of each poll rather
 * than as of whenever the range was last changed. Both edges are still sent
 * explicitly, which the sparkline needs for a reason that has not changed:
 * `GET /v1/events/stats` does not zero-fill, so without a known window a
 * 40-minute outage inside an hour is indistinguishable from 20 minutes of
 * steady traffic.
 */

/**
 * A fetched page at exactly `limit` means there is more behind it that
 * this poll didn't fetch -- shown as "N+" rather than a number that reads
 * as exact when it isn't.
 */
function formatCount(n: number, limit: number): string {
  return n >= limit ? `${limit}+` : n.toLocaleString()
}

/**
 * Fix round 1 on #82: the tab badge is the same bug relocated, not a
 * different one. `events.length === 0` cannot distinguish "confirmed zero"
 * from "this poll has never once succeeded" -- the table body already
 * stopped claiming "No events yet" in that state, but the badge kept
 * rendering "Accepted 0" the whole time an events poll was failing, right
 * next to a banner that (once some OTHER poll has data) reads "showing the
 * last data received". An operator has no way to tell 0 was never
 * confirmed. An em dash says "unknown" rather than asserting a count the
 * poll never established; the alternative (freezing the last known number)
 * was rejected because a frozen "3" reads as current, which is the exact
 * false confidence #82 was filed over.
 */
function formatBadgeCount(n: number, limit: number, loadFailed: boolean): string {
  if (loadFailed) return '—'
  return formatCount(n, limit)
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
  const { client, pollIntervalMs, onUnauthorized } = props
  const { activeId } = useProject()
  const [tab, setTab] = useState('accepted')

  /* THE URL IS THE STATE, not a copy of it.
   *
   * Held here rather than in `useState` so a refresh keeps the window and
   * the filter an operator chose -- and so the screen they are looking at
   * can be sent to someone else, which is the thing an operator actually
   * wants the moment they find a spike. Reading straight from the search
   * params rather than seeding state from them also removes the class of
   * bug where the two drift: there is one value, and the address bar is it.
   *
   * `replace`, never push: the event field writes on every keystroke, and
   * pushing would bury the page the operator arrived from under one history
   * entry per character. The cost is that back does not step through filter
   * changes, which is the right trade for a text field.
   */
  const [search, setSearch] = useSearchParams()
  const { range, event } = readFeedParams(search)
  const setParams = useCallback(
    (next: { range?: FeedRange; event?: string }) => {
      setSearch(
        (prev) =>
          writeFeedParams(prev, {
            range: next.range ?? readFeedParams(prev).range,
            event: next.event ?? readFeedParams(prev).event,
          }),
        { replace: true },
      )
    },
    [setSearch],
  )
  const setRange = useCallback((r: FeedRange) => setParams({ range: r }), [setParams])
  const setEvent = useCallback((e: string) => setParams({ event: e }), [setParams])

  /** `''` is no filter, never `undefined`: `EventCombobox` is a text field
   * and an empty string is what it reports when cleared. The polls convert
   * it to an omitted parameter, which is the only place the distinction
   * between "no filter" and "an empty event name" has to be made. */
  const eventParam = event === '' ? undefined : event

  /* The cadence follows the range, and `pollIntervalMs` still wins so a
   * test can drive the cycle. Three seconds answers "is my instrumentation
   * working right now", which is a question about the last few minutes;
   * re-scanning ninety days at that rate asks an expensive question twenty
   * times a minute and answers it with a number that cannot visibly move. */
  const interval = pollIntervalMs ?? range.pollMs

  const pollEvents = useCallback(async () => {
    if (activeId == null) return { events: [], next_cursor: null }
    // No cursor, on purpose: this is a poll for the head of the stream, not
    // a page. Paging forward from an old `next_cursor` here would silently
    // skip anything that arrived past whatever page was fetched first.
    const { since, until } = rangeWindow(range)
    return client.events(activeId, { limit: DEFAULT_LIMIT, since, until, event: eventParam })
  }, [client, activeId, range, eventParam])

  const pollRejections = useCallback(async () => {
    if (activeId == null) return { rejections: [], has_more: false, next_offset: 0 }
    const { since, until } = rangeWindow(range)
    // NO event filter here, and that is not an omission. A rejection is a
    // payload the server refused, so the reason it is on this tab may be
    // that its event name is missing or unparseable -- filtering the
    // rejected tab by event name would hide exactly the rows an operator
    // came to it for. The window applies; the name cannot.
    return client.rejections(activeId, { limit: DEFAULT_LIMIT, since, until })
  }, [client, activeId, range])

  const pollStats = useCallback(async () => {
    const { since, until } = rangeWindow(range)
    if (activeId == null) return { buckets: [], since, until }
    const page = await client.stats(activeId, {
      interval: range.interval,
      since,
      until,
      event: eventParam,
    })
    return { ...page, since, until }
  }, [client, activeId, range, eventParam])

  const eventsState = usePolling(pollEvents, interval)
  const rejectionsState = usePolling(pollRejections, interval)
  const statsState = usePolling(pollStats, interval)

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
      <FeedFilters
        client={client}
        projectId={activeId}
        range={range}
        onRangeChange={setRange}
        event={event}
        onEventChange={setEvent}
        onUnauthorized={onUnauthorized}
      />

      <Sparkline
        buckets={buckets}
        since={statsState.data?.since}
        until={statsState.data?.until}
        interval={range.interval}
      />

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
            Accepted {formatBadgeCount(events.length, DEFAULT_LIMIT, eventsLoadFailed)}
          </TabsTrigger>
          {/* The rejected count lives on this trigger even while "accepted"
           * is the active tab -- Radix renders every TabsTrigger regardless
           * of which TabsContent is mounted. That's the whole point of this
           * screen: an operator on Accepted must see something is being
           * refused without going looking for it. */}
          <TabsTrigger value="rejected">
            Rejected {formatBadgeCount(rejections.length, DEFAULT_LIMIT, rejectionsLoadFailed)}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="accepted" className="min-w-0">
          <AcceptedTable
            events={events}
            loadFailed={eventsLoadFailed}
            rangeLabel={range.label}
            filteredEvent={eventParam}
          />
        </TabsContent>
        <TabsContent value="rejected" className="min-w-0">
          <RejectionsTable
            rejections={rejections}
            loadFailed={rejectionsLoadFailed}
            rangeLabel={range.label}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
