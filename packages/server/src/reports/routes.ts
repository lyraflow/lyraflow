import {
  GRANULARITIES,
  type Granularity,
  MAX_PERIODS,
  Params,
  RetentionValidationError,
  type SegmentQuery,
  compileRetention,
  compileSegment,
} from '@lyraflow/core'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Authenticate } from '../auth/bridge.js'
import { SegmentTimeoutError } from '../segments/execute.js'
import { SegmentStore, StoredTreeError } from '../segments/store.js'
import { runRetention } from './execute.js'

export interface ReportDeps {
  authenticate: Authenticate
  ch: ClickHouseClient
  pg: Pool
  database: string
}

/** Milliseconds in one period, for defaulting the range only. */
const PERIOD_MS: Record<Granularity, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
}

const DEFAULT_PERIODS = 8

const Body = z.object({
  start_event: z.string().min(1).max(128),
  return_event: z.string().min(1).max(128),
  granularity: z.enum(GRANULARITIES).default('week'),
  periods: z.number().int().positive().max(MAX_PERIODS).default(DEFAULT_PERIODS),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  segment_id: z.number().int().positive().nullable().optional(),
})

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
  const segments = new SegmentStore(pg)

  app.post('/v1/reports/retention', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const body = Body.safeParse(req.body ?? {})
    if (!body.success) {
      return reply.code(400).send({
        error: 'validation_failed',
        detail: body.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    const q = body.data

    const now = new Date()
    // Defaulted to the `periods` most recent whole periods, so a caller who
    // sends only two event names gets the grid they meant rather than an
    // empty one. Explicit bounds always win.
    const until = q.until ? new Date(q.until) : now
    const since = q.since
      ? new Date(q.since)
      : new Date(until.getTime() - q.periods * PERIOD_MS[q.granularity])

    const params = new Params()
    const warnings: { path: string; reason: string }[] = []
    let segmentPersonSql: string | undefined

    if (q.segment_id != null) {
      let segment = null
      try {
        segment = await segments.get(project.id, q.segment_id)
      } catch (err) {
        // A segment whose stored tree no longer parses cannot restrict
        // anything. Same treatment as a deleted one, and the same treatment
        // a funnel run gives it: run wide, and say so.
        if (!(err instanceof StoredTreeError)) throw err
      }
      if (segment) {
        segmentPersonSql = compileSegment({
          query: { ast_version: segment.astVersion, filter: segment.filter } as SegmentQuery,
          projectId: project.id,
          database,
          now,
          select: 'persons',
          params,
        }).sql
      } else {
        warnings.push({
          path: 'segment_id',
          reason: `segment ${q.segment_id} no longer exists or cannot be read, so this grid was measured over everyone rather than the population it names`,
        })
      }
    }

    const query = {
      start_event: q.start_event,
      return_event: q.return_event,
      granularity: q.granularity,
      periods: q.periods,
      since: since.toISOString(),
      until: until.toISOString(),
    }

    try {
      const compiled = compileRetention({
        query,
        projectId: project.id,
        database,
        now,
        segmentPersonSql,
        params,
      })
      const result = await runRetention({ client: ch, compiled, query, now })
      return reply.send({
        ...result,
        start_event: q.start_event,
        return_event: q.return_event,
        since: query.since,
        until: query.until,
        // The instant measurability was decided against, echoed so a reader
        // can tell a `null` cell from a stale one: the same request run a
        // week later fills cells in, and nothing else in the response says
        // when "not yet" was evaluated.
        computed_at: now.toISOString(),
        warnings,
      })
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
