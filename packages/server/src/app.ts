import cookie from '@fastify/cookie'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify'
import { makeServerOrSessionAuthenticator } from './auth/bridge.js'
import { ProjectCache } from './auth/project-cache.js'
import { AttemptLimiter } from './auth/rate-limit.js'
import { registerAuthRoutes } from './auth/routes.js'
import { SessionStore } from './auth/sessions.js'
import type { Config } from './config.js'
import { registerEventsRoutes } from './events/routes.js'
import { registerFunnelRoutes } from './funnels/routes.js'
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
import { registerAdminProjectRoutes } from './project/admin-routes.js'
import { registerProjectRoutes } from './project/routes.js'
import { logDroppedPartition } from './retention/logging.js'
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
  /**
   * Exposed for the same reason `segmentCache` is: Task 11's
   * cache-invalidation test reaches for `app.deps.projects` to assert
   * against the EXACT `ProjectCache` instance every route below shares --
   * constructing a second one there would be asserting against a different
   * object than the routes actually use.
   */
  projects: ProjectCache
  /**
   * Exposed so a test can drive a session lifecycle -- issue, verify,
   * revoke, sweep -- against the SAME store `registerAuthRoutes` reads and
   * writes through, rather than a second `SessionStore` pointed at the same
   * table that happens to agree by coincidence.
   */
  sessions: SessionStore
  /**
   * Exposed so a test can inspect or reset login-attempt state on the EXACT
   * limiter `/v1/auth/login` checks and records against -- a second
   * `AttemptLimiter` would start its own count at zero and never see what
   * the route path actually recorded.
   */
  loginLimiter: AttemptLimiter
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
  // Registered before any route that reads req.cookies. @fastify/cookie is
  // wrapped in fastify-plugin, so it decorates this instance directly and
  // every route below sees it -- unlike @fastify/cors, it registers no
  // wildcard route, so it carries none of the scoping hazard documented in
  // ingest/routes.ts.
  app.register(cookie)

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
  const sessions = new SessionStore(pg)
  const loginLimiter = new AttemptLimiter()
  // Built ONCE and shared by every project-scoped registration below —
  // Task 9's whole point is that a browser session and a project server key
  // resolve through this single implementation, never two. `registerIngestRoutes`
  // deliberately does NOT receive this: its write-key path (and /v1/alias)
  // stay on `makeAuthenticator` directly, so a browser cookie can never
  // reach the ingest surface (see auth/bridge.ts's own docstring).
  const authenticate = makeServerOrSessionAuthenticator({ readiness, projects, sessions })
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

  // Guard 5 — see logging.ts's own docstring for the full reasoning. `onDrop`
  // fires from INSIDE the store, per partition, the instant each `ALTER
  // TABLE ... DROP PARTITION` actually succeeds — not from a wrapper reading
  // `dropExpired`'s returned array after a whole project's sweep finishes.
  // That distinction is load-bearing: RETENTION_TABLES has two tables, so a
  // project can drop several partitions before `dropExpired` would ever
  // return, and a post-hoc wrapper would only ever log once that whole
  // project's work was done — losing every already-executed drop's record
  // if the process were interrupted anywhere inside that window.
  const retentionStore = new RetentionStore({
    pg,
    ch,
    dryRun: false,
    onDrop: (result) => logDroppedPartition(app.log, result),
  })
  const retention = new RetentionWorker({
    listProjects: () => retentionStore.listProjects(),
    dropExpired: (target, now) => retentionStore.dropExpired(target, now),
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
    projects,
    sessions,
    loginLimiter,
  } satisfies AppDeps)
  registerHealth(app, readiness)
  // Unauthenticated and dependency-free, like health — registered up front
  // for the same reason.
  registerSdkRoutes(app)
  registerAuthRoutes(app, { pg, sessions, limiter: loginLimiter, readiness })
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
  registerPersonRoutes(app, { authenticate, ch, bindings, aliases, suppression })
  // Shares `bindings`/`aliases` with the registrations above and below
  // rather than constructing new instances — the person filter's resolution
  // must see the exact same authoritative state the write path just wrote
  // through. `authenticate` is the SAME shared instance every project-scoped
  // registration below gets (see its own comment above) — never a
  // per-registration authenticator, so a session and a server key resolve
  // through identical logic everywhere.
  registerEventsRoutes(app, {
    authenticate,
    ch,
    bindings,
    aliases,
    database: config.ch.database,
  })
  registerSegmentRoutes(app, {
    authenticate,
    ch,
    pg,
    database: config.ch.database,
    cache: segmentCache,
  })
  // Shares the same `ch` and `pg` instances as the registrations around it —
  // a second ProjectCache-shaped duplicate would double the Postgres load an
  // identical lookup produces, which is why `authenticate` (built once,
  // above) is shared rather than rebuilt here too. Deliberately NOT given
  // `segmentCache` — a funnel is run interactively a few times a day rather
  // than per page view, so a cache would buy little and would inherit the
  // staleness #38 is open for.
  registerFunnelRoutes(app, {
    authenticate,
    ch,
    pg,
    database: config.ch.database,
  })
  registerSchemaRoutes(app, { authenticate, ch })
  registerProjectRoutes(app, { authenticate, pg, projects })
  // Session-only and NOT given `authenticate` -- see admin-routes.ts's own
  // docstring for why these two routes must not accept a project server key.
  registerAdminProjectRoutes(app, { pg, sessions, projects, readiness })
  // One shared object, not one built per registration: registerExportRoute
  // takes the exact same PrivacyDeps registerPrivacyRoutes does (export.ts's
  // own docstring), and constructing a second literal here is exactly the
  // "define a second deps object" that invites the two to drift apart.
  // maxAttempts/leaseMs are the SAME configured values the PurgeWorker above
  // was built with — the status endpoint (routes.ts) uses them to decide
  // "failed" vs "in_progress", and a value that drifted from the worker's
  // own would make that endpoint lie about state the worker itself defines.
  const privacyDeps = {
    authenticate,
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
