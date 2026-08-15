import type { Rejection } from '../../api/types.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js'
import { formatEventTime } from './format.js'

export function RejectionsTable(props: { rejections: Rejection[] }) {
  const { rejections } = props

  if (rejections.length === 0) {
    return (
      <p className="px-2 py-10 text-center text-sm text-muted-foreground">
        No rejections. Everything received has been accepted.
      </p>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Time</TableHead>
          <TableHead>Reason</TableHead>
          <TableHead>Detail</TableHead>
          <TableHead>Payload</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {/*
         * This is the point, not an oversight. Two rejections can be
         * byte-identical -- a client looping on one malformed payload is
         * the single most valuable thing this screen ever shows -- and a
         * key derived from row content (reason + detail + payload +
         * received_at) would collide for exactly that case, silently
         * dropping one row from the DOM. The rejections array has no id
         * field at all; the index is the only value guaranteed distinct
         * per row on every poll.
         */}
        {rejections.map((rejection, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: see comment above
          <TableRow key={index}>
            <TableCell className="font-mono text-muted-foreground">
              {formatEventTime(rejection.received_at)}
            </TableCell>
            <TableCell className="font-medium text-destructive">{rejection.reason}</TableCell>
            {/*
             * `detail` is free text -- for validation_failed it's a
             * stringified array of Zod issues and can run to hundreds of
             * characters. Without a bound it rendered at its full intrinsic
             * width and just ran off the table edge mid-character, reading
             * as a broken row rather than truncated content (the same
             * max-w-xs + title treatment Payload already had). `title`
             * keeps the full value one hover away.
             */}
            <TableCell className="max-w-xs truncate text-muted-foreground" title={rejection.detail}>
              {rejection.detail}
            </TableCell>
            <TableCell
              className="max-w-xs truncate font-mono text-muted-foreground"
              title={rejection.payload}
            >
              {rejection.payload}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
