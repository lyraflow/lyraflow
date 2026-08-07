import type { ClickHouseClient, Pool } from '@lyraflow/db'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { ProjectCache } from './auth/project-cache.js'
import type { Config } from './config.js'
import { type Readiness, registerHealth } from './health.js'
import { PersonAliases } from './identity/aliases.js'
import { IdentityBindings } from './identity/bindings.js'
import { registerPersonRoutes } from './identity/person.js'
import { IngestBuffer } from './ingest/buffer.js'
import { IngestCounters } from './ingest/counters.js'
import { NullGeoResolver } from './ingest/geo.js'
import { CardinalityTracker } from './ingest/limits.js'
import { registerIngestRoutes } from './ingest/routes.js'
import type { EventRow } from './ingest/row.js'
import { registerMetrics } from './metrics.js'
import { DeletionStore } from './privacy/deletion-store.js'
import { registerPrivacyRoutes } from './privacy/routes.js'
import { SuppressionStore } from './privacy/suppression-store.js'
import { registerSchemaRoutes } from './schema/routes.js'
import { registerSegmentRoutes } from './segments/routes.js'

export interface AppDeps {
  config: Config
  pg: Pool
  ch: ClickHouseClient
  readiness: Readiness
  buffer: IngestBuffer<EventRow>
  counters: IngestCounters
}

export function buildApp(input: {
  config: Config
  pg: Pool
  ch: ClickHouseClient
  readiness: Readiness
}): FastifyInstance {
  const { config, pg, ch, readiness } = input

  // Fastify is constructed first because the buffer's onError logs through it.
  const app = Fastify({
    logger: { level: process.env.LYRAFLOW_LOG_LEVEL ?? 'info' },
    // Browsers cannot be trusted to send small bodies; cap before parsing.
    bodyLimit: 1_048_576,
    trustProxy: true,
  })

  // Rule 1: ingest never returns 5xx for bad data, and reserves 5xx for
  // saturation/outage only — as 503, not 500. authenticate() awaits
  // ProjectCache.byWriteKey, which rethrows on a cold cache during a
  // Postgres outage; without this handler that unhandled rejection becomes
  // Fastify's default 500. This is the backstop for that path and for any
  // other unexpected throw under /v1/*.
  //
  // It must NOT touch errors Fastify itself already resolved correctly
  // before any route handler ran — a malformed JSON body (400) or a body
  // over bodyLimit (413) are genuine, deterministic client errors. Mapping
  // those to 503 would tell the client to retry a request that will fail
  // again every time, and would bury real client bugs under a false
  // "server unavailable" signal. Only an unknown error, or one that already
  // carries a 5xx status, is ours to convert.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (req.url.startsWith('/v1/')) {
      if (err.statusCode !== undefined && err.statusCode < 500) {
        return reply.send(err)
      }
      app.log.error({ err }, 'unhandled ingest error')
      return reply.code(503).header('retry-after', '5').send({ error: 'unavailable' })
    }
    return reply.send(err)
  })

  const buffer = new IngestBuffer<EventRow>({
    flushRows: config.flushRows,
    flushIntervalMs: config.flushIntervalMs,
    maxRows: config.bufferMaxRows,
    insert: async (rows) => {
      await ch.insert({ table: 'events', format: 'JSONEachRow', values: rows })
    },
    onError: (err) => app.log.error({ err }, 'clickhouse insert failed'),
  })
  const counters = new IngestCounters(pg, (err, failed) =>
    app.log.error({ err, failed }, 'ingest counters flush failed'),
  )

  app.decorate('deps', { config, pg, ch, readiness, buffer, counters } satisfies AppDeps)
  registerHealth(app, readiness)
  // Sourced from IngestCounters, not an onResponse hook counting HTTP
  // responses: /v1/batch answers with a single response for up to 500
  // events, so a response-derived count would undercount by up to 500x and
  // couldn't tell the accepted items in a batch from the rejected ones.
  // IngestCounters.record() is already called once per event in
  // registerIngestRoutes, at the exact granularity this metric needs.
  registerMetrics(app, {
    bufferDepth: () => buffer.depth,
    totals: () => counters.totals(),
  })
  // Shared across both route registrations below, not one instance per
  // registration: registerPersonRoutes's reads must see the same
  // authoritative state (and the same ProjectCache) the write path just
  // wrote through, and constructing a second ProjectCache would also double
  // the Postgres load an identical key lookup produces.
  const projects = new ProjectCache(pg, 60_000)
  const bindings = new IdentityBindings(pg)
  const aliases = new PersonAliases(pg)
  const suppression = new SuppressionStore(pg)
  const deletions = new DeletionStore(pg, suppression)

  registerIngestRoutes(app, {
    buffer,
    projects,
    counters,
    cardinality: new CardinalityTracker(),
    geo: new NullGeoResolver(),
    readiness,
    ch,
    bindings,
    aliases,
  })
  registerPersonRoutes(app, { projects, readiness, ch, bindings, aliases, suppression })
  registerSegmentRoutes(app, { projects, readiness, ch, pg, database: config.ch.database })
  registerSchemaRoutes(app, { projects, readiness, ch })
  // maxAttempts: 5 is the literal default `LYRAFLOW_PURGE_MAX_ATTEMPTS` will
  // resolve to once config carries it — a later task wires the configured
  // value through; nothing here reads it from config yet.
  registerPrivacyRoutes(app, {
    projects,
    readiness,
    pg,
    ch,
    bindings,
    aliases,
    deletions,
    suppression,
    maxAttempts: 5,
  })

  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}
