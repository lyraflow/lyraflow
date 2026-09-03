import { GRANULARITIES, MAX_PERIODS, MAX_WHERE_PREDICATES, WherePredicate } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Authenticate } from '../auth/bridge.js'
import { parseNumericId } from '../numeric-id.js'
import {
  DuplicateRetentionNameError,
  RetentionReportStore,
  type StoredRetentionReport,
} from './retention-store.js'

export interface RetentionReportDeps {
  authenticate: Authenticate
  pg: Pool
}

/**
 * The `where` predicates' own schema — the SAME one `POST
 * /v1/reports/retention` already validates a run request's
 * `start_where`/`return_where` against (`reports/routes.ts`'s `Body`), not a
 * second notion of a valid predicate restated here. `granularity` and
 * `periods` are the same choice for the same reason: `GRANULARITIES` and
 * `MAX_PERIODS` are the run route's own ceilings, imported rather than
 * re-guessed, so a report this store will happily save can also be run.
 */
const StoredWhereBody = z.array(WherePredicate).max(MAX_WHERE_PREDICATES)

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  start_event: z.string().min(1).max(128),
  return_event: z.string().min(1).max(128),
  start_where: StoredWhereBody.optional(),
  return_where: StoredWhereBody.optional(),
  granularity: z.enum(GRANULARITIES),
  periods: z.number().int().positive().max(MAX_PERIODS),
  // Absent means unrestricted -- the same meaning `null` carries once
  // stored, so both are folded to `null` before reaching
  // `RetentionReportStore.create`.
  segment_id: z.number().int().positive().nullable().optional(),
})

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  start_event: z.string().min(1).max(128).optional(),
  return_event: z.string().min(1).max(128).optional(),
  start_where: StoredWhereBody.optional(),
  return_where: StoredWhereBody.optional(),
  granularity: z.enum(GRANULARITIES).optional(),
  periods: z.number().int().positive().max(MAX_PERIODS).optional(),
  // `undefined` (key omitted) leaves the restriction alone; `null` clears
  // it; a number sets it. Passed straight through to
  // `RetentionReportStore.update`, which draws exactly this distinction --
  // see that method's own docstring.
  segment_id: z.number().int().positive().nullable().optional(),
})

/** See `numeric-id.ts`'s `parseNumericId` for the shape this enforces and why. */
function parseId(raw: string): number | null {
  return parseNumericId(raw)
}

/** Wire shape -- already snake_case in `StoredRetentionReport`, so this is
 *  the boundary that keeps it that way on purpose rather than by
 *  coincidence: a field added to the domain type later must be added here
 *  too before a caller can see it, the same discipline `trend-routes.ts`'s
 *  `toWire` documents for its own type. `stale` is always present, never
 *  conditionally included -- a client checks one field regardless of
 *  whether the row it is looking at happens to be broken. */
function toWire(r: StoredRetentionReport) {
  return {
    id: r.id,
    name: r.name,
    definition_version: r.definition_version,
    start_event: r.start_event,
    return_event: r.return_event,
    start_where: r.start_where,
    return_where: r.return_where,
    granularity: r.granularity,
    periods: r.periods,
    segment_id: r.segment_id,
    stale: r.stale,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

export function registerRetentionReportRoutes(
  app: FastifyInstance,
  deps: RetentionReportDeps,
): void {
  const { authenticate, pg } = deps
  const store = new RetentionReportStore(pg)

  app.post('/v1/retention-reports', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const body = CreateBody.safeParse(req.body)
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_retention_report',
        detail: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    try {
      const created = await store.create(project.id, {
        name: body.data.name,
        start_event: body.data.start_event,
        return_event: body.data.return_event,
        start_where: body.data.start_where ?? [],
        return_where: body.data.return_where ?? [],
        granularity: body.data.granularity,
        periods: body.data.periods,
        segment_id: body.data.segment_id ?? null,
      })
      return reply.code(201).send(toWire(created))
    } catch (err) {
      if (err instanceof DuplicateRetentionNameError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  app.get('/v1/retention-reports', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const reports = await store.list(project.id)
    return reply.code(200).send({ retention_reports: reports.map(toWire) })
  })

  app.get<{ Params: { id: string } }>('/v1/retention-reports/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_retention_report_id' })
    const found = await store.get(project.id, id)
    if (!found) return reply.code(404).send({ error: 'retention_report_not_found' })
    return reply.code(200).send(toWire(found))
  })

  app.patch<{ Params: { id: string } }>('/v1/retention-reports/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_retention_report_id' })
    const patch = PatchBody.safeParse(req.body)
    if (!patch.success) {
      return reply.code(400).send({
        error: 'invalid_retention_report',
        detail: patch.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    try {
      const updated = await store.update(project.id, id, {
        name: patch.data.name,
        start_event: patch.data.start_event,
        return_event: patch.data.return_event,
        start_where: patch.data.start_where,
        return_where: patch.data.return_where,
        granularity: patch.data.granularity,
        periods: patch.data.periods,
        segment_id: patch.data.segment_id,
      })
      if (!updated) return reply.code(404).send({ error: 'retention_report_not_found' })
      return reply.code(200).send(toWire(updated))
    } catch (err) {
      if (err instanceof DuplicateRetentionNameError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/v1/retention-reports/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_retention_report_id' })
    const removed = await store.remove(project.id, id)
    if (!removed) return reply.code(404).send({ error: 'retention_report_not_found' })
    return reply.code(204).send()
  })
}

/** See `trendToWire` in trend-routes.ts. */
export { toWire as retentionReportToWire }
