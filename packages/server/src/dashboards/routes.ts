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

/** The list row. No tiles: a list of N dashboards must not resolve N layouts. */
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
  }
}

function toDetailWire(d: StoredDashboard, tiles: ResolvedTile[]) {
  return { ...toListWire(d), tiles }
}

export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardDeps): void {
  const { authenticate, pg } = deps
  const store = new DashboardStore(pg)
  const stores = {
    trends: new TrendStore(pg),
    retention: new RetentionReportStore(pg),
    funnels: new FunnelStore(pg),
  }

  /** Resolves, and returns the first dangling reference if any -- the write
   *  is refused on it. A tile can only dangle by a LATER deletion. */
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
    if (patch.data.tiles) {
      const { missing } = await resolveOrMissing(project.id, patch.data.tiles)
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
}
