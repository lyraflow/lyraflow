import { User } from 'lucide-react'
import { Fragment, useState } from 'react'
import { Link } from 'react-router'
import type { LyraEvent } from '../../api/types.js'
import type { DetailField } from '../../components/DetailList.js'
import { DetailPanel, DetailSection, ExpandToggle, FieldList } from '../../components/DetailList.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js'
import { personPath } from '../people/params.js'
import { formatEventTime } from './format.js'

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
    <DetailPanel id={id}>
      <DetailSection title="Attributes">
        <FieldList fields={present} />
        {emptyCount > 0 && (
          <p className="mt-2 text-muted-foreground text-xs">
            {emptyCount} more {emptyCount === 1 ? 'attribute' : 'attributes'} arrived empty on this
            event and {emptyCount === 1 ? 'is' : 'are'} not listed.
          </p>
        )}
      </DetailSection>
      <DetailSection title="Properties">
        {properties.length === 0 ? (
          <p className="text-muted-foreground text-sm">This event carried no properties.</p>
        ) : (
          <FieldList fields={properties} />
        )}
      </DetailSection>
    </DetailPanel>
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
  /** The window the rows were fetched over, named the way the picker names
   * it, so the empty state can say what it actually looked at. Optional:
   * the table renders correctly without one and simply says less. */
  rangeLabel?: string
  /** The event name the feed is filtered to, or `undefined` for no filter.
   * An empty result under a filter has a different remedy from an empty
   * result without one, and the copy has to offer the right one. */
  filteredEvent?: string
  /**
   * Turns the Visitor cell into a link to that id's profile. **Off by
   * default** so every existing caller and test -- built before
   * `people/People.tsx` existed -- is unaffected.
   *
   * `Feed.tsx` turns this on: which id recorded an event is the identity
   * stitching made visible, and a feed row is usually the first place an
   * operator meets an id worth looking up. The profile's own timeline
   * (`people/Timeline.tsx`) leaves it off -- every row there is the same
   * person already on screen, and a link to the page you are on is noise,
   * not stitching.
   */
  linkPeople?: boolean
}) {
  const { events, loadFailed = false, rangeLabel, filteredEvent, linkPeople = false } = props

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
    /* NAMES THE WINDOW, AND NEVER SAYS "yet".
     *
     * This used to read "No events yet. Send one and it will show up here
     * within a few seconds." -- a claim about the PROJECT, made by a query
     * that only ever looked at one window. Reported by an operator with
     * plenty of data whose last event was eight days old: the screen told
     * him he had none, and the fix he needed was to widen the range, which
     * the sentence gave him no reason to think existed.
     *
     * Distinguishing "nothing in this window" from "nothing ever" needs a
     * second, unbounded query, and an unbounded query is what this screen's
     * range control exists to avoid. So it says the true, narrower thing. */
    return (
      <div className="px-2 py-10 text-center text-sm text-muted-foreground">
        <p data-testid="accepted-empty">
          No events{filteredEvent == null ? '' : ` named ${filteredEvent}`}
          {rangeLabel == null
            ? ''
            : ` in the ${rangeLabel.toLowerCase().replace(/^last /, 'last ')}`}
          .
        </p>
        <p className="mt-1">
          {filteredEvent == null
            ? 'Try a wider range, or send an event and it will appear here within a few seconds.'
            : 'Try a wider range, or clear the filter.'}
        </p>
      </div>
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
                  <ExpandToggle
                    open={open}
                    describes={`${event.event_name} at ${formatEventTime(event.timestamp)}`}
                    controls={detailId}
                    onToggle={toggle}
                  />
                </TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {formatEventTime(event.timestamp)}
                </TableCell>
                <TableCell className="font-medium">{event.event_name}</TableCell>
                <TableCell className="font-mono text-muted-foreground">
                  {linkPeople ? (
                    <Link
                      to={personPath(event.user_id || event.anonymous_id)}
                      className="inline-flex items-center gap-1 hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {/* The icon marks "identified", not "linked" -- every
                       * row here links, but only a non-empty user_id names
                       * a real person. An anonymous_id-only row's link
                       * does NOT open a profile: `resolvePersonScope`
                       * reaches a device only through `identity_bindings`
                       * (its step 4, `mostRecentPersonFor`), and the one
                       * writer of that table is `identify()` carrying both
                       * ids (`ingest/routes.ts`). A visitor who has only
                       * ever been `track`ed therefore has no binding, so
                       * the scope is that id alone with no devices and no
                       * windows, the event summary counts zero, and the
                       * read answers `404 person_not_found` (#18).
                       * The link is offered anyway, deliberately: hiding
                       * it would contradict the feed the operator is
                       * looking at, which is showing that visitor's events
                       * right now, and the profile's four-cause 404 copy
                       * is what handles the landing. The icon is what
                       * marks the rows where the link pays off -- so keep
                       * it on `event.user_id` alone. Widening it to "any
                       * linked row" would promise a profile on exactly the
                       * rows that 404, and turn the icon back into
                       * decoration. */}
                      {event.user_id && <User className="size-4" aria-hidden="true" />}
                      {event.user_id || event.anonymous_id}
                    </Link>
                  ) : (
                    event.user_id || event.anonymous_id
                  )}
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
