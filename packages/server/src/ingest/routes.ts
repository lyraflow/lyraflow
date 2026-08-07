import { BatchPayload, IngestPayload, isBot, parseUserAgent } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import type { PersonAliases } from '../identity/aliases.js'
import type { IdentityBindings } from '../identity/bindings.js'
import type { IngestBuffer } from './buffer.js'
import type { IngestCounters } from './counters.js'
import type { GeoResolver } from './geo.js'
import { type CardinalityTracker, checkLimits } from './limits.js'
import { type EventRow, chDateTime, parseChDateTime, toEventRow } from './row.js'

export interface IngestDeps {
  buffer: IngestBuffer<EventRow>
  projects: ProjectCache
  counters: IngestCounters
  cardinality: CardinalityTracker
  geo: GeoResolver
  readiness: Readiness
  ch: ClickHouseClient
  bindings: IdentityBindings
  aliases: PersonAliases
}

const WRITE_KEY_HEADER = 'x-lyraflow-write-key'
// Deliberately distinct from WRITE_KEY_HEADER: the write key is public (it
// ships in browser JavaScript) and can only append events. Aliasing mutates
// identity for the whole project and is not reversible in v0.1 (see
// PersonAliases's docstring), so it is gated on the secret server key
// instead — see `authenticateServer` below.
const SERVER_KEY_HEADER = 'x-lyraflow-server-key'

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
async function writeDeadLetters(
  ch: ClickHouseClient,
  rows: DeadLetterRow[],
  onError: (err: unknown, rows: DeadLetterRow[]) => void,
): Promise<void> {
  if (rows.length === 0) return
  try {
    // A synchronous throw from insert() (closed client, malformed value) must
    // be caught the same as a rejected promise — a bare .catch() attached to
    // the call's return value never runs for a throw that happens before
    // insert() returns a promise at all. See the identical reasoning in
    // IngestBuffer's #flushBatch.
    await ch.insert({ table: 'events_dead_letter', format: 'JSONEachRow', values: rows })
  } catch (err) {
    // A failing dead-letter write must never fail the request. The events are
    // already lost; failing the caller would only add a broken site to it.
    //
    // It must not be silent either: events_dead_letter is the *only* record of
    // rejected data, so a persistently failing write makes bad-data debugging
    // impossible with no signal that anything is wrong. IngestBuffer and
    // IngestCounters both surface their failures through an injected onError
    // wired to the Fastify logger; this follows that convention.
    try {
      onError(err, rows)
    } catch {
      // A throwing logger is a bug in the logger, not a reason to fail a
      // request that was already answered correctly.
    }
  }
}

export function registerIngestRoutes(app: FastifyInstance, deps: IngestDeps): void {
  const { buffer, projects, counters, cardinality, geo, readiness, ch, bindings, aliases } = deps

  const onDeadLetterError = (err: unknown, rows: DeadLetterRow[]) =>
    app.log.error({ err, rows: rows.length }, 'dead-letter write failed')

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

  async function authenticateServer(req: FastifyRequest, reply: FastifyReply) {
    if (readiness.draining) {
      reply.code(503).header('retry-after', '5').send({ error: 'draining' })
      return null
    }
    const key = req.headers[SERVER_KEY_HEADER]
    if (typeof key !== 'string' || key.length === 0) {
      reply.code(401).send({ error: 'missing_server_key' })
      return null
    }
    const project = await projects.byServerKey(key)
    if (!project) {
      reply.code(401).send({ error: 'invalid_server_key' })
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

    // identify carrying both ids ties a device to a person. Only identify
    // requires user_id, so this branch is unreachable for track/page, and
    // anonymous_id is the one optional field left to check. Binds at the
    // event's own (clamped) timestamp — row.timestamp, not `new Date()` —
    // because a late-delivered identify must bind at the instant it
    // happened, not the instant it arrived; identity resolution is
    // time-ranged and depends on this (see IdentityBindings.bind).
    if (parsed.data.type === 'identify' && parsed.data.anonymous_id) {
      try {
        await bindings.bind(
          projectId,
          parsed.data.anonymous_id,
          parsed.data.user_id,
          parseChDateTime(row.timestamp),
        )
      } catch (err) {
        // The event is already accepted into the buffer. A failing binding
        // write must not turn a good, already-accepted event into an error
        // for the customer's site — same rule 1 reasoning as
        // writeDeadLetters above. It must not be silent either, so this
        // follows the same onError-through-the-Fastify-logger convention.
        app.log.error({ err }, 'identity binding write failed')
      }
    }

    return { outcome: 'accepted' }
  }

  function single(type: 'track' | 'identify' | 'page') {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const project = await authenticate(req, reply)
      if (!project) return

      const body = { ...(req.body as Record<string, unknown>), type }
      const result = await accept(req, project.id, body)
      if (result.deadLetter) await writeDeadLetters(ch, [result.deadLetter], onDeadLetterError)

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
      await writeDeadLetters(
        ch,
        [buildDeadLetterRow(project.id, 'validation_failed', parsed.error.message, req.body)],
        onDeadLetterError,
      )
      return reply.code(202).send({ accepted: 0, rejected: 1, throttled: 0 })
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
        // Retrying the whole batch is safe because message_id becomes
        // event_id and every query deduplicates by event_id — NOT because the
        // storage engine collapses the replayed rows. `events` is a
        // ReplacingMergeTree, but it only collapses when the entire ORDER BY
        // tuple matches: (project_id, timestamp, anonymous_id, event_id). When
        // a client omits `timestamp`, row.ts fills it with server wall-clock
        // at receipt, so a retry seconds later has a different sort key and
        // persists as a second physical row forever. The counts stay correct;
        // the storage does not. A client that sends an explicit `timestamp`
        // and replays it unchanged does get engine-level collapsing — see the
        // API section of README.md, and the
        // `retried event with a server-assigned timestamp` test in
        // schema-clickhouse.test.ts, which pins this behaviour honestly.
        await writeDeadLetters(ch, deadLetters, onDeadLetterError)
        // accept() already recorded item i itself as 'throttled'; the
        // remaining batch.length - i - 1 items were never attempted at all
        // (the loop stops here) and so never went through accept() to be
        // counted. Without this, the counter — and the Postgres quota table
        // it flushes into — would undercount by up to 500x under exactly the
        // saturation condition an operator relies on this metric to catch.
        // When the overloaded item is the batch's last (i === batch.length -
        // 1), this is record(..., 0) — a harmless zero-delta call that folds
        // into IngestCounters' pending tally and no-ops through to Postgres.
        counters.record(project.id, 'throttled', batch.length - i - 1)
        const throttled = batch.length - i
        return reply.code(503).header('retry-after', '5').send({ accepted, rejected, throttled })
      }

      if (result.outcome === 'accepted') accepted++
      else rejected++
    }

    await writeDeadLetters(ch, deadLetters, onDeadLetterError)
    // throttled is always present, even at 0: an SDK parsing a stable shape
    // shouldn't need to special-case the field's absence versus its value.
    return reply.code(202).send({ accepted, rejected, throttled: 0 })
  })

  interface AliasBody {
    from_user_id?: unknown
    to_user_id?: unknown
  }

  // Not an ingest endpoint: aliasing performs the mutation directly rather
  // than accepting-then-processing an event, so — unlike /v1/track,
  // /v1/identify, /v1/page and /v1/batch — a malformed request here is a
  // genuine client error, answered with a real 4xx rather than a
  // universal 202.
  app.post('/v1/alias', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return

    // req.body is undefined for a bodyless request (unlike the ingest
    // routes above, which always spread it into an object); guard before
    // indexing rather than letting that throw and fall through to the
    // generic /v1/* 503 handler for what is really a 400.
    const body = (req.body ?? {}) as AliasBody
    const fromUserId = body.from_user_id
    const toUserId = body.to_user_id
    if (
      typeof fromUserId !== 'string' ||
      fromUserId.length === 0 ||
      typeof toUserId !== 'string' ||
      toUserId.length === 0
    ) {
      return reply.code(400).send({ error: 'invalid_body' })
    }

    const result = await aliases.alias(project.id, fromUserId, toUserId)
    return reply.code(200).send({ status: result })
  })
}
