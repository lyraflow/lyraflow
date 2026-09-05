import type { ClickHouseClient, Pool } from '@lyraflow/db'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import type { AttemptLimiter } from '../auth/rate-limit.js'
import { type ResolvedTile, resolveTiles } from '../dashboards/resolve.js'
import { DashboardStore, SHARE_TOKEN_PATTERN, type Tile } from '../dashboards/store.js'
import { makeFunnelRunner } from '../funnels/run.js'
import { FunnelStore } from '../funnels/store.js'
import { type Readiness, refuseIfDraining } from '../health.js'
import { RetentionReportStore } from '../reports/retention-store.js'
import { TrendStore } from '../reports/trend-store.js'
import { type InFlightCap, type ResultCache, SHARED_RUN_WINDOW_MS } from './limits.js'
import { RangePresetSchema } from './range.js'
import { type RunTileDeps, runTile } from './run-tile.js'

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

/**
 * The fields of a funnel's wire shape a token holder never sees.
 *
 * `funnelToWire` carries the operator's own cached run: how many people
 * entered and converted the last time THEY ran it, when that was, and over
 * what range. None of it is on the exposure list the Share card shows
 * before minting a link and the README publishes beside it, and that list
 * is the contract -- a viewer who was told "this link exposes the report's
 * definition" is entitled to have that be the whole of it.
 *
 * Stripped rather than documented, because there is nothing here for a
 * viewer to use: the shared surface runs every tile live, and a run through
 * a link deliberately records nothing (see `run-tile.ts`'s note on dropping
 * `result`, and the "never records a run" test). The counts would be a
 * second, older set of numbers beside the live ones, and `last_evaluated_at`
 * would additionally tell whoever holds the link when the operator last
 * looked at their own funnel. Whole-branch review M2; pinned by "never
 * exposes a funnel's cached counts".
 */
const OPERATOR_ONLY_FUNNEL_FIELDS = [
  'last_entered',
  'last_converted',
  'last_evaluated_at',
  'last_range',
] as const

/** `resolveTiles`'s output with `OPERATOR_ONLY_FUNNEL_FIELDS` dropped from
 *  every funnel report. Trend and retention reports are returned untouched:
 *  neither wire shape carries a cached run, so there is nothing to strip
 *  and a blanket key filter would be a second, weaker statement of which
 *  fields this surface publishes. */
function withoutOperatorRunCounts(tiles: ResolvedTile[]): ResolvedTile[] {
  return tiles.map((tile) => {
    if (tile.kind !== 'funnel' || tile.report === null) return tile
    const report = { ...tile.report }
    for (const field of OPERATOR_ONLY_FUNNEL_FIELDS) delete report[field]
    return { ...tile, report }
  })
}

/** Every "no" this surface says about the token is the same 404: unknown,
 *  malformed, revoked, deleted. The shape of a valid token is not something
 *  to teach a guesser, and neither is which of the four it was -- the one
 *  body is pinned by the "with one body" test in `routes.test.ts`. */
function shareNotFound(reply: FastifyReply) {
  return reply.code(404).send({ error: 'share_not_found' })
}

/**
 * The first unauthenticated read path in the product. NO `authenticate` in
 * its deps, on purpose: the token is the whole credential, it names one
 * dashboard, and it cannot be presented anywhere else -- the authenticators
 * look a 43-character string up as a server key or a session and find
 * nothing, which `routes.test.ts` pins from both sides ("ignores a valid
 * session cookie and a valid server key" and "a share token opens nothing
 * under the authenticated surface"). Registered without CORS, like every
 * non-ingest route.
 *
 * This file holds the two handlers and the three bounds they enforce; the
 * per-kind derivation lives in `run-tile.ts`, so "what does the shared
 * surface allow" and "what does one tile run" are two questions with two
 * answers rather than one function with both.
 */
export function registerSharedRoutes(app: FastifyInstance, deps: SharedDeps): void {
  const { pg, ch, database, readiness, limiter, inFlight, cache } = deps
  const store = new DashboardStore(pg)
  const stores = {
    trends: new TrendStore(pg),
    retention: new RetentionReportStore(pg),
    funnels: new FunnelStore(pg),
  }
  const runDeps: RunTileDeps = {
    pg,
    ch,
    database,
    ...stores,
    runner: makeFunnelRunner({ ch, pg, database }),
  }

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

  /** The per-token key both routes below count against, in its own
   *  `share:` namespace -- `AttemptLimiter` bounds each namespace's map
   *  independently, which is what a caller-influenced key needs (see that
   *  class's own docstring; sharing the login route's namespace would let
   *  share traffic evict blocked login entries). */
  const limitKeyFor = (token: string) => `share:${token}`

  /** The one 429 both routes send. The retry-after is the WHOLE window, not
   *  a computed remainder: the limiter keeps per-attempt timestamps but
   *  exposes no "when does the oldest expire", and a client that waits the
   *  full window is always right where one that waits a guess is sometimes
   *  wrong. */
  function tooManyRuns(reply: FastifyReply) {
    return reply
      .code(429)
      .header('retry-after', String(Math.ceil(SHARED_RUN_WINDOW_MS / 1000)))
      .send({ error: 'too_many_runs' })
  }

  /**
   * The layout and the definitions it names, and nothing else -- no
   * dashboard id, no `is_home`, no project. The token holder is not an
   * operator: they can see what this one dashboard asks, and cannot learn
   * that the dashboard has an id worth guessing or a project it belongs to.
   * `no-store` because the body is a credentialed read and every
   * intermediary on the path to a shared link is one nobody chose.
   *
   * It counts against the SAME per-token limiter as the run route, and that
   * is the point rather than an implementation detail: a page load costs
   * one attempt of the 120 and each tile it then runs costs one more, so
   * one link's ceiling is 120 requests a minute in total, not 120 runs on
   * top of unlimited resolves. Left uncounted, this route would be the
   * cheap way to hammer a link -- it resolves the token and reads every
   * report on the dashboard, which is not free.
   */
  app.get<{ Params: { token: string } }>('/v1/shared/:token', async (req, reply) => {
    const found = await lookup(req.params.token, reply)
    if (!found) return
    const limitKey = limitKeyFor(req.params.token)
    if (!limiter.check([limitKey])) return tooManyRuns(reply)
    limiter.record([limitKey])
    const { projectId, dashboard } = found
    const tiles = await resolveTiles(stores, projectId, dashboard.tiles)
    reply.header('cache-control', 'no-store')
    return reply.code(200).send({
      name: dashboard.name,
      updated_at: dashboard.updated_at,
      stale: dashboard.stale,
      tiles: withoutOperatorRunCounts(tiles),
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
   * then bounds runs over a window, and the in-flight cap bounds concurrent
   * ones. `limiter.record` comes AFTER `inFlight.acquire`, deliberately: a
   * request refused by the in-flight cap never ran, so charging it against
   * the window would make a burst of concurrent tiles eat a link's whole
   * minute for work nobody did.
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

      // `no-store` on every answer this route gives, for the GET's reason:
      // the body is a credentialed read, and a POST being uncacheable by
      // default is a property of the method rather than a decision anyone
      // made about this data. Set before the first `send` so a cache hit
      // carries it too.
      reply.header('cache-control', 'no-store')

      // Keyed by token, not by dashboard id: revoking a link must not let
      // the next link to the same dashboard inherit its warm entries, and a
      // revoked token never reaches here at all because `lookup` above
      // already failed for it.
      //
      // And keyed by WHICH TILE, not only by where it sits. The index alone
      // is not an identity: a `PATCH` that reorders or removes tiles makes
      // index N a different report while its entries are still warm, and the
      // next viewer would be served one tile's numbers under another tile's
      // title for the rest of the TTL -- a wrong answer, not a stale one.
      // Whole-branch review I1, pinned by "keys the cache by the tile".
      //
      // The key space per token stays bounded, which is the property the
      // preset-only range vocabulary exists to protect: a dashboard holds at
      // most 12 tiles, so at most 12 live combinations of index, kind and
      // report id, times 7 presets. Entries for a layout that has since
      // changed are strays that the 60-second TTL expires, under the cache's
      // own 4096-entry cap.
      const key = `${token}:${index}:${tile.kind}:${tile.report_id}:${preset}`
      const cached = cache.get(key)
      if (cached !== undefined) return reply.code(200).send(cached)

      const limitKey = limitKeyFor(token)
      if (!limiter.check([limitKey])) return tooManyRuns(reply)
      if (!inFlight.acquire(token)) {
        // One second, because this refusal is about what is running right
        // now rather than about a window: the runs ahead of this one are in
        // flight, not scheduled.
        return reply.code(429).header('retry-after', '1').send({ error: 'too_many_runs' })
      }
      limiter.record([limitKey])
      try {
        const out = await runTile(runDeps, projectId, tile, preset)
        if ('status' in out) return reply.code(out.status).send(out.body)
        cache.set(key, out.body)
        return reply.code(200).send(out.body)
      } finally {
        // In `finally`, not after the `send`: a run that THROWS -- a
        // ClickHouse outage reaching the error handler as a 503 -- still
        // held a slot, and releasing only on success would leak one per
        // failure until the cap wedged the link shut permanently. Pinned by
        // "a failed run releases its in-flight slot".
        inFlight.release(token)
      }
    },
  )
}
