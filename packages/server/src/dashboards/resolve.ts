import { funnelToWire } from '../funnels/routes.js'
import type { FunnelStore } from '../funnels/store.js'
import { retentionReportToWire } from '../reports/retention-routes.js'
import type { RetentionReportStore } from '../reports/retention-store.js'
import { trendToWire } from '../reports/trend-routes.js'
import type { TrendStore } from '../reports/trend-store.js'
import type { Tile, TileKind, TileWidth } from './store.js'

export interface ResolveStores {
  trends: TrendStore
  retention: RetentionReportStore
  funnels: FunnelStore
}

/** A tile with its report embedded in that report's own wire shape, or
 *  `null` when no report of that kind and id exists in this project. */
export interface ResolvedTile {
  kind: TileKind
  report_id: number
  width: TileWidth
  report: Record<string, unknown> | null
}

/**
 * One `list()` per kind that at least one tile names, then a lookup by id.
 * `list()` rather than `get()` so a funnel whose stored definition no
 * longer parses comes back `stale: true` instead of throwing
 * `StoredDefinitionError` -- a dashboard must render every other tile.
 *
 * Scoping is by construction: every store's `list` filters on the project,
 * so a report in another project is simply not in the map. That is the
 * project boundary the routes' write-time check relies on.
 */
export async function resolveTiles(
  stores: ResolveStores,
  projectId: number,
  tiles: Tile[],
): Promise<ResolvedTile[]> {
  const kinds = new Set(tiles.map((t) => t.kind))
  const byKind: Record<TileKind, Map<number, Record<string, unknown>>> = {
    trend: new Map(),
    retention: new Map(),
    funnel: new Map(),
  }
  if (kinds.has('trend')) {
    for (const t of await stores.trends.list(projectId)) byKind.trend.set(t.id, trendToWire(t))
  }
  if (kinds.has('retention')) {
    for (const r of await stores.retention.list(projectId)) {
      byKind.retention.set(r.id, retentionReportToWire(r))
    }
  }
  if (kinds.has('funnel')) {
    for (const f of await stores.funnels.list(projectId)) byKind.funnel.set(f.id, funnelToWire(f))
  }
  return tiles.map((t) => ({
    kind: t.kind,
    report_id: t.report_id,
    width: t.width,
    report: byKind[t.kind].get(t.report_id) ?? null,
  }))
}
