import type { ClickHouseClient, Pool } from '@lyraflow/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { ProjectCache } from './auth/project-cache.js'
import type { Config } from './config.js'
import { type Readiness, registerHealth } from './health.js'
import { IngestBuffer } from './ingest/buffer.js'
import { IngestCounters } from './ingest/counters.js'
import { NullGeoResolver } from './ingest/geo.js'
import { CardinalityTracker } from './ingest/limits.js'
import { registerIngestRoutes } from './ingest/routes.js'
import type { EventRow } from './ingest/row.js'

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
  app.setErrorHandler((err, req, reply) => {
    if (req.url.startsWith('/v1/')) {
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
  registerIngestRoutes(app, {
    buffer,
    projects: new ProjectCache(pg, 60_000),
    counters,
    cardinality: new CardinalityTracker(),
    geo: new NullGeoResolver(),
    readiness,
    ch,
  })

  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}
