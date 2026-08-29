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
function SavedReportRowItem(props: { row: SavedReportRow; hrefFor(id: number): string }) {
  const { row, hrefFor } = props

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border border-border bg-card px-4 py-3">
      <Link to={hrefFor(row.id)} className="flex min-w-0 flex-1 flex-col gap-1 hover:bg-muted">
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
          {row.stale && (
            <Badge variant="secondary" data-testid={`report-stale-${row.id}`}>
              Cannot be read
            </Badge>
          )}
          <span>Updated {formatRelative(row.updatedAt, new Date())}</span>
        </span>
      </Link>
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
}) {
  const { rows, loadFailed, hrefFor, newHref, emptyMessage } = props

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
            <SavedReportRowItem key={r.id} row={r} hrefFor={hrefFor} />
          ))}
        </ul>
      )}
    </>
  )
}
