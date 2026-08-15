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
 * How often the feed re-polls. The design brief describes "a ~3s interval";
 * this is deliberately faster. `@testing-library/dom`'s `waitFor` -- used
 * throughout this package's tests, unfaked here -- gives up after 1000ms by
 * default, and this screen's own test for "an error doesn't clear the rows
 * on screen" needs a real second poll to land inside that window. A faster
 * interval also serves the screen's actual job better: the whole point is a
 * five-second answer, so closer to real time is a feature, not just a test
 * accommodation.
 */
const POLL_INTERVAL_MS = 300

/**
 * A fetched page at exactly `limit` means there is more behind it that
 * this poll didn't fetch -- shown as "N+" rather than a number that reads
 * as exact when it isn't.
 */
function formatCount(n: number, limit: number): string {
  return n >= limit ? `${limit}+` : n.toLocaleString()
}

export function Feed(props: { client: ApiClient }) {
  const { client } = props
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

  const eventsState = usePolling(pollEvents, POLL_INTERVAL_MS)
  const rejectionsState = usePolling(pollRejections, POLL_INTERVAL_MS)
  const statsState = usePolling(pollStats, POLL_INTERVAL_MS)

  const events = eventsState.data?.events ?? []
  const rejections = rejectionsState.data?.rejections ?? []
  const buckets = statsState.data?.buckets ?? []

  // An operator does not care which of the three requests hiccuped, only
  // that the numbers on screen might be a beat stale. Whichever rows are
  // already up stay up regardless -- usePolling never clears `data` on a
  // failed poll -- so this is additive, never a replacement for the table.
  const error = eventsState.error ?? rejectionsState.error ?? statsState.error

  return (
    <div className="flex flex-col gap-4">
      <Sparkline buckets={buckets} />

      {error != null && (
        <p role="alert" className="text-sm text-destructive">
          Could not refresh the feed. Showing the last data received.
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
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
        <TabsContent value="accepted">
          <AcceptedTable events={events} />
        </TabsContent>
        <TabsContent value="rejected">
          <RejectionsTable rejections={rejections} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
