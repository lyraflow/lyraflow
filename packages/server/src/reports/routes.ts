import { RetentionValidationError } from '@lyraflow/core'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import type { Authenticate } from '../auth/bridge.js'
import { SegmentTimeoutError } from '../segments/execute.js'
import { RetentionBody, runRetentionReport } from './retention-run.js'

export interface ReportDeps {
  authenticate: Authenticate
  ch: ClickHouseClient
  pg: Pool
  database: string
}

/**
 * `POST /v1/reports/retention` — a retention grid, computed and returned.
 *
 * **Ad hoc, and deliberately not stored.** Funnels and segments have stores
 * because they are things you name and revisit; a retention grid is two
 * event names, a range and a granularity, which is small enough to live in
 * the URL. That is the pattern the Feed already uses for its window and
 * filter, and it makes the screen shareable as a link without a migration,
 * a definition version, or a second set of CRUD routes to keep in agreement
 * with the first two.
 *
 * POST rather than GET despite being a read: a `segment_id` plus two event
 * names plus a range is a body, and every other report in the product that
 * takes a definition is a POST. It is not cached and does not need to be.
 */
export function registerReportRoutes(app: FastifyInstance, deps: ReportDeps): void {
  const { authenticate, ch, pg, database } = deps

  app.post('/v1/reports/retention', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const body = RetentionBody.safeParse(req.body ?? {})
    if (!body.success) {
      return reply.code(400).send({
        error: 'validation_failed',
        detail: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    try {
      return reply.send(await runRetentionReport({ ch, pg, database }, project, body.data))
    } catch (err) {
      if (err instanceof RetentionValidationError) {
        return reply.code(400).send({ error: err.code, detail: err.message })
      }
      if (err instanceof SegmentTimeoutError) {
        return reply.code(503).send({
          error: 'query_timeout',
          detail: 'this grid took too long to compute; narrow the range or the granularity',
        })
      }
      throw err
    }
  })
}
