import { BatchPayload, IngestPayload, isBot, parseUserAgent } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import type { IngestBuffer } from './buffer.js'
import type { IngestCounters } from './counters.js'
import type { GeoResolver } from './geo.js'
import { type CardinalityTracker, checkLimits } from './limits.js'
import { type EventRow, toEventRow } from './row.js'

export interface IngestDeps {
  buffer: IngestBuffer<EventRow>
  projects: ProjectCache
  counters: IngestCounters
  cardinality: CardinalityTracker
  geo: GeoResolver
  readiness: Readiness
  ch: ClickHouseClient
}

const WRITE_KEY_HEADER = 'x-lyraflow-write-key'

async function deadLetter(
  ch: ClickHouseClient,
  projectId: number,
  reason: string,
  detail: string,
  payload: unknown,
): Promise<void> {
  await ch
    .insert({
      table: 'events_dead_letter',
      format: 'JSONEachRow',
      values: [
        {
          project_id: projectId,
          received_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
          reason,
          detail: detail.slice(0, 1000),
          payload: JSON.stringify(payload).slice(0, 8000),
        },
      ],
    })
    .catch(() => {
      // A failing dead-letter write must never fail the request. The event is
      // already lost; failing the caller would only add a broken site to it.
    })
}

export function registerIngestRoutes(app: FastifyInstance, deps: IngestDeps): void {
  const { buffer, projects, counters, cardinality, geo, readiness, ch } = deps

  async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    if (readiness.draining) {
      reply.code(503).header('retry-after', '5').send({ error: 'draining' })
      return null
    }
    const key = req.headers[WRITE_KEY_HEADER]
    if (typeof key !== 'string' || key.length === 0) {
      reply.code(401).send({ error: 'missing_write_key' })
      return null
    }
    const project = await projects.byWriteKey(key)
    if (!project) {
      reply.code(401).send({ error: 'invalid_write_key' })
      return null
    }
    return project
  }

  async function accept(
    req: FastifyRequest,
    projectId: number,
    raw: unknown,
  ): Promise<'accepted' | 'rejected' | 'overloaded'> {
    const ua = req.headers['user-agent']
    if (isBot(ua)) {
      counters.record(projectId, 'rejected')
      return 'rejected'
    }

    const parsed = IngestPayload.safeParse(raw)
    if (!parsed.success) {
      counters.record(projectId, 'rejected')
      await deadLetter(ch, projectId, 'validation_failed', parsed.error.message, raw)
      return 'rejected'
    }

    const limit = checkLimits(parsed.data, cardinality, projectId)
    if (!limit.ok) {
      counters.record(projectId, 'throttled')
      await deadLetter(ch, projectId, limit.reason, limit.detail, raw)
      return 'rejected'
    }

    const row = toEventRow({
      projectId,
      payload: parsed.data,
      now: new Date(),
      trusted: false,
      geo: geo.resolve(req.ip),
      ua: parseUserAgent(ua),
    })

    const outcome = buffer.add(row)
    if (outcome === 'overloaded') {
      counters.record(projectId, 'throttled')
      return 'overloaded'
    }

    cardinality.observe(projectId, row.event_name, [
      ...Object.keys(row.properties),
      ...Object.keys(row.properties_num),
    ])
    counters.record(projectId, 'accepted')
    return 'accepted'
  }

  function single(type: 'track' | 'identify' | 'page') {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const project = await authenticate(req, reply)
      if (!project) return

      const body = { ...(req.body as Record<string, unknown>), type }
      const outcome = await accept(req, project.id, body)
      if (outcome === 'overloaded') {
        return reply.code(503).header('retry-after', '5').send({ error: 'overloaded' })
      }
      // Bad data still returns 202: a tracking endpoint that errors breaks the
      // customer's site, and that loses trust permanently.
      return reply.code(202).send({ status: 'accepted' })
    }
  }

  app.post('/v1/track', single('track'))
  app.post('/v1/identify', single('identify'))
  app.post('/v1/page', single('page'))

  app.post('/v1/batch', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const parsed = BatchPayload.safeParse(req.body)
    if (!parsed.success) {
      counters.record(project.id, 'rejected')
      await deadLetter(ch, project.id, 'validation_failed', parsed.error.message, req.body)
      return reply.code(202).send({ accepted: 0, rejected: 1 })
    }

    let accepted = 0
    let rejected = 0
    for (const item of parsed.data.batch) {
      const outcome = await accept(req, project.id, item)
      if (outcome === 'accepted') accepted++
      else rejected++
    }
    return reply.code(202).send({ accepted, rejected })
  })
}
