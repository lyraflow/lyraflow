import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { type ApiClient, ApiError } from '../../api/client.js'
import type { DashboardTileInput, TileKind } from '../../api/types.js'
import { ROUTES } from '../../app/Router.js'
import { Button } from '../../components/ui/button.js'

/** One choosable row, flattened out of the three list shapes -- all this
 *  control needs from a report is which table it is in, its id and its name. */
interface Choice {
  kind: TileKind
  id: number
  name: string
}

interface Loaded {
  trend: Choice[]
  retention: Choice[]
  funnel: Choice[]
}

const GROUPS: { kind: TileKind; label: string }[] = [
  { kind: 'trend', label: 'Trends' },
  { kind: 'retention', label: 'Retention' },
  { kind: 'funnel', label: 'Funnels' },
]

/**
 * Where "save one first" points, per kind -- read at RENDER time rather than
 * at module scope, which is not a style choice. `Router.tsx` imports the
 * dashboard screen, the screen imports this control, and this control
 * imports `ROUTES` back out of `Router.tsx`: a cycle. A module-level
 * `ROUTES.trendNew` is evaluated while `Router.tsx` is still running its own
 * imports, so `ROUTES` is `undefined` and the whole app dies on load with a
 * `Cannot read properties of undefined` naming a route constant -- which
 * reads as a missing export rather than as an import order. Inside a
 * function the read happens after every module in the cycle has finished.
 * `Router.test.tsx`'s `/dashboards/7` case is what catches a regression: it
 * fails at import, before any assertion.
 */
function newHrefOf(kind: TileKind): string {
  switch (kind) {
    case 'trend':
      return ROUTES.trendNew
    case 'retention':
      return ROUTES.retentionNew
    case 'funnel':
      return ROUTES.funnelNew
  }
}

/**
 * The control that adds a tile: one `<select>` of every saved report,
 * grouped by kind, and an `Add tile` button.
 *
 * A native `<select>` with `<optgroup>`s rather than a combobox widget --
 * the `RangePicker` precedent. Three short lists is not a search problem,
 * and the native control already groups, keyboard-navigates and works on a
 * phone without any of that being written here.
 *
 * **Stale reports are listed.** A stale definition is one this build cannot
 * reproduce, and the TILE says so, per kind, with a link to the report. If
 * this filtered them out instead, a report an operator saved would simply
 * not be in the list, with nothing anywhere saying why.
 *
 * The three lists load together: a partial list would offer a menu that
 * silently omits a whole kind, which reads as "you have no funnels" rather
 * than "one request failed".
 */
export function AddTilePicker(props: {
  client: ApiClient
  projectId: number
  onAdd(tile: DashboardTileInput): void
  /** Held shut while the dashboard has a `PATCH` in flight, for the reason
   *  `TileEditActions.disabled` gives: `onAdd` sends the whole tile array as
   *  it stands on screen plus the new tile, and until the response lands
   *  that array is the pre-edit one. The SELECT stays live -- a half-made
   *  choice is the operator's, not the screen's, and throwing it away for
   *  the duration of a request is the failure this control's own load effect
   *  is written to avoid. */
  disabled?: boolean
  /** The tiles the dashboard already holds. A report on it is LISTED but
   *  disabled, with the reason on it -- the same decision as for a stale
   *  report: a row that vanished from the menu reads as "you have no such
   *  report". The server refuses a second copy anyway (`tiles.<i>` in a
   *  field-level 400); this is so that refusal is never what an operator
   *  sees. */
  present?: DashboardTileInput[]
  onUnauthorized?(): void
}) {
  const { client, projectId, onAdd, disabled, present, onUnauthorized } = props
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)
  const [chosen, setChosen] = useState('')

  // `onUnauthorized` is DELIBERATELY absent, the same decision `DashboardTile`
  // makes and for a sharper reason: this effect calls `setChosen('')`, so
  // depending on a callback whose identity changes per render would refetch
  // the three lists AND throw away the operator's half-made choice every time
  // the parent re-rendered. `App.tsx`'s handler is a plain function, so that
  // is the ordinary case, not a corner. It is only ever a logout route, so the
  // closure being one render old costs nothing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    let cancelled = false
    setLoaded(null)
    setFailed(false)
    setChosen('')
    Promise.all([
      client.trendReports(projectId),
      client.retentionReports(projectId),
      client.funnels(projectId),
    ])
      .then(([trends, retentions, funnels]) => {
        if (cancelled) return
        setLoaded({
          trend: trends.map((r) => ({ kind: 'trend', id: r.id, name: r.name })),
          retention: retentions.map((r) => ({ kind: 'retention', id: r.id, name: r.name })),
          funnel: funnels.map((f) => ({ kind: 'funnel', id: f.id, name: f.name })),
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [client, projectId])

  if (failed) {
    return <p className="text-sm text-destructive">Could not load saved reports.</p>
  }
  if (loaded === null) {
    return <p className="text-sm text-muted-foreground">Loading saved reports…</p>
  }

  const taken = new Set((present ?? []).map((t) => `${t.kind}:${t.report_id}`))
  const choices = [...loaded.trend, ...loaded.retention, ...loaded.funnel]
  const total = choices.length
  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No saved reports to add yet. Save a{' '}
        <Link className="underline" to={newHrefOf('trend')}>
          trend
        </Link>
        , a{' '}
        <Link className="underline" to={newHrefOf('retention')}>
          retention report
        </Link>{' '}
        or a{' '}
        <Link className="underline" to={newHrefOf('funnel')}>
          funnel
        </Link>{' '}
        first.
      </p>
    )
  }

  if (choices.every((c) => taken.has(`${c.kind}:${c.id}`))) {
    return (
      <p className="text-sm text-muted-foreground">
        Every saved report is already on this dashboard.
      </p>
    )
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <select
        aria-label="Report to add"
        value={chosen}
        onChange={(e) => setChosen(e.target.value)}
        className="h-9 min-w-0 rounded-md border border-input bg-background px-2 text-foreground text-sm shadow-xs"
      >
        <option value="">Choose a saved report…</option>
        {GROUPS.map((g) => {
          const rows = loaded[g.kind]
          if (rows.length === 0) return null
          return (
            <optgroup key={g.kind} label={g.label}>
              {rows.map((c) => {
                // `${kind}:${id}` -- an id alone is ambiguous across the
                // three tables, where 2 can name a trend AND a funnel.
                const key = `${c.kind}:${c.id}`
                const onDash = taken.has(key)
                return (
                  <option key={key} value={key} disabled={onDash}>
                    {onDash ? `${c.name} (already on this dashboard)` : c.name}
                  </option>
                )
              })}
            </optgroup>
          )
        })}
      </select>
      <Button
        type="button"
        size="sm"
        // `taken.has(chosen)`: a choice made before the dashboard gained
        // that report from elsewhere (another tab) points at an option
        // that is now disabled, and the native control does not clear it.
        disabled={chosen === '' || taken.has(chosen) || disabled === true}
        onClick={() => {
          const [kind, id] = chosen.split(':')
          if (!kind || !id) return
          onAdd({ kind: kind as TileKind, report_id: Number(id), width: 'half' })
          setChosen('')
        }}
      >
        Add tile
      </Button>
    </div>
  )
}
