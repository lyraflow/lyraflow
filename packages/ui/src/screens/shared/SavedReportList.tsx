import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Badge } from '../../components/ui/badge.js'
import { formatRelative } from '../funnels/format.js'

/**
 * A VIEW MODEL, deliberately not the wire shape: `summary` is derived for
 * display by the caller (a trend's `event · interval · group_by`, a
 * retention definition's start/return events) and `updatedAt` is camelCase
 * because nothing serialises this. Each list screen maps its own wire rows
 * into it, which is what lets one component serve two report types that
 * share no columns.
 *
 * `stale` is optional rather than always-`false` because it names a fact
 * only ONE of the two callers has: a trend's definition is three scalar
 * columns with nothing that can fail to parse (see `TrendReport`'s own
 * docstring in `api/types.ts`), so `TrendReports` never sets it. Retention's
 * `start_where`/`return_where` are parsed JSON that can go stale exactly
 * like a funnel's or segment's steps/filter, so that caller passes it
 * through.
 */
export interface SavedReportRow {
  id: number
  name: string
  summary: string
  updatedAt: string
  stale?: boolean
}

/**
 * One row: a click-through link carrying the name, summary and a relative
 * "updated" timestamp (mirrors `FunnelRow`/`SegmentRow`'s own shape). Delete
 * lives on the detail screen a row's link opens, not here -- the same place
 * `Funnels`/`FunnelDetail` and `Segments`/`SegmentDetail` already put it, so
 * a saved report follows the one interface convention every other list in
 * this package already uses.
 */
function SavedReportRowItem(props: {
  row: SavedReportRow
  hrefFor(id: number): string
  trailing?: (row: SavedReportRow) => ReactNode
}) {
  const { row, hrefFor, trailing } = props
  const after = trailing?.(row)

  const link = (
    <Link
      to={hrefFor(row.id)}
      className={
        after == null
          ? 'flex flex-col gap-1 rounded-md border border-border bg-card px-4 py-3 hover:bg-muted'
          : // `min-w-0` for the same reason the name and summary inside carry
            // it: without it a flex child refuses to shrink below its content
            // and the trailing control is pushed off the row instead.
            'flex min-w-0 flex-1 flex-col gap-1 rounded-md border border-border bg-card px-4 py-3 hover:bg-muted'
      }
    >
      {/* `break-words` for the SAME reason the summary below carries it,
       * and it is the name that actually needed it: a report name is
       * typed by an operator and often has no spaces at all
       * (`checkout_funnel_weekly_breakdown_by_utm_source_and_plan_tier_v2`).
       * Without it that one line ran ~180px past the card's right border
       * at 390px wide, taking the whole list into horizontal scroll with
       * it. `break-words` rather than `break-all`, so an ordinary
       * multi-word name still breaks at its spaces. */}
      <span className="min-w-0 break-words font-medium text-foreground">{row.name}</span>
      <span className="min-w-0 break-words text-sm text-muted-foreground">{row.summary}</span>
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        {/* `destructive`, not the `secondary` grey this design system
         * uses for metadata (#213): at a glance the low-contrast badge
         * read like the "Updated ..." timestamp beside it rather than as
         * a warning that the report cannot be reproduced as it was saved.
         * The detail screen states the problem plainly once the report is
         * open; the list is where an operator picks WHICH one to open,
         * which is the one place understating it costs something.
         *
         * A deliberate exception rather than a system-wide move.
         * `Funnels.tsx`'s own `secondary` badge reads "Segment filter" --
         * genuine metadata -- and Funnels says "Steps cannot be read" as
         * text in its step summary rather than as a badge at all. The two
         * say different kinds of thing, so nothing there changes. */}
        {row.stale && (
          <Badge variant="destructive" data-testid={`report-stale-${row.id}`}>
            Cannot be read
          </Badge>
        )}
        <span>Updated {formatRelative(row.updatedAt, new Date())}</span>
      </span>
    </Link>
  )

  // No trailing node means the row is EXACTLY what it was before this prop
  // existed -- a bare `<li>` wrapping the link, with no flex row and no
  // extra classes. Trends and retention pass nothing, and their tests
  // (including "renders no button at all") pin that.
  if (after == null) return <li>{link}</li>

  return (
    <li className="flex items-center gap-2">
      {link}
      {after}
    </li>
  )
}

/**
 * The body of a saved-report list screen -- loading, load-failure, empty and
 * populated states -- extracted from `Funnels`/`Segments`' own shape so
 * `TrendReports` and (Task 7) retention's list screen share it rather than
 * each writing a second copy. The header (title, and the persistent "create
 * new" button) stays in each screen, same as `Funnels` and `Segments`
 * already diverge there: the button's own label names the report type
 * ("New trend" vs. "New retention report"), which this component has no way
 * to know.
 *
 * `rows === null` (still loading) renders nothing, matching `Funnels`: no
 * spinner, just an empty body until the fetch resolves.
 *
 * `loadFailed` and an empty `rows` are two DIFFERENT facts and must render
 * differently -- issue #82, already learned by the feed. Folding them into
 * one "nothing here" message would tell an operator whose request failed
 * that there is simply nothing saved, which is not what the query
 * established.
 */
export function SavedReportList(props: {
  rows: SavedReportRow[] | null
  loadFailed: boolean
  hrefFor(id: number): string
  newHref: string
  emptyMessage: string
  /**
   * An OPTIONAL per-row control, rendered inside the `<li>` and beside the
   * link rather than inside it. Dashboards passes a home star; trends and
   * retention pass nothing and get the row exactly as it was.
   *
   * Outside the anchor is the requirement, not a layout preference: a
   * `<button>` nested in an `<a>` is invalid HTML, and a click on it
   * navigates as well as acting. That is also why this is a render prop
   * and not a `ReactNode` -- the control needs to know which row it is on.
   */
  trailing?: (row: SavedReportRow) => ReactNode
}) {
  const { rows, loadFailed, hrefFor, newHref, emptyMessage, trailing } = props

  return (
    <>
      {loadFailed && (
        <p role="alert" className="text-sm text-destructive">
          Could not load saved reports. Reload to try again.
        </p>
      )}

      {rows != null && rows.length === 0 && !loadFailed && (
        // The link is styled, because an unstyled `Link` inside a muted
        // paragraph is the same colour and weight as the sentence around it
        // -- on screen it reads as the last two words of the message rather
        // than as the control it is. Same treatment the in-app links on the
        // funnel and segment detail screens already use.
        <p className="text-sm text-muted-foreground">
          {emptyMessage}{' '}
          <Link to={newHref} className="text-primary hover:underline">
            Create one
          </Link>
        </p>
      )}

      {rows != null && rows.length > 0 && (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <SavedReportRowItem key={r.id} row={r} hrefFor={hrefFor} trailing={trailing} />
          ))}
        </ul>
      )}
    </>
  )
}
