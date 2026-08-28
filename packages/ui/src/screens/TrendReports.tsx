import type { Interval } from '@lyraflow/core/trends/ast.js'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { TrendReport } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, trendReportPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import type { SavedReportRow } from './shared/SavedReportList.js'
import { SavedReportList } from './shared/SavedReportList.js'

/** Matches the wording `Trends`' own resolution `<select>` offers
 * (`by minute`/`by hour`/`by day`/`by week`), but as an adjective rather
 * than a preposition phrase -- these sit inline in a `·`-joined summary
 * ("signup · daily · by country"), where "by day" reads as a second
 * "by <thing>" clause next to the actual group-by and would be misread as
 * one. */
const INTERVAL_SUMMARY_LABELS: Record<Interval, string> = {
  '1m': 'minutely',
  '1h': 'hourly',
  '1d': 'daily',
  '1w': 'weekly',
}

/**
 * `group_by`'s wire form is `<source>:<field>` (or the bare literal
 * `event_name`) -- see `groupByOf` in `trends/params.ts`, which is what
 * writes it. This reads it back for display; the two are not the same
 * direction and are not merged, since this side only ever needs the field
 * name, never the source.
 */
function groupBySummary(groupBy: string | null): string | null {
  if (groupBy === null) return null
  if (groupBy === 'event_name') return 'by event name'
  const field = groupBy.includes(':') ? groupBy.slice(groupBy.indexOf(':') + 1) : groupBy
  return `by ${field}`
}

function trendSummary(r: TrendReport): string {
  const parts = [r.event, INTERVAL_SUMMARY_LABELS[r.interval]]
  const gb = groupBySummary(r.group_by)
  if (gb !== null) parts.push(gb)
  return parts.join(' · ')
}

function toRow(r: TrendReport): SavedReportRow {
  // No `stale`: a `TrendReport`'s definition is three scalar columns, never
  // recorded as potentially unparseable -- see `TrendReport`'s own docstring
  // in `api/types.ts`. Retention's mapping (Task 7) sets it.
  return { id: r.id, name: r.name, summary: trendSummary(r), updatedAt: r.updated_at }
}

/**
 * The saved-trends list -- `/trends`' new home now that the URL-driven
 * builder/viewer (still `Trends`, unchanged by this task) lives at
 * `/trends/new` and `/trends/:id`. Fetch/error/401 shape copied from
 * `Funnels` and `Segments` verbatim: `useEffect` on `[client, activeId]`, a
 * `cancelled` flag, a 401 routed to `onUnauthorized`, everything else a
 * generic load-failure flag.
 */
export function TrendReports(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const [reports, setReports] = useState<TrendReport[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (activeId == null) return
    let cancelled = false
    setReports(null)
    setError(false)
    client
      .trendReports(activeId)
      .then((list) => {
        if (!cancelled) setReports(list)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, onUnauthorized])

  async function handleDelete(id: number) {
    if (activeId == null) return
    await client.deleteTrendReport(activeId, id)
    // Removed locally rather than re-fetched -- the row the operator just
    // deleted is exactly the one this filters out, and a re-fetch would
    // cost a request to learn the same thing.
    setReports((prev) => (prev === null ? prev : prev.filter((r) => r.id !== id)))
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Trends</h1>
        <Button asChild size="sm">
          <Link to={ROUTES.trendNew}>New trend</Link>
        </Button>
      </div>

      <SavedReportList
        rows={reports === null ? null : reports.map(toRow)}
        loadFailed={error}
        hrefFor={trendReportPath}
        onDelete={handleDelete}
        newHref={ROUTES.trendNew}
        emptyMessage="No saved trends yet."
      />
    </div>
  )
}
