import { BatchPayload, IngestPayload, isBot, parseUserAgent } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import type { IngestBuffer } from './buffer.js'
import type { IngestCounters } from './counters.js'
import type { GeoResolver } from './geo.js'
import { type CardinalityTracker, checkLimits } from './limits.js'
import { type EventRow, chDateTime, toEventRow } from './row.js'

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

interface DeadLetterRow {
  project_id: number
  received_at: string
  reason: string
  detail: string
  payload: string
}

function buildDeadLetterRow(
  projectId: number,
  reason: string,
  detail: string,
  payload: unknown,
): DeadLetterRow {
  return {
    project_id: projectId,
    received_at: chDateTime(new Date()),
    reason,
    detail: detail.slice(0, 1000),
    payload: JSON.stringify(payload).slice(0, 8000),
  }
}

/**
 * Writes every dead-letter row collected for one request in a single insert.
 * A batch can carry up to 500 items; writing each rejection as its own
 * ClickHouse round trip would let one request — sent with the public,
 * rate-limited write key — hold 500 sequential HTTP calls open against
 * ClickHouse. Dead letters skip IngestBuffer's batching by design (they are
 * already the exceptional path), so batching them here is this function's job.
 */
async function writeDeadLetters(ch: ClickHouseClient, rows: DeadLetterRow[]): Promise<void> {
  if (rows.length === 0) return
  try {
    // A synchronous throw from insert() (closed client, malformed value) must
    // be caught the same as a rejected promise — a bare .catch() attached to
    // the call's return value never runs for a throw that happens before
    // insert() returns a promise at all. See the identical reasoning in
    // IngestBuffer's #flushBatch.
    await ch.insert({ table: 'events_dead_letter', format: 'JSONEachRow', values: rows })
  } catch {
    // A failing dead-letter write must never fail the request. The events are
    // already lost; failing the caller would only add a broken site to it.
  }
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

  interface AcceptResult {
    outcome: 'accepted' | 'rejected' | 'overloaded'
    deadLetter?: DeadLetterRow
  }

  async function accept(
    req: FastifyRequest,
    projectId: number,
    raw: unknown,
  ): Promise<AcceptResult> {
    const ua = req.headers['user-agent']
    if (isBot(ua)) {
      counters.record(projectId, 'rejected')
      return { outcome: 'rejected' }
    }

    const parsed = IngestPayload.safeParse(raw)
    if (!parsed.success) {
      counters.record(projectId, 'rejected')
      return {
        outcome: 'rejected',
        deadLetter: buildDeadLetterRow(projectId, 'validation_failed', parsed.error.message, raw),
      }
    }

    const limit = checkLimits(parsed.data, cardinality, projectId)
    if (!limit.ok) {
      counters.record(projectId, 'throttled')
      return {
        outcome: 'rejected',
        deadLetter: buildDeadLetterRow(projectId, limit.reason, limit.detail, raw),
      }
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
      return { outcome: 'overloaded' }
    }

    cardinality.observe(projectId, row.event_name, [
      ...Object.keys(row.properties),
      ...Object.keys(row.properties_num),
    ])
    counters.record(projectId, 'accepted')
    return { outcome: 'accepted' }
  }

  function single(type: 'track' | 'identify' | 'page') {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const project = await authenticate(req, reply)
      if (!project) return

      const body = { ...(req.body as Record<string, unknown>), type }
      const result = await accept(req, project.id, body)
      if (result.deadLetter) await writeDeadLetters(ch, [result.deadLetter])

      if (result.outcome === 'overloaded') {
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
      await writeDeadLetters(ch, [
        buildDeadLetterRow(project.id, 'validation_failed', parsed.error.message, req.body),
      ])
      return reply.code(202).send({ accepted: 0, rejected: 1 })
    }

    const batch = parsed.data.batch
    let accepted = 0
    let rejected = 0
    const deadLetters: DeadLetterRow[] = []

    for (let i = 0; i < batch.length; i++) {
      const result = await accept(req, project.id, batch[i])
      if (result.deadLetter) deadLetters.push(result.deadLetter)

      if (result.outcome === 'overloaded') {
        // Stop immediately rather than folding this into `rejected`: buffer
        // saturation is transient backpressure, not bad data, and the single
        // endpoint already answers the identical condition with 503. Folding
        // it into `rejected` here would tell the SDK to drop these events
        // forever instead of retrying them.
        //
        // Retrying the whole batch is safe: message_id becomes event_id, and
        // `events` is a ReplacingMergeTree keyed on the full sort key, so a
        // replayed item with the same payload de-duplicates rather than
        // double-counting. That is the design's reason for a
        // client-generated message_id.
        await writeDeadLetters(ch, deadLetters)
        const throttled = batch.length - i
        return reply.code(503).header('retry-after', '5').send({ accepted, rejected, throttled })
      }

      if (result.outcome === 'accepted') accepted++
      else rejected++
    }

    await writeDeadLetters(ch, deadLetters)
    return reply.code(202).send({ accepted, rejected })
  })
}
