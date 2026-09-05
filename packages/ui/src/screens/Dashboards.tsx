import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import type { DashboardSummary } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, dashboardPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import { HomeStar } from './dashboards/HomeStar.js'
import type { SavedReportRow } from './shared/SavedReportList.js'
import { SavedReportList } from './shared/SavedReportList.js'

/** A dashboard's summary line: its tile count, singular for one tile, plus
 * `· home` when it is the one an operator lands on, plus `· shared` when it
 * currently has a live share link -- `DashboardSummary.shared` is the
 * list-safe substitute for the token itself, which the list route never
 * sends (`api/types.ts`'s own comment on that field). Nothing else about a
 * dashboard's layout is worth showing in a list row -- `Dashboard` is where
 * the tiles themselves render, and where the share link is created. */
function summary(d: DashboardSummary): string {
  const parts = [d.tile_count === 1 ? '1 tile' : `${d.tile_count} tiles`]
  if (d.is_home) parts.push('home')
  if (d.shared) parts.push('shared')
  return parts.join(' · ')
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
  const [homeError, setHomeError] = useState(false)
  // The id of the row whose `PATCH` is in flight, or null. One at a time is
  // enough: the star is disabled while its own request runs, so a second one
  // cannot be started from the same row, and two rows cannot be clicked in
  // the same tick.
  const [pending, setPending] = useState<number | null>(null)

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

  /**
   * The home star, per row. Nothing is applied before the response, so a
   * failure needs no rollback -- the same rule `Dashboard`'s own `patch`
   * keeps, and for the same reason: an optimistic star would show the wrong
   * project home for as long as a failing request takes to fail.
   *
   * On success the list is updated from the response rather than refetched.
   * "One home per project" is a database constraint the server has ALREADY
   * applied by the time it answers -- but it answers with the patched
   * dashboard alone and says nothing about the row it cleared, so that half
   * is mirrored here. Refetching would be a second round trip during which
   * the list would show two filled stars.
   */
  const toggleHome = useCallback(
    (row: DashboardSummary) => {
      if (activeId == null) return
      const next = !row.is_home
      setHomeError(false)
      setPending(row.id)
      client
        .patchDashboard(activeId, row.id, { is_home: next })
        .then((d) => {
          setDashboards((prev) =>
            prev === null
              ? prev
              : prev.map((x) => {
                  if (x.id === row.id) return { ...x, is_home: d.is_home }
                  // Setting one home clears every other; clearing one
                  // promotes nothing, so the rest are left alone.
                  return next ? { ...x, is_home: false } : x
                }),
          )
        })
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            onUnauthorized?.()
            return
          }
          setHomeError(true)
        })
        // UNCONDITIONAL: `pending` is what holds the star shut, so a
        // response that failed -- or a 401 that routed away -- must still
        // release it, or the row is frozen for the rest of the session.
        .finally(() => setPending(null))
    },
    [client, activeId, onUnauthorized],
  )

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Dashboards</h1>
        <Button asChild size="sm">
          <Link to={ROUTES.dashboardNew}>New dashboard</Link>
        </Button>
      </div>

      {homeError && (
        <p role="alert" className="text-sm text-destructive">
          Could not change the home dashboard.
        </p>
      )}

      <SavedReportList
        rows={dashboards === null ? null : dashboards.map(toRow)}
        loadFailed={error}
        hrefFor={dashboardPath}
        newHref={ROUTES.dashboardNew}
        emptyMessage="No dashboards yet."
        trailing={(r) => {
          // `SavedReportRow` is a view model and deliberately carries no
          // `is_home`, so the wire row is looked up by id rather than
          // widening the shared interface for one caller's field.
          const d = dashboards?.find((x) => x.id === r.id)
          if (d === undefined) return null
          return (
            <HomeStar
              isHome={d.is_home}
              name={d.name}
              // A second click before the first response lands would send a
              // second `PATCH` for a state the first one is already moving
              // to, and the two could land in either order.
              disabled={pending === d.id}
              onToggle={() => toggleHome(d)}
            />
          )
        }}
      />
    </div>
  )
}
