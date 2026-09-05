import { FunnelValidationError, RetentionValidationError } from '@lyraflow/core'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import type { Tile } from '../dashboards/store.js'
import { BreakdownError, parseBreakdown } from '../events/breakdown.js'
import { StatsQueryError, runStats } from '../events/stats.js'
import { FUNNEL_DEFAULT_RANGE_MS, type FunnelRunner } from '../funnels/run.js'
import { type FunnelStore, StoredDefinitionError } from '../funnels/store.js'
import { RetentionBody, runRetentionReport } from '../reports/retention-run.js'
import type { RetentionReportStore } from '../reports/retention-store.js'
import { StoredWhere, type TrendStore } from '../reports/trend-store.js'
import { SegmentTimeoutError } from '../segments/execute.js'
import { type RangePreset, resolvePreset } from './range.js'

/** The stores and clients one tile's run needs. Built once per
 *  registration by `registerSharedRoutes` and handed in, so this module
 *  constructs nothing and holds no state -- `runTile` is a function of its
 *  arguments, which is what makes the per-kind branches testable through
 *  the routes without a second wiring path. */
export interface RunTileDeps {
  pg: Pool
  ch: ClickHouseClient
  database: string
  trends: TrendStore
  retention: RetentionReportStore
  funnels: FunnelStore
  runner: FunnelRunner
}

/** What `runTile` answers with: a body to cache and send as 200, or a
 *  status the tile's own report endpoint would have sent, which is never
 *  cached -- a refusal that depends on a stored definition must be
 *  re-derived once that definition changes. */
export type TileOutcome = { body: unknown } | { status: number; body: unknown }

/**
 * Builds the request from the STORED report -- never from the caller -- and
 * runs it through the same lifted function the report's own route calls, so
 * a tile on a shared page and the same tile on the operator's dashboard
 * cannot answer differently.
 *
 * `projectId` is the one the TOKEN resolved to (`DashboardStore.byShareToken`
 * hands it back), and it is what every store read and every run below is
 * scoped by. Nothing the caller sends can influence it -- there is no
 * authentication on this surface to influence, and a server key presented
 * alongside is ignored. `routes.test.ts` pins both halves: the spies assert
 * the project passed to `runStats`/`runRetentionReport`, and a
 * cross-project test proves a link to project A's dashboard reads A's
 * events even when B's key rides along.
 *
 * ONE clock reading for the whole call: `resolvePreset` takes `now` for
 * that reason, and the funnel's own `auto` fallback below reuses the same
 * instant rather than reading the clock a second time.
 *
 * Both `stale_definition` refusals come BEFORE any parse of the stored
 * definition. A stale row's `where` is whatever a past or future build
 * wrote and this one cannot read, so running it would answer a question
 * nobody saved -- and answering with `invalid_where` instead would blame
 * the caller for a row they cannot see.
 */
export async function runTile(
  deps: RunTileDeps,
  projectId: number,
  tile: Tile,
  preset: RangePreset,
): Promise<TileOutcome> {
  const { pg, ch, database, trends, retention, funnels, runner } = deps
  const now = new Date()
  const range = resolvePreset(preset, now)
  switch (tile.kind) {
    case 'trend': {
      const trend = await trends.get(projectId, tile.report_id)
      if (!trend) return { status: 404, body: { error: 'report_not_found' } }
      if (trend.stale) return { status: 400, body: { error: 'stale_definition' } }
      let breakdown: ReturnType<typeof parseBreakdown>
      try {
        breakdown = parseBreakdown(trend.group_by ?? undefined)
      } catch (err) {
        if (!(err instanceof BreakdownError)) throw err
        return { status: 400, body: { error: 'invalid_group_by', detail: err.message } }
      }
      // `StoredTrend.where` is `unknown[]` by contract even when the row is
      // not stale, so it is re-parsed here rather than asserted -- through
      // `TrendStore`'s OWN `StoredWhere`, never a bare
      // `z.array(WherePredicate)` written here, which would be a third
      // notion of a valid predicate list and would drop the
      // `MAX_WHERE_PREDICATES` cap that `stale` itself is computed against.
      const predicates = StoredWhere.safeParse(trend.where)
      // UNREACHABLE BY CONSTRUCTION, and kept anyway. `TrendStore.#hydrate`
      // computes `stale` from this same schema and hands back the PARSED
      // predicates when it succeeds, so a row that gets past the `stale`
      // refusal above always re-parses here. It is kept as a 400 rather
      // than an `unreachable` throw because the two failure modes are not
      // symmetric: if the invariant ever breaks -- a store change, a fourth
      // caller hydrating differently -- a named 400 tells the operator
      // which report is unreadable, while a throw reaches app.ts's handler
      // as a 503 `unavailable` and blames the whole server for one row.
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
      const report = await retention.get(projectId, tile.report_id)
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
        // `runRetentionReport` defaults an absent range to the report's own
        // `periods` whole periods, which is the "auto" a saved retention
        // report means.
        ...(range ? { since: range.since.toISOString(), until: range.until.toISOString() } : {}),
      })
      // REACHABLE, and not merely defensive: `020_saved_reports.sql` bounds
      // `periods` only by `> 0` and `start_event`/`return_event` not at all,
      // while `RetentionBody` caps them at `MAX_PERIODS` and 128 characters.
      // A row written by a build with different bounds, or edited in the
      // database, lands here rather than at `stale` -- which is computed
      // from the `where` columns alone. Pinned by the "refuses a stored
      // definition the run schema will not accept" test.
      if (!input.success) return { status: 400, body: { error: 'validation_failed' } }
      try {
        const result = await runRetentionReport({ ch, pg, database }, { id: projectId }, input.data)
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
        funnel = await funnels.get(projectId, tile.report_id)
      } catch (err) {
        // `FunnelStore.get` throws rather than flagging, unlike the two
        // stores above -- a funnel with an unreadable definition is this
        // kind's own `stale_definition`, and `/v1/funnels/:id/run` answers
        // it with 400 and the same message.
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
        // `result` is the raw grid `/v1/funnels/:id/run` reads to write its
        // cached counts through `recordRun`. A run through a shared link
        // must NOT record one -- a viewer refreshing a page would otherwise
        // keep rewriting the operator's "last evaluated" snapshot with a
        // window the operator never chose -- so it is dropped here rather
        // than passed anywhere.
        const { result: _raw, ...body } = await runner.execute(
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
