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

/** The count, not the predicates themselves: a rendered predicate is a
 * sentence, and three of them beside an event name and a resolution is a
 * list row nobody can scan. The count is enough to tell a filtered report
 * from an unfiltered one, which is the whole job of this line. */
function whereSummary(where: unknown[]): string | null {
  if (where.length === 0) return null
  return where.length === 1 ? '1 filter' : `${where.length} filters`
}

function trendSummary(r: TrendReport): string {
  const parts = [r.event, INTERVAL_SUMMARY_LABELS[r.interval]]
  const w = whereSummary(r.where)
  if (w !== null) parts.push(w)
  const gb = groupBySummary(r.group_by)
  if (gb !== null) parts.push(gb)
  return parts.join(' · ')
}

function toRow(r: TrendReport): SavedReportRow {
  // `stale` IS set now. It was not, and the comment here said a trend's
  // definition was three scalar columns that could never fail to parse --
  // true until `021_trend_predicates.sql` gave it the same `where` grammar
  // retention has.
  return {
    id: r.id,
    name: r.name,
    summary: trendSummary(r),
    updatedAt: r.updated_at,
    stale: r.stale,
  }
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
        newHref={ROUTES.trendNew}
        emptyMessage="No saved trends yet."
      />
    </div>
  )
}
