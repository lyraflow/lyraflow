import { INTERVALS, MAX_WHERE_PREDICATES, WherePredicate } from '@lyraflow/core'
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

/**
 * `INTERVALS` from `@lyraflow/core` -- the single TypeScript source of truth
 * for the four bucket widths, shaped exactly like `GRANULARITIES` in
 * `reports/routes.ts`'s own precedent: THAT file imports `GRANULARITIES`
 * from core rather than restating it, and this now does the same rather than
 * carrying an independent literal that could drift from `TrendStore`'s own
 * `Interval` (also imported from core -- see `trend-store.ts`).
 *
 * `020_saved_reports.sql`'s CHECK constraint (`interval IN
 * ('1m','1h','1d','1w')`) is still a SEPARATE, hand-written copy, and that is
 * a floor rather than an oversight left over from this fix: SQL cannot
 * import a TypeScript module, so the constraint can only ever be kept in
 * agreement by hand -- exactly the position `granularity`'s own CHECK
 * constraint is already in against `GRANULARITIES`. Two copies (this core
 * constant, the migration) is the fewest this can ever be; one is the
 * fewest the TypeScript side needs, which is what importing here achieves.
 */
const Interval = z.enum(INTERVALS)

/**
 * The `where` predicates' own schema -- the same `z.array(WherePredicate)
 * .max(MAX_WHERE_PREDICATES)` `events/routes.ts` validates a RUN against, so
 * a trend this endpoint will happily save is one that endpoint will happily
 * run. `retention-routes.ts`'s `StoredWhereBody` is the same decision for
 * the same reason.
 */
const StoredWhereBody = z.array(WherePredicate).max(MAX_WHERE_PREDICATES)

const CreateBody = z.object({
  name: z.string().min(1).max(200),
  event: z.string().min(1).max(200),
  interval: Interval,
  // Absent means "no breakdown" -- the same meaning `null` carries once
  // stored, so both are folded to `null` before reaching `TrendStore.create`
  // and the table's own `group_by` column (nullable, no default) never sees
  // a distinction the domain does not have.
  group_by: z.string().min(1).max(200).nullable().optional(),
  // Absent means "no filter" -- the same meaning `[]` carries once stored,
  // and on CREATE there is no stored value to leave alone, so both are
  // folded to `[]` before reaching `TrendStore.create`. `PatchBody` below
  // keeps the distinction, because there it is real.
  where: StoredWhereBody.optional(),
})

const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  event: z.string().min(1).max(200).optional(),
  interval: Interval.optional(),
  // `undefined` (key omitted) leaves the breakdown alone; `null` clears it;
  // a string sets it. Passed straight through to `TrendStore.update`, which
  // draws exactly this distinction -- see that method's own docstring.
  group_by: z.string().min(1).max(200).nullable().optional(),
  // `undefined` (key omitted) leaves the filter alone; `[]` clears it; a
  // list sets it. Passed straight through to `TrendStore.update`, which
  // draws exactly this distinction.
  where: StoredWhereBody.optional(),
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
    where: t.where,
    definition_version: t.definition_version,
    // Always present, never conditional: a client checks one field
    // regardless of whether this row happens to be broken.
    stale: t.stale,
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
        where: body.data.where ?? [],
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
        where: patch.data.where,
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
