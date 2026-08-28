import type { Granularity } from '@lyraflow/core/retention/ast.js'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { RetentionReport } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, retentionReportPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import type { SavedReportRow } from './shared/SavedReportList.js'
import { SavedReportList } from './shared/SavedReportList.js'

/** Same adjective-not-preposition choice `TrendReports` makes for
 * `INTERVAL_SUMMARY_LABELS`, and for the same reason: these sit inline in a
 * `·`-joined summary ("signup → purchase · weekly · 8 periods"), where the
 * `<select>`'s own bare noun ("week") would read oddly next to the rest of
 * the phrase. */
const GRANULARITY_SUMMARY_LABELS: Record<Granularity, string> = {
  day: 'daily',
  week: 'weekly',
  month: 'monthly',
}

function retentionSummary(r: RetentionReport): string {
  return [
    `${r.start_event} → ${r.return_event}`,
    GRANULARITY_SUMMARY_LABELS[r.granularity],
    `${r.periods} periods`,
  ].join(' · ')
}

function toRow(r: RetentionReport): SavedReportRow {
  // Unlike `TrendReports`' `toRow`, this DOES set `stale`: a retention
  // report's `start_where`/`return_where` are parsed JSON that can go stale
  // exactly like a funnel's or segment's steps/filter (see `RetentionReport`'s
  // own docstring in `api/types.ts`), and the server always sends the field.
  return {
    id: r.id,
    name: r.name,
    summary: retentionSummary(r),
    updatedAt: r.updated_at,
    stale: r.stale,
  }
}

/**
 * The saved-retention-reports list -- `/retention`'s new home now that the
 * URL-driven builder/viewer (still `Retention`, unchanged by this task)
 * lives at `/retention/new` and `/retention/:id`. Fetch/error/401 shape
 * copied from `TrendReports` verbatim, which itself copied it from
 * `Funnels` and `Segments`: `useEffect` on `[client, activeId]`, a
 * `cancelled` flag, a 401 routed to `onUnauthorized`, everything else a
 * generic load-failure flag.
 */
export function RetentionReports(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const [reports, setReports] = useState<RetentionReport[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (activeId == null) return
    let cancelled = false
    setReports(null)
    setError(false)
    client
      .retentionReports(activeId)
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
    await client.deleteRetentionReport(activeId, id)
    // Removed locally rather than re-fetched -- the row the operator just
    // deleted is exactly the one this filters out, and a re-fetch would
    // cost a request to learn the same thing.
    setReports((prev) => (prev === null ? prev : prev.filter((r) => r.id !== id)))
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Retention</h1>
        <Button asChild size="sm">
          <Link to={ROUTES.retentionNew}>New retention report</Link>
        </Button>
      </div>

      <SavedReportList
        rows={reports === null ? null : reports.map(toRow)}
        loadFailed={error}
        hrefFor={retentionReportPath}
        onDelete={handleDelete}
        newHref={ROUTES.retentionNew}
        emptyMessage="No saved retention reports yet."
      />
    </div>
  )
}
