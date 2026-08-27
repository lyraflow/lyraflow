import type { ApiClient } from '../../api/client.js'
import { EventCombobox } from '../../components/EventCombobox.js'
import { Label } from '../../components/ui/label.js'
import { FEED_RANGES, type FeedRange } from './range.js'

/**
 * The window and the event filter the whole feed is read through.
 *
 * **One control set, three queries.** The range and the event name reach the
 * chart, the accepted table and the rejections together. Before this the
 * screen ran three windows nobody could see -- the table inherited the
 * server's 24-hour default because it sent no `since` at all, the rejections
 * asked for 24 hours explicitly, and the chart above them was hard-coded to
 * sixty minutes. A screen whose chart and table disagree by a factor of
 * twenty-four, silently, is worse than one that shows less.
 *
 * A fixed set of ranges rather than a date field, for the reason the funnel
 * screen's `RangePicker` gives: the server bills a window by how much
 * ClickHouse it scans, and an unbounded custom range from a screen that
 * polls is the cost surface the query timeout exists to defend.
 *
 * A plain native `<select>` for the same reason too -- it needs to report a
 * change and nothing else, and it is what `user-event`'s `selectOptions`
 * drives, the same way a keyboard does.
 */
export function FeedFilters(props: {
  client: ApiClient
  projectId: number | null
  range: FeedRange
  onRangeChange: (range: FeedRange) => void
  event: string
  onEventChange: (event: string) => void
  onUnauthorized?: () => void
}) {
  const { client, projectId, range, onRangeChange, event, onEventChange, onUnauthorized } = props
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div className="flex items-center gap-2">
        <Label htmlFor="feed-range">Range</Label>
        <select
          id="feed-range"
          data-testid="feed-range"
          value={range.id}
          onChange={(e) =>
            onRangeChange(FEED_RANGES.find((r) => r.id === e.target.value) as FeedRange)
          }
          className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
        >
          {FEED_RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
      </div>

      {/* Rendered only with a project, because the catalogue it reads is
       * project-scoped -- with none selected there is nothing to look up
       * and a field offering an empty list would read as "you have no
       * events" rather than "no project chosen". */}
      {projectId != null && (
        <div className="min-w-56">
          <EventCombobox
            client={client}
            projectId={projectId}
            value={event}
            onChange={onEventChange}
            label="Event"
            accessibleName="Filter by event"
            onUnauthorized={onUnauthorized}
          />
        </div>
      )}

      {event !== '' && (
        <button
          type="button"
          data-testid="feed-clear-event"
          onClick={() => onEventChange('')}
          className="h-9 rounded-md px-2 text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          Clear filter
        </button>
      )}
    </div>
  )
}
