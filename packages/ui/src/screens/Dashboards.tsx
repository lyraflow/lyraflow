import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { DashboardSummary } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, dashboardPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import type { SavedReportRow } from './shared/SavedReportList.js'
import { SavedReportList } from './shared/SavedReportList.js'

/** A dashboard's summary line: its tile count, singular for one tile, plus
 * `· home` when it is the one an operator lands on. Nothing else about a
 * dashboard's layout is worth showing in a list row -- `Dashboard` (a later
 * task) is where the tiles themselves render. */
function summary(d: DashboardSummary): string {
  const tiles = d.tile_count === 1 ? '1 tile' : `${d.tile_count} tiles`
  return d.is_home ? `${tiles} · home` : tiles
}

function toRow(d: DashboardSummary): SavedReportRow {
  return { id: d.id, name: d.name, summary: summary(d), updatedAt: d.updated_at, stale: d.stale }
}

/**
 * The dashboards list -- the app's first nav entry. Fetch/error/401 shape
 * copied from `TrendReports` verbatim: `useEffect` on `[client, activeId]`,
 * a `cancelled` flag, a 401 routed to `onUnauthorized`, everything else a
 * generic load-failure flag.
 */
export function Dashboards(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const [dashboards, setDashboards] = useState<DashboardSummary[] | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (activeId == null) return
    let cancelled = false
    setDashboards(null)
    setError(false)
    client
      .dashboards(activeId)
      .then((list) => {
        if (!cancelled) setDashboards(list)
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
        <h1 className="text-lg font-semibold">Dashboards</h1>
        <Button asChild size="sm">
          <Link to={ROUTES.dashboardNew}>New dashboard</Link>
        </Button>
      </div>

      <SavedReportList
        rows={dashboards === null ? null : dashboards.map(toRow)}
        loadFailed={error}
        hrefFor={dashboardPath}
        newHref={ROUTES.dashboardNew}
        emptyMessage="No dashboards yet."
      />
    </div>
  )
}
