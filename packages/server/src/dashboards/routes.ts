import type { Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Authenticate } from '../auth/bridge.js'
import { FunnelStore } from '../funnels/store.js'
import { parseNumericId } from '../numeric-id.js'
import { RetentionReportStore } from '../reports/retention-store.js'
import { TrendStore } from '../reports/trend-store.js'
import { type ResolvedTile, resolveTiles } from './resolve.js'
import {
  DashboardStore,
  DuplicateDashboardNameError,
  type StoredDashboard,
  Tiles,
} from './store.js'

export interface DashboardDeps {
  authenticate: Authenticate
  pg: Pool
}

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  tiles: Tiles.optional(),
})

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  tiles: Tiles.optional(),
  is_home: z.boolean().optional(),
})

function parseId(raw: string): number | null {
  return parseNumericId(raw)
}

/** The list row. No tiles: a list of N dashboards must not resolve N layouts.
 *  `shared` is a boolean, never the token -- `store.ts`'s `LIST_COLUMNS`
 *  is what keeps a list of N dashboards from carrying N read credentials
 *  (global constraints, "the token never appears in a list body"); this
 *  wire shape just doesn't add a field that would undo it. */
function toListWire(d: StoredDashboard) {
  return {
    id: d.id,
    name: d.name,
    tile_count: d.tiles.length,
    is_home: d.is_home,
    definition_version: d.definition_version,
    stale: d.stale,
    created_at: d.created_at,
    updated_at: d.updated_at,
    shared: d.shared,
  }
}

function toDetailWire(d: StoredDashboard, tiles: ResolvedTile[]) {
  return { ...toListWire(d), tiles, share: d.share }
}

export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardDeps): void {
  const { authenticate, pg } = deps
  const store = new DashboardStore(pg)
  const stores = {
    trends: new TrendStore(pg),
    retention: new RetentionReportStore(pg),
    funnels: new FunnelStore(pg),
  }

  /** Resolves, and returns the first dangling reference if any. What the
   *  callers below refuse on it is narrow and deliberate: a tile a write
   *  INTRODUCES must name a report in THIS project. A tile already stored
   *  here is never re-checked, because deleting a report is allowed and
   *  leaves every dashboard that pointed at it holding a reference that no
   *  longer resolves -- the read path renders that as `report: null` and
   *  the screen says which report is gone. Re-checking it on write would
   *  make one deleted report freeze the whole layout: the screen sends the
   *  entire tile array on every edit, so the dangling tile rides along with
   *  every move, resize, add and remove, and all of them would 400. */
  async function resolveOrMissing(projectId: number, tiles: z.infer<typeof Tiles>) {
    const resolved = await resolveTiles(stores, projectId, tiles)
    const missing = resolved.find((t) => t.report === null)
    return { resolved, missing }
  }

  app.post('/v1/dashboards', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const body = CreateBody.safeParse(req.body)
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_dashboard',
        detail: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    const tiles = body.data.tiles ?? []
    const { resolved, missing } = await resolveOrMissing(project.id, tiles)
    if (missing) {
      return reply
        .code(400)
        .send({ error: 'report_not_found', kind: missing.kind, report_id: missing.report_id })
    }
    try {
      const created = await store.create(project.id, { name: body.data.name, tiles })
      return reply.code(201).send(toDetailWire(created, resolved))
    } catch (err) {
      if (err instanceof DuplicateDashboardNameError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  app.get('/v1/dashboards', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const dashboards = await store.list(project.id)
    return reply.code(200).send({ dashboards: dashboards.map(toListWire) })
  })

  app.get<{ Params: { id: string } }>('/v1/dashboards/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_dashboard_id' })
    const found = await store.get(project.id, id)
    if (!found) return reply.code(404).send({ error: 'dashboard_not_found' })
    const resolved = await resolveTiles(stores, project.id, found.tiles)
    return reply.code(200).send(toDetailWire(found, resolved))
  })

  app.patch<{ Params: { id: string } }>('/v1/dashboards/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_dashboard_id' })
    const patch = PatchBody.safeParse(req.body)
    if (!patch.success) {
      return reply.code(400).send({
        error: 'invalid_dashboard',
        detail: patch.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    const existing = await store.get(project.id, id)
    if (!existing) return reply.code(404).send({ error: 'dashboard_not_found' })
    if (patch.data.tiles) {
      // Only the tiles this write introduces. A stale row hydrates with
      // `tiles: []`, so nothing is known and every tile in the patch is
      // checked -- which is right: rewriting an unreadable layout is
      // introducing all of it.
      const known = new Set(existing.tiles.map((t) => `${t.kind}:${t.report_id}`))
      const added = patch.data.tiles.filter((t) => !known.has(`${t.kind}:${t.report_id}`))
      const { missing } = await resolveOrMissing(project.id, added)
      if (missing) {
        return reply
          .code(400)
          .send({ error: 'report_not_found', kind: missing.kind, report_id: missing.report_id })
      }
    }
    try {
      const updated = await store.update(project.id, id, patch.data)
      if (!updated) return reply.code(404).send({ error: 'dashboard_not_found' })
      const resolved = await resolveTiles(stores, project.id, updated.tiles)
      return reply.code(200).send(toDetailWire(updated, resolved))
    } catch (err) {
      if (err instanceof DuplicateDashboardNameError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/v1/dashboards/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_dashboard_id' })
    const removed = await store.remove(project.id, id)
    if (!removed) return reply.code(404).send({ error: 'dashboard_not_found' })
    return reply.code(204).send()
  })

  /** Idempotent by design, not by accident: a double-submit (a client
   *  retrying a timed-out request, two tabs open on the same edit screen)
   *  must not rotate the link out from under someone who already copied
   *  it. `store.share` is what makes a second call return the SAME token
   *  rather than minting a new one -- pinned by "mints once, returns the
   *  same link again" in `routes.test.ts`. */
  app.post<{ Params: { id: string } }>('/v1/dashboards/:id/share', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_dashboard_id' })
    const share = await store.share(project.id, id)
    if (!share) return reply.code(404).send({ error: 'dashboard_not_found' })
    return reply.code(200).send(share)
  })

  /** `store.unshare` reports three outcomes, and this is the only place
   *  that fans them back out to different statuses: `dashboard_not_found`
   *  for an id this project doesn't own (the same 404 every other route
   *  here gives a foreign id), and a DISTINCT `not_shared` for a
   *  dashboard that exists but has no link -- a caller revoking twice, or
   *  racing another revoke, needs to tell "there was nothing to undo"
   *  from "that dashboard isn't yours". Pinned by "revokes, then 404
   *  not_shared on a second revoke" in `routes.test.ts`. */
  app.delete<{ Params: { id: string } }>('/v1/dashboards/:id/share', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_dashboard_id' })
    const outcome = await store.unshare(project.id, id)
    if (outcome === 'not_found') return reply.code(404).send({ error: 'dashboard_not_found' })
    if (outcome === 'not_shared') return reply.code(404).send({ error: 'not_shared' })
    return reply.code(204).send()
  })
}
