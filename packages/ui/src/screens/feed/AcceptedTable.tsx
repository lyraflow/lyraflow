import type { LyraEvent } from '../../api/types.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js'
import { formatEventTime } from './format.js'

export function AcceptedTable(props: {
  events: LyraEvent[]
  /**
   * True when the events poll has errored and has never once returned data
   * for the current project -- i.e. an empty `events` here does not mean
   * "confirmed zero events", it means "unknown". Issue #82: rendering "No
   * events yet" in that state asserts something the poll never established,
   * directly contradicting `Feed`'s own "could not load" banner rendered
   * above this table at the same moment. `Feed` decides this from the
   * poll's own null-ness, not from `events.length`, so it stays correct
   * even once this table has genuinely-confirmed-empty data to show later.
   */
  loadFailed?: boolean
}) {
  const { events, loadFailed = false } = props

  if (events.length === 0) {
    // Nothing here: the "could not load" message already lives in the
    // banner `Feed` renders above every table on this screen. Repeating it
    // here would either duplicate that banner's words or, worse, drift
    // from them over time.
    if (loadFailed) return null
    return (
      <p className="px-2 py-10 text-center text-sm text-muted-foreground">
        No events yet. Send one and it will show up here within a few seconds.
      </p>
    )
  }

  // GET /v1/events deliberately returns its page oldest-first, so it reads
  // like a log and `--follow`'s next call can pick up from the last event
  // shown -- see that route's own docstring. This screen is not a log,
  // though: with DEFAULT_LIMIT = 100, an event arriving live would land at
  // row 100, below the fold, on a screen whose own empty state promises "it
  // will show up here within a few seconds" (Important 5). Reversed here,
  // for display only, so both tabs read newest-first the way the design's
  // mock shows -- the API contract itself is left alone, since the CLI's
  // `--follow` depends on it.
  const display = [...events].reverse()

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Event</TableHead>
          <TableHead>Visitor</TableHead>
          <TableHead>Path</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {display.map((event) => (
          <TableRow key={event.event_id}>
            <TableCell className="font-mono text-muted-foreground">
              {formatEventTime(event.timestamp)}
            </TableCell>
            <TableCell className="font-medium">{event.event_name}</TableCell>
            <TableCell className="font-mono text-muted-foreground">
              {event.user_id || event.anonymous_id}
            </TableCell>
            <TableCell className="text-muted-foreground">
              {event.path || event.url || '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
