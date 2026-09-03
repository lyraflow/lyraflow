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

const NEW_HREF: Record<TileKind, string> = {
  trend: ROUTES.trendNew,
  retention: ROUTES.retentionNew,
  funnel: ROUTES.funnelNew,
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
  onUnauthorized?(): void
}) {
  const { client, projectId, onAdd, onUnauthorized } = props
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

  const total = loaded.trend.length + loaded.retention.length + loaded.funnel.length
  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No saved reports to add yet. Save a{' '}
        <Link className="underline" to={NEW_HREF.trend}>
          trend
        </Link>
        , a{' '}
        <Link className="underline" to={NEW_HREF.retention}>
          retention report
        </Link>{' '}
        or a{' '}
        <Link className="underline" to={NEW_HREF.funnel}>
          funnel
        </Link>{' '}
        first.
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
              {rows.map((c) => (
                // `${kind}:${id}` -- an id alone is ambiguous across the
                // three tables, where 2 can name a trend AND a funnel.
                <option key={`${c.kind}:${c.id}`} value={`${c.kind}:${c.id}`}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          )
        })}
      </select>
      <Button
        type="button"
        size="sm"
        disabled={chosen === ''}
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
