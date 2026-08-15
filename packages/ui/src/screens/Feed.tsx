import { useCallback, useState } from 'react'
import type { ApiClient } from '../api/client.js'
import { DEFAULT_LIMIT } from '../api/client.js'
import { useProject } from '../app/ProjectContext.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js'
import { AcceptedTable } from './feed/AcceptedTable.js'
import { RejectionsTable } from './feed/RejectionsTable.js'
import { Sparkline } from './feed/Sparkline.js'
import { usePolling } from './feed/usePolling.js'

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
 * A fetched page at exactly `limit` means there is more behind it that
 * this poll didn't fetch -- shown as "N+" rather than a number that reads
 * as exact when it isn't.
 */
function formatCount(n: number, limit: number): string {
  return n >= limit ? `${limit}+` : n.toLocaleString()
}

export function Feed(props: { client: ApiClient; pollIntervalMs?: number }) {
  const { client, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = props
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
    return client.rejections(activeId, { limit: DEFAULT_LIMIT })
  }, [client, activeId])

  const pollStats = useCallback(async () => {
    if (activeId == null) return { buckets: [] }
    return client.stats(activeId, { interval: '1m' })
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

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Sparkline buckets={buckets} />

      {error != null && (
        <p role="alert" className="text-sm text-destructive">
          Could not refresh the feed. Showing the last data received.
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
          <AcceptedTable events={events} />
        </TabsContent>
        <TabsContent value="rejected" className="min-w-0">
          <RejectionsTable rejections={rejections} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
