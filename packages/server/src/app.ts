import type { ClickHouseClient, Pool } from '@lyraflow/db'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { ProjectCache } from './auth/project-cache.js'
import type { Config } from './config.js'
import { registerEventsRoutes } from './events/routes.js'
import { type Readiness, registerHealth } from './health.js'
import { PersonAliases } from './identity/aliases.js'
import { IdentityBindings } from './identity/bindings.js'
import { registerPersonRoutes } from './identity/person.js'
import { resolvePersonScope } from './identity/scope.js'
import { IngestBuffer } from './ingest/buffer.js'
import { IngestCounters } from './ingest/counters.js'
import { NullGeoResolver } from './ingest/geo.js'
import { CardinalityTracker } from './ingest/limits.js'
import { registerIngestRoutes } from './ingest/routes.js'
import type { EventRow } from './ingest/row.js'
import { registerMetrics } from './metrics.js'
import { DeletionStore } from './privacy/deletion-store.js'
import { registerExportRoute } from './privacy/export.js'
import { purgePerson } from './privacy/purge.js'
import { registerPrivacyRoutes } from './privacy/routes.js'
import { SuppressionStore } from './privacy/suppression-store.js'
import { PurgeWorker } from './privacy/worker.js'
import { registerProjectRoutes } from './project/routes.js'
import { RetentionStore } from './retention/store.js'
import { RetentionWorker } from './retention/worker.js'
import { registerSchemaRoutes } from './schema/routes.js'
import { registerSdkRoutes } from './sdk/routes.js'
import { SegmentCache } from './segments/cache.js'
import { registerSegmentRoutes } from './segments/routes.js'

export interface AppDeps {
  config: Config
  pg: Pool
  ch: ClickHouseClient
  readiness: Readiness
  buffer: IngestBuffer<EventRow>
  counters: IngestCounters
  purge: PurgeWorker
  /**
   * Exposed for the same reason `purge` is (see index.ts and
   * shutdown.ts): a live timer belongs to boot succeeding, not to
   * construction, and tests that want to drive a real run do it through
   * `runOnce()` on this exact instance rather than waiting on its own
   * interval — see retention/wiring.test.ts.
   */
  retention: RetentionWorker
  /**
   * Exposed for the same reason `buffer`/`counters`/`purge` already are:
   * tests need to reach the EXACT instance the routes share, not a
   * lookalike constructed separately — see privacy/routes.test.ts's
   * "still returns 202 when the cache invalidation fails" for a spy that
   * depends on this being the real, shared object.
   */
  segmentCache: SegmentCache
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

  // Shared across every registration below, not one instance per
  // registration: registerPersonRoutes's reads must see the same
  // authoritative state (and the same ProjectCache) the write path just
  // wrote through, and constructing a second ProjectCache would also double
  // the Postgres load an identical key lookup produces. Same reasoning is
  // why there is exactly one SuppressionStore/DeletionStore/PurgeWorker: the
  // worker's reads and the routes' writes have to see each other's effects
  // immediately, and a second ProjectCache-shaped duplicate would double the
  // Postgres load an identical lookup produces.
  const projects = new ProjectCache(pg, 60_000)
  const bindings = new IdentityBindings(pg)
  const aliases = new PersonAliases(pg)
  const suppression = new SuppressionStore(pg)
  const deletions = new DeletionStore(pg, suppression)
  // Shared with the privacy routes for the same reason: DELETE
  // /v1/persons/:id must invalidate the SAME cache a preview request can hit
  // within its 30s TTL, or a suppressed person's row can be served back out
  // of a cache that has never heard the deletion happened (see
  // segments/cache.ts's clearProject and privacy/routes.ts's own call to it).
  const segmentCache = new SegmentCache()
  const purge = new PurgeWorker({
    deletions,
    resolve: (projectId, personId, restrictTo) =>
      resolvePersonScope({ bindings, aliases }, projectId, personId, restrictTo),
    purge: (projectId, scope) => purgePerson({ ch, pg, projectId, scope }),
    intervalMs: config.purgeIntervalMs,
    leaseMs: config.purgeLeaseMs,
    maxAttempts: config.purgeMaxAttempts,
    onError: (err, ctx) => app.log.error({ err, ...ctx }, 'purge failed'),
  })

  // Mutated only from `onRun` below, on the single-threaded event loop —
  // no lock needed. `null` until the first successful run completes;
  // registerMetrics renders that as `0`, matching this worker's `onRun`
  // contract (fires once per RUN, never per project) rather than per-project
  // bookkeeping of its own.
  let retentionLastRunAt: number | null = null
  let retentionPartitionsDropped = 0

  const retentionStore = new RetentionStore({ pg, ch, dryRun: false })
  const retention = new RetentionWorker({
    listProjects: () => retentionStore.listProjects(),
    // Guard 5: `RetentionStore#dropExpired` returns every partition it
    // touched but writes nothing down itself — this wrapper is the one
    // place that does. Once a partition is dropped it is gone for good, and
    // this line is the only record it ever existed, so every actual drop is
    // logged at `info` (never behind a debug level, never collapsed into a
    // count) naming the project, table and partition.
    dropExpired: async (target, now) => {
      const results = await retentionStore.dropExpired(target, now)
      for (const r of results) {
        if (r.dropped) {
          app.log.info(
            { projectId: r.projectId, table: r.table, partition: r.partition },
            'retention dropped partition',
          )
        }
      }
      return results
    },
    // The live process clock, not an injected fixed value — `dropExpired`
    // refuses any `now` more than 24h from it (see store.ts), and there is
    // no seam here that would ever need to differ from the real clock.
    now: () => new Date(),
    intervalMs: config.retentionIntervalMs,
    onError: (err, ctx) => app.log.error({ err, ...ctx }, 'retention failed'),
    onRun: (summary) => {
      retentionLastRunAt = summary.at.getTime()
      retentionPartitionsDropped += summary.partitionsDropped
    },
  })

  app.decorate('deps', {
    config,
    pg,
    ch,
    readiness,
    buffer,
    counters,
    purge,
    retention,
    segmentCache,
  } satisfies AppDeps)
  registerHealth(app, readiness)
  // Unauthenticated and dependency-free, like health — registered up front
  // for the same reason.
  registerSdkRoutes(app)
  // Sourced from IngestCounters, not an onResponse hook counting HTTP
  // responses: /v1/batch answers with a single response for up to 500
  // events, so a response-derived count would undercount by up to 500x and
  // couldn't tell the accepted items in a batch from the rejected ones.
  // IngestCounters.record() is already called once per event in
  // registerIngestRoutes, at the exact granularity this metric needs.
  registerMetrics(app, {
    bufferDepth: () => buffer.depth,
    totals: () => counters.totals(),
    retention: () => ({
      lastRunAt: retentionLastRunAt,
      partitionsDropped: retentionPartitionsDropped,
    }),
  })

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
    allowedOrigins: config.allowedOrigins,
  })
  registerPersonRoutes(app, { projects, readiness, ch, bindings, aliases, suppression })
  // Shares `projects`/`bindings`/`aliases` with the registrations above and
  // below rather than constructing new instances — same reasoning as the
  // comment on those three above: two ProjectCache-shaped duplicates would
  // double the Postgres load an identical lookup produces, and the person
  // filter's resolution must see the exact same authoritative state the
  // write path just wrote through.
  registerEventsRoutes(app, {
    projects,
    readiness,
    ch,
    bindings,
    aliases,
    database: config.ch.database,
  })
  registerSegmentRoutes(app, {
    projects,
    readiness,
    ch,
    pg,
    database: config.ch.database,
    cache: segmentCache,
  })
  registerSchemaRoutes(app, { projects, readiness, ch })
  registerProjectRoutes(app, { projects, readiness, pg })
  // One shared object, not one built per registration: registerExportRoute
  // takes the exact same PrivacyDeps registerPrivacyRoutes does (export.ts's
  // own docstring), and constructing a second literal here is exactly the
  // "define a second deps object" that invites the two to drift apart.
  // maxAttempts/leaseMs are the SAME configured values the PurgeWorker above
  // was built with — the status endpoint (routes.ts) uses them to decide
  // "failed" vs "in_progress", and a value that drifted from the worker's
  // own would make that endpoint lie about state the worker itself defines.
  const privacyDeps = {
    projects,
    readiness,
    pg,
    ch,
    bindings,
    aliases,
    deletions,
    suppression,
    segmentCache,
    maxAttempts: config.purgeMaxAttempts,
    leaseMs: config.purgeLeaseMs,
  }
  registerPrivacyRoutes(app, privacyDeps)
  registerExportRoute(app, privacyDeps)

  // Deliberately NOT started here: every route test in this codebase calls
  // buildApp, and a live timer claiming real deletion requests during
  // unrelated tests is exactly the cross-file interference the
  // shared-database rule exists to prevent (see purge/worker.test.ts and
  // this file's own callers). index.ts starts it, once boot has actually
  // succeeded. `retention` follows the identical rule for the identical
  // reason — a live timer issuing real `ALTER TABLE ... DROP PARTITION`
  // calls against the shared test database on every unrelated test file's
  // boot would be its own cross-file interference. index.ts starts it too,
  // conditionally on `config.retentionEnabled`.
  return app
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps
  }
}
