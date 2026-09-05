import { FunnelValidationError, RetentionValidationError, WherePredicate } from '@lyraflow/core'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AttemptLimiter } from '../auth/rate-limit.js'
import { resolveTiles } from '../dashboards/resolve.js'
import { DashboardStore, SHARE_TOKEN_PATTERN, type Tile } from '../dashboards/store.js'
import { BreakdownError, parseBreakdown } from '../events/breakdown.js'
import { StatsQueryError, runStats } from '../events/stats.js'
import { FUNNEL_DEFAULT_RANGE_MS, makeFunnelRunner } from '../funnels/run.js'
import { FunnelStore, StoredDefinitionError } from '../funnels/store.js'
import { type Readiness, refuseIfDraining } from '../health.js'
import { RetentionBody, runRetentionReport } from '../reports/retention-run.js'
import { RetentionReportStore } from '../reports/retention-store.js'
import { TrendStore } from '../reports/trend-store.js'
import { SegmentTimeoutError } from '../segments/execute.js'
import { type InFlightCap, type ResultCache, SHARED_RUN_WINDOW_MS } from './limits.js'
import { type RangePreset, RangePresetSchema, resolvePreset } from './range.js'

export interface SharedDeps {
  pg: Pool
  ch: ClickHouseClient
  database: string
  readiness: Readiness
  limiter: AttemptLimiter
  inFlight: InFlightCap
  cache: ResultCache<unknown>
}

const RunBody = z.object({ range: RangePresetSchema })

/** Every "no" this surface says about the token is the same 404: unknown,
 *  malformed, revoked, deleted. The shape of a valid token is not something
 *  to teach a guesser, and neither is which of the four it was -- the one
 *  body is pinned by the "with one body" test in `routes.test.ts`. */
function shareNotFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'share_not_found' })
}

/** What `runTile` answers with: a body to cache and send as 200, or a
 *  status the tile's own report endpoint would have sent, which is never
 *  cached -- a refusal that depends on a stored definition must be
 *  re-derived once that definition changes. */
type TileOutcome = { body: unknown } | { status: number; body: unknown }

/**
 * The first unauthenticated read path in the product. NO `authenticate` in
 * its deps, on purpose: the token is the whole credential, it names one
 * dashboard, and it cannot be presented anywhere else -- the authenticators
 * look a 43-character string up as a server key or a session and find
 * nothing, which `routes.test.ts` pins from both sides ("ignores a valid
 * session cookie and a valid server key" and "a share token opens nothing
 * under the authenticated surface"). Registered without CORS, like every
 * non-ingest route.
 */
export function registerSharedRoutes(app: FastifyInstance, deps: SharedDeps): void {
  const { pg, ch, database, readiness, limiter, inFlight, cache } = deps
  const store = new DashboardStore(pg)
  const stores = {
    trends: new TrendStore(pg),
    retention: new RetentionReportStore(pg),
    funnels: new FunnelStore(pg),
  }
  const funnels = makeFunnelRunner({ ch, pg, database })

  /** The drain gate runs FIRST, before the token pattern check, so a
   *  draining server answers 503 to everything on this surface rather than
   *  503 to some of it and 404 to the rest -- pinned by the draining test,
   *  which asks with a well-formed token and a malformed one. */
  async function lookup(raw: string, reply: FastifyReply) {
    if (refuseIfDraining(readiness, reply)) return null
    // A path segment that cannot be a token is not worth a query. Postgres
    // would answer 404 for it anyway, so the guard is pinned by the spy
    // assertion in `routes.test.ts` rather than by a status code.
    if (!SHARE_TOKEN_PATTERN.test(raw)) {
      shareNotFound(reply)
      return null
    }
    const found = await store.byShareToken(raw)
    if (!found) {
      shareNotFound(reply)
      return null
    }
    return found
  }

  /**
   * The layout and the definitions it names, and nothing else -- no
   * dashboard id, no `is_home`, no project. The token holder is not an
   * operator: they can see what this one dashboard asks, and cannot learn
   * that the dashboard has an id worth guessing or a project it belongs
   * to. `no-store` because the body is a credentialed read and every
   * intermediary on the path to a shared link is one nobody chose.
   */
  app.get<{ Params: { token: string } }>('/v1/shared/:token', async (req, reply) => {
    const found = await lookup(req.params.token, reply)
    if (!found) return
    const { projectId, dashboard } = found
    const tiles = await resolveTiles(stores, projectId, dashboard.tiles)
    reply.header('cache-control', 'no-store')
    return reply.code(200).send({
      name: dashboard.name,
      updated_at: dashboard.updated_at,
      stale: dashboard.stale,
      tiles,
    })
  })

  /**
   * One tile, run at one preset. Everything the query is built from comes
   * from the STORED report -- the caller chooses which tile and which of
   * seven presets, and nothing else, so a token holder can ask nothing the
   * dashboard does not already ask.
   *
   * The three bounds are checked in the order cheapest-and-most-generous
   * first: a cache hit is served before either limit is consulted, because
   * a repeat of a question already answered costs no query and counting it
   * would make an ordinary page refresh look like an attack. The limiter
   * then bounds runs over a window, and the in-flight cap bounds
   * concurrent ones -- a single request cannot pass the first and be
   * refused by the second without having actually been admitted, which is
   * why `limiter.record` happens after both.
   */
  app.post<{ Params: { token: string; index: string } }>(
    '/v1/shared/:token/tiles/:index/run',
    async (req, reply) => {
      const found = await lookup(req.params.token, reply)
      if (!found) return
      const { projectId, dashboard } = found
      const token = req.params.token

      const body = RunBody.safeParse(req.body ?? {})
      if (!body.success) return reply.code(400).send({ error: 'invalid_range' })
      const preset = body.data.range

      // `/^\d+$/` rather than `Number()`: `-1`, `0.5` and `x` must all be
      // the same "there is no such tile" answer, and `Number('0.5')` would
      // otherwise index the array with a float and `Number('')` with zero.
      const index = /^\d+$/.test(req.params.index) ? Number(req.params.index) : -1
      const tile: Tile | undefined = dashboard.tiles[index]
      if (!tile) return reply.code(404).send({ error: 'tile_not_found' })

      // Keyed by token, not by dashboard id: revoking a link must not let
      // the next link to the same dashboard inherit its warm entries, and
      // a revoked token never reaches here at all because `lookup` above
      // already failed for it.
      // `no-store` on every answer this route gives, for the GET's reason:
      // the body is a credentialed read, and a POST being uncacheable by
      // default is a property of the method rather than a decision anyone
      // made about this data. Set before the first `send` so a cache hit
      // carries it too.
      reply.header('cache-control', 'no-store')

      const key = `${token}:${index}:${preset}`
      const cached = cache.get(key)
      if (cached !== undefined) return reply.code(200).send(cached)

      // `share:` namespaces the key inside `AttemptLimiter`, which bounds
      // each namespace's map independently -- see that class's own
      // docstring for why a caller-influenced key needs its own namespace
      // rather than sharing the login route's.
      const limitKey = `share:${token}`
      if (!limiter.check([limitKey])) {
        return (
          reply
            .code(429)
            // The whole window, not a computed remainder: the limiter keeps
            // per-attempt timestamps but exposes no "when does the oldest
            // expire", and a client that waits the full window is always
            // right where one that waits a guess is sometimes wrong.
            .header('retry-after', String(Math.ceil(SHARED_RUN_WINDOW_MS / 1000)))
            .send({ error: 'too_many_runs' })
        )
      }
      if (!inFlight.acquire(token)) {
        // One second, because this refusal is about what is running right
        // now rather than about a window: the runs ahead of this one are
        // in flight, not scheduled.
        return reply.code(429).header('retry-after', '1').send({ error: 'too_many_runs' })
      }
      limiter.record([limitKey])
      try {
        const out = await runTile(projectId, tile, preset)
        if ('status' in out) return reply.code(out.status).send(out.body)
        cache.set(key, out.body)
        return reply.code(200).send(out.body)
      } finally {
        inFlight.release(token)
      }
    },
  )

  /**
   * Builds the request from the STORED report -- never from the caller --
   * and runs it through the same lifted function the report's own route
   * calls, so a tile on a shared page and the same tile on the operator's
   * dashboard cannot answer differently.
   *
   * ONE clock reading for the whole call: `resolvePreset` takes `now` for
   * that reason, and the funnel's own `auto` fallback below reuses the
   * same instant rather than reading the clock a second time.
   *
   * Both `stale_definition` refusals come BEFORE any parse of the stored
   * definition. A stale row's `where` is whatever a past or future build
   * wrote and this one cannot read, so running it would answer a question
   * nobody saved -- and answering with `invalid_where` instead would blame
   * the caller for a row they cannot see.
   */
  async function runTile(projectId: number, tile: Tile, preset: RangePreset): Promise<TileOutcome> {
    const now = new Date()
    const range = resolvePreset(preset, now)
    switch (tile.kind) {
      case 'trend': {
        const trend = await stores.trends.get(projectId, tile.report_id)
        if (!trend) return { status: 404, body: { error: 'report_not_found' } }
        if (trend.stale) return { status: 400, body: { error: 'stale_definition' } }
        let breakdown: ReturnType<typeof parseBreakdown>
        try {
          breakdown = parseBreakdown(trend.group_by ?? undefined)
        } catch (err) {
          if (!(err instanceof BreakdownError)) throw err
          return { status: 400, body: { error: 'invalid_group_by', detail: err.message } }
        }
        // `StoredTrend.where` is `unknown[]` by contract even when the row
        // is not stale, so it is re-parsed here rather than asserted --
        // the same re-parse `trend-routes.ts` does on the way out.
        const predicates = z.array(WherePredicate).safeParse(trend.where)
        if (!predicates.success) return { status: 400, body: { error: 'invalid_where' } }
        try {
          const result = await runStats(
            { ch, database },
            { id: projectId },
            {
              since: range?.since,
              until: range?.until,
              interval: trend.interval,
              event: trend.event,
              breakdown,
              predicates: predicates.data,
            },
          )
          return { body: { kind: 'trend', result } }
        } catch (err) {
          if (err instanceof StatsQueryError) {
            return { status: 400, body: { error: err.code, detail: err.detail } }
          }
          throw err
        }
      }
      case 'retention': {
        const report = await stores.retention.get(projectId, tile.report_id)
        if (!report) return { status: 404, body: { error: 'report_not_found' } }
        if (report.stale) return { status: 400, body: { error: 'stale_definition' } }
        const input = RetentionBody.safeParse({
          start_event: report.start_event,
          return_event: report.return_event,
          start_where: report.start_where,
          return_where: report.return_where,
          granularity: report.granularity,
          periods: report.periods,
          segment_id: report.segment_id,
          // Omitted entirely for `auto`, rather than sent as `undefined`:
          // `runRetentionReport` defaults an absent range to the report's
          // own `periods` whole periods, which is the "auto" a saved
          // retention report means.
          ...(range ? { since: range.since.toISOString(), until: range.until.toISOString() } : {}),
        })
        if (!input.success) return { status: 400, body: { error: 'validation_failed' } }
        try {
          const result = await runRetentionReport(
            { ch, pg, database },
            { id: projectId },
            input.data,
          )
          return { body: { kind: 'retention', result } }
        } catch (err) {
          if (err instanceof RetentionValidationError) {
            return { status: 400, body: { error: err.code, detail: err.message } }
          }
          if (err instanceof SegmentTimeoutError) {
            return { status: 503, body: { error: 'query_timeout' } }
          }
          throw err
        }
      }
      case 'funnel': {
        let funnel: Awaited<ReturnType<FunnelStore['get']>>
        try {
          funnel = await stores.funnels.get(projectId, tile.report_id)
        } catch (err) {
          // `FunnelStore.get` throws rather than flagging, unlike the two
          // stores above -- a funnel with an unreadable definition is this
          // kind's own `stale_definition`, and `/v1/funnels/:id/run`
          // answers it with 400 and the same message.
          if (err instanceof StoredDefinitionError) {
            return { status: 400, body: { error: err.message } }
          }
          throw err
        }
        if (!funnel) return { status: 404, body: { error: 'report_not_found' } }
        const funnelRange = range ?? {
          since: new Date(now.getTime() - FUNNEL_DEFAULT_RANGE_MS),
          until: now,
        }
        try {
          // `result` is the raw grid `/v1/funnels/:id/run` reads to write
          // its cached counts through `recordRun`. A run through a shared
          // link must NOT record one -- a viewer refreshing a page would
          // otherwise keep rewriting the operator's "last evaluated"
          // snapshot with a window the operator never chose -- so it is
          // dropped here rather than passed anywhere.
          const { result: _raw, ...body } = await funnels.execute(
            { id: projectId },
            funnel,
            funnelRange,
          )
          return { body: { kind: 'funnel', result: body } }
        } catch (err) {
          if (err instanceof FunnelValidationError) {
            return { status: 400, body: { error: err.message, code: err.code } }
          }
          if (err instanceof SegmentTimeoutError) {
            return { status: 422, body: { error: err.message } }
          }
          throw err
        }
      }
    }
  }
}
