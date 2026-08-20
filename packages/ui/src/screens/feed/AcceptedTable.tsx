import { ChevronRight } from 'lucide-react'
import { Fragment, useState } from 'react'
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

/** One `label: value` line of an expanded row. */
interface DetailField {
  label: string
  value: string
}

/**
 * The built-in columns of the events table, in the order an expanded row
 * lists them: what happened, who it happened to, where, which campaign
 * brought them, and what they were using.
 *
 * EVERY field `GET /v1/events` sends, including the ones no column shows.
 * The point of expanding a row is to answer "what exactly did you
 * receive" -- a list that quietly stopped at the four visible columns
 * would answer a different question while looking like it answered that
 * one.
 */
function attributeFields(event: LyraEvent): DetailField[] {
  return [
    { label: 'Event', value: event.event_name },
    { label: 'Time', value: event.timestamp },
    { label: 'Event ID', value: event.event_id },
    { label: 'Anonymous ID', value: event.anonymous_id },
    { label: 'User ID', value: event.user_id },
    { label: 'URL', value: event.url },
    { label: 'Path', value: event.path },
    { label: 'Referrer', value: event.referrer },
    { label: 'UTM source', value: event.utm_source },
    { label: 'UTM medium', value: event.utm_medium },
    { label: 'UTM campaign', value: event.utm_campaign },
    { label: 'UTM term', value: event.utm_term },
    { label: 'UTM content', value: event.utm_content },
    { label: 'Device', value: event.device_type },
    { label: 'OS', value: event.os },
    { label: 'Browser', value: event.browser },
    { label: 'Country', value: event.country },
    { label: 'Region', value: event.region },
    { label: 'City', value: event.city },
  ]
}

/**
 * The event's own properties, both maps merged back into the one map the
 * sender actually wrote.
 *
 * Ingest splits a payload's properties by type -- strings into
 * `properties`, numbers into `properties_num` -- and that split is a
 * storage detail of two ClickHouse `Map` columns, not something the person
 * who wrote `{ plan: 'pro', seats: 12 }` should have to reassemble in
 * their head. A key is only ever in one of the two (`row.ts` moves it, it
 * does not copy it), so merging cannot lose one to the other.
 *
 * Sorted by key, because a `Map` column's iteration order is ClickHouse's,
 * not the sender's: leaving it alone would let the same event's properties
 * reorder between two polls of an open row.
 */
function propertyFields(event: LyraEvent): DetailField[] {
  const strings = Object.entries(event.properties ?? {}).map(([label, value]) => ({
    label,
    value,
  }))
  const numbers = Object.entries(event.properties_num ?? {}).map(([label, value]) => ({
    label,
    // String(), not toLocaleString(): these are the sender's own values,
    // and a property that happens to be an id or a year must not come
    // back reading "2,026" in a panel whose whole job is to show what
    // was received.
    value: String(value),
  }))
  return [...strings, ...numbers].sort((a, b) => a.label.localeCompare(b.label))
}

function FieldList(props: { fields: DetailField[] }) {
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {props.fields.map((field) => (
        <Fragment key={field.label}>
          <dt className="text-muted-foreground">{field.label}</dt>
          {/* `break-all` rather than `truncate`: a URL with a long query
           * string is the most common thing in here, and a truncated one
           * is unreadable in exactly the case someone opened the row to
           * read it. */}
          <dd className="break-all font-mono">
            {field.value === '' ? (
              <span className="text-muted-foreground">(empty)</span>
            ) : (
              field.value
            )}
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

/**
 * Everything the feed knows about one event, revealed under its row.
 *
 * Empty attributes are left out rather than rendered as em dashes: with
 * nineteen built-in fields, of which a typical browser event carries six,
 * listing them all would bury the six. The count of what was dropped is
 * printed instead -- "not shown" and "not received" are different facts
 * and this panel is the wrong place to blur them.
 */
function EventDetail(props: { event: LyraEvent; id: string }) {
  const { event, id } = props
  const attributes = attributeFields(props.event)
  const present = attributes.filter((f) => f.value !== '')
  const emptyCount = attributes.length - present.length
  const properties = propertyFields(event)

  return (
    <div className="grid gap-6 px-4 py-4 md:grid-cols-2" id={id}>
      <section className="min-w-0">
        <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Attributes
        </h3>
        <FieldList fields={present} />
        {emptyCount > 0 && (
          <p className="mt-2 text-muted-foreground text-xs">
            {emptyCount} more {emptyCount === 1 ? 'attribute' : 'attributes'} arrived empty on this
            event and {emptyCount === 1 ? 'is' : 'are'} not listed.
          </p>
        )}
      </section>
      <section className="min-w-0">
        <h3 className="mb-2 font-medium text-muted-foreground text-xs uppercase tracking-wide">
          Properties
        </h3>
        {properties.length === 0 ? (
          <p className="text-muted-foreground text-sm">This event carried no properties.</p>
        ) : (
          <FieldList fields={properties} />
        )}
      </section>
    </div>
  )
}

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

  // Keyed by `event_id`, never by row index: this table is re-rendered from
  // a fresh poll every few seconds and a new event shifts every index down
  // by one. An index would silently move the open panel onto a different
  // event -- the reader would be looking at properties that are not the
  // ones they clicked. An id that has since fallen off the end of the page
  // simply matches nothing, which collapses the panel rather than showing
  // the wrong one.
  const [expandedId, setExpandedId] = useState<string | null>(null)

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
          <TableHead className="w-8">
            <span className="sr-only">Details</span>
          </TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Event</TableHead>
          <TableHead>Visitor</TableHead>
          <TableHead>Path</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {display.map((event) => {
          const open = expandedId === event.event_id
          const detailId = `event-detail-${event.event_id}`
          const toggle = () => setExpandedId(open ? null : event.event_id)
          return (
            <Fragment key={event.event_id}>
              {/* The whole row is the target -- a 16px chevron is a hard
               * thing to hit on a 40px row, and every row is expandable
               * so there is nothing else a click could have meant. The
               * chevron is a real button so the row is reachable by
               * keyboard too; it stops propagation rather than letting
               * the click reach the row's handler as well, which would
               * toggle twice and land back where it started. */}
              <TableRow className="cursor-pointer" onClick={toggle}>
                <TableCell className="pr-0">
                  <button
                    type="button"
                    aria-expanded={open}
                    aria-controls={detailId}
                    aria-label={`${open ? 'Hide' : 'Show'} details for ${event.event_name} at ${formatEventTime(event.timestamp)}`}
                    className="flex size-5 items-center justify-center rounded-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle()
                    }}
                  >
                    <ChevronRight
                      className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`}
                      aria-hidden="true"
                    />
                  </button>
                </TableCell>
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
              {open && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="whitespace-normal bg-muted p-0">
                    <EventDetail event={event} id={detailId} />
                  </TableCell>
                </TableRow>
              )}
            </Fragment>
          )
        })}
      </TableBody>
    </Table>
  )
}
