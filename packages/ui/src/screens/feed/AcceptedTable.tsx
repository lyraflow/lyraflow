import type { LyraEvent } from '../../api/types.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js'

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleTimeString(undefined, { hour12: false })
}

export function AcceptedTable(props: { events: LyraEvent[] }) {
  const { events } = props

  if (events.length === 0) {
    return (
      <p className="px-2 py-10 text-center text-sm text-muted-foreground">
        No events yet. Send one and it will show up here within a few seconds.
      </p>
    )
  }

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
        {events.map((event) => (
          <TableRow key={event.event_id}>
            <TableCell className="font-mono text-muted-foreground">
              {formatTime(event.timestamp)}
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
