import type { Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Authenticate } from '../auth/bridge.js'
import { parseNumericId } from '../numeric-id.js'
import { DuplicateTrendNameError, type StoredTrend, TrendStore } from './trend-store.js'

export interface TrendDeps {
  authenticate: Authenticate
  pg: Pool
}

/** Same enum `020_saved_reports.sql`'s CHECK constraint and the UI's
 *  `INTERVALS` agree on -- restated here rather than imported, the same
 *  choice `reports/routes.ts` already made for its own request shapes: the
 *  server package does not depend on the UI package, and the point of
 *  restating it is to refuse an unknown bucket width here rather than let a
 *  CHECK violation reach Postgres as an unmapped 500. */
const Interval = z.enum(['1m', '1h', '1d', '1w'])

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  event: z.string().min(1).max(200),
  interval: Interval,
  // Absent means "no breakdown" -- the same meaning `null` carries once
  // stored, so both are folded to `null` before reaching `TrendStore.create`
  // and the table's own `group_by` column (nullable, no default) never sees
  // a distinction the domain does not have.
  group_by: z.string().min(1).max(200).nullable().optional(),
})

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  event: z.string().min(1).max(200).optional(),
  interval: Interval.optional(),
  // `undefined` (key omitted) leaves the breakdown alone; `null` clears it;
  // a string sets it. Passed straight through to `TrendStore.update`, which
  // draws exactly this distinction -- see that method's own docstring.
  group_by: z.string().min(1).max(200).nullable().optional(),
})

/** See `numeric-id.ts`'s `parseNumericId` for the shape this enforces and why. */
function parseId(raw: string): number | null {
  return parseNumericId(raw)
}

/** Wire shape -- already snake_case in `StoredTrend`, so this is the
 *  boundary that keeps it that way on purpose rather than by coincidence: a
 *  field added to the domain type later must be added here too before a
 *  caller can see it, the same discipline `funnels/routes.ts`'s `toWire`
 *  documents for its own (camelCase) domain type. */
function toWire(t: StoredTrend) {
  return {
    id: t.id,
    name: t.name,
    event: t.event,
    interval: t.interval,
    group_by: t.group_by,
    created_at: t.created_at,
    updated_at: t.updated_at,
  }
}

export function registerTrendRoutes(app: FastifyInstance, deps: TrendDeps): void {
  const { authenticate, pg } = deps
  const store = new TrendStore(pg)

  app.post('/v1/trends', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const body = CreateBody.safeParse(req.body)
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_trend',
        detail: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    try {
      const created = await store.create(project.id, {
        name: body.data.name,
        event: body.data.event,
        interval: body.data.interval,
        group_by: body.data.group_by ?? null,
      })
      return reply.code(201).send(toWire(created))
    } catch (err) {
      if (err instanceof DuplicateTrendNameError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  app.get('/v1/trends', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const trends = await store.list(project.id)
    return reply.code(200).send({ trends: trends.map(toWire) })
  })

  app.get<{ Params: { id: string } }>('/v1/trends/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_trend_id' })
    const found = await store.get(project.id, id)
    if (!found) return reply.code(404).send({ error: 'trend_not_found' })
    return reply.code(200).send(toWire(found))
  })

  app.patch<{ Params: { id: string } }>('/v1/trends/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_trend_id' })
    const patch = PatchBody.safeParse(req.body)
    if (!patch.success) {
      return reply.code(400).send({
        error: 'invalid_trend',
        detail: patch.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    try {
      const updated = await store.update(project.id, id, {
        name: patch.data.name,
        event: patch.data.event,
        interval: patch.data.interval,
        group_by: patch.data.group_by,
      })
      if (!updated) return reply.code(404).send({ error: 'trend_not_found' })
      return reply.code(200).send(toWire(updated))
    } catch (err) {
      if (err instanceof DuplicateTrendNameError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/v1/trends/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_trend_id' })
    const removed = await store.remove(project.id, id)
    if (!removed) return reply.code(404).send({ error: 'trend_not_found' })
    return reply.code(204).send()
  })
}
