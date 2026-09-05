import {
  GRANULARITIES,
  type Granularity,
  MAX_PERIODS,
  MAX_WHERE_PREDICATES,
  Params,
  type SegmentQuery,
  WherePredicate,
  compileRetention,
  compileSegment,
} from '@lyraflow/core'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import { z } from 'zod'
import { SegmentStore, StoredTreeError } from '../segments/store.js'
import { runRetention } from './execute.js'

export interface RetentionRunDeps {
  ch: ClickHouseClient
  pg: Pool
  database: string
}

/** Milliseconds in one period, for defaulting the range only. */
const PERIOD_MS: Record<Granularity, number> = {
  day: 86_400_000,
  week: 7 * 86_400_000,
  month: 30 * 86_400_000,
}

const DEFAULT_PERIODS = 8

export const RetentionBody = z.object({
  start_event: z.string().min(1).max(128),
  return_event: z.string().min(1).max(128),
  // The segment/funnel `where` grammar verbatim. Validated by the same schema
  // the other two use, so an over-long list or a bad operator is a field-level
  // error here for the same reason it is there.
  start_where: z.array(WherePredicate).max(MAX_WHERE_PREDICATES).optional(),
  return_where: z.array(WherePredicate).max(MAX_WHERE_PREDICATES).optional(),
  granularity: z.enum(GRANULARITIES).default('week'),
  periods: z.number().int().positive().max(MAX_PERIODS).default(DEFAULT_PERIODS),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  segment_id: z.number().int().positive().nullable().optional(),
})
export type RetentionRunInput = z.infer<typeof RetentionBody>

/**
 * `POST /v1/reports/retention` after parsing — a retention grid, computed
 * and returned. Lifted out of the route so a shared dashboard can run a
 * STORED retention report through exactly this code; the route parses,
 * this runs. Throws `RetentionValidationError` and `SegmentTimeoutError`
 * for the route (or a future stored-report runner) to map to a status
 * code — this function itself makes no HTTP response.
 */
export async function runRetentionReport(
  deps: RetentionRunDeps,
  project: { id: number },
  q: RetentionRunInput,
) {
  const { ch, pg, database } = deps
  const segments = new SegmentStore(pg)

  const now = new Date()
  // Defaulted to the `periods` most recent whole periods, so a caller who
  // sends only two event names gets the grid they meant rather than an
  // empty one. Explicit bounds always win.
  const until = q.until ? new Date(q.until) : now
  const since = q.since
    ? new Date(q.since)
    : new Date(until.getTime() - q.periods * PERIOD_MS[q.granularity])

  const params = new Params()
  const warnings: { path: string; reason: string }[] = []
  let segmentPersonSql: string | undefined

  if (q.segment_id != null) {
    let segment = null
    try {
      segment = await segments.get(project.id, q.segment_id)
    } catch (err) {
      // A segment whose stored tree no longer parses cannot restrict
      // anything. Same treatment as a deleted one, and the same treatment
      // a funnel run gives it: run wide, and say so.
      if (!(err instanceof StoredTreeError)) throw err
    }
    if (segment) {
      segmentPersonSql = compileSegment({
        query: { ast_version: segment.astVersion, filter: segment.filter } as SegmentQuery,
        projectId: project.id,
        database,
        now,
        select: 'persons',
        params,
      }).sql
    } else {
      warnings.push({
        path: 'segment_id',
        reason: `segment ${q.segment_id} no longer exists or cannot be read, so this grid was measured over everyone rather than the population it names`,
      })
    }
  }

  const query = {
    start_event: q.start_event,
    return_event: q.return_event,
    ...(q.start_where === undefined ? {} : { start_where: q.start_where }),
    ...(q.return_where === undefined ? {} : { return_where: q.return_where }),
    granularity: q.granularity,
    periods: q.periods,
    since: since.toISOString(),
    until: until.toISOString(),
  }

  const compiled = compileRetention({
    query,
    projectId: project.id,
    database,
    now,
    segmentPersonSql,
    params,
  })
  const result = await runRetention({ client: ch, compiled, query, now })
  return {
    ...result,
    start_event: q.start_event,
    return_event: q.return_event,
    start_where: q.start_where ?? [],
    return_where: q.return_where ?? [],
    since: query.since,
    until: query.until,
    // The instant measurability was decided against, echoed so a reader
    // can tell a `null` cell from a stale one: the same request run a
    // week later fills cells in, and nothing else in the response says
    // when "not yet" was evaluated.
    computed_at: now.toISOString(),
    warnings,
  }
}
