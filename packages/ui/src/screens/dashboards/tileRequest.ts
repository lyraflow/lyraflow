import type {
  RangeBody,
  ResolvedTile,
  RetentionReport,
  StatsQuery,
  TrendReport,
} from '../../api/types.js'
import {
  MAX_COHORTS,
  type RetentionParams,
  cohortCount,
  tooManyCohorts,
} from '../retention/params.js'
import { AUTO, CUSTOM, type RangeChoice, presetById, resolveRange } from '../shared/range.js'
import { whereFromStored } from '../shared/where.js'
import {
  MAX_BUCKETS,
  type TrendParams,
  bucketCount,
  groupByOf,
  sourceAndFieldFromGroupBy,
  tooManyBuckets,
} from '../trends/params.js'

/** `MAX_RANGE_DAYS` in `core/funnels/validate.ts`, restated for the reason
 *  `MAX_BUCKETS` and `MAX_COHORTS` are in their `params.ts`: a tile must not
 *  send a run the server refuses. */
export const FUNNEL_MAX_RANGE_DAYS = 90

const MS_PER_DAY = 86_400_000

export type TileCeiling =
  | { kind: 'buckets'; count: number; max: number }
  | { kind: 'cohorts'; count: number; max: number }
  | { kind: 'funnel_days'; max: number }

/** The stored definition as the Trends screen would seed it -- the SAME
 *  mapping `Trends.tsx`'s seed step performs, so a tile asks exactly the
 *  question the report's own screen would. */
export function trendParamsOf(report: TrendReport, range: RangeChoice): TrendParams {
  return {
    event: report.event,
    interval: report.interval,
    ...sourceAndFieldFromGroupBy(report.group_by),
    where: whereFromStored(report.where),
    range,
  }
}

export function retentionParamsOf(report: RetentionReport, range: RangeChoice): RetentionParams {
  return {
    start: report.start_event,
    return: report.return_event,
    startWhere: whereFromStored(report.start_where),
    returnWhere: whereFromStored(report.return_where),
    granularity: report.granularity,
    periods: report.periods,
    segmentId: report.segment_id,
    range,
  }
}

/** `Trends.tsx`'s `run` body, lifted: resolved at run time, empties omitted. */
export function trendQueryOf(p: TrendParams, now: Date): StatsQuery {
  const groupBy = groupByOf(p)
  return {
    interval: p.interval,
    ...resolveRange(p.range, now),
    ...(p.event === '' ? {} : { event: p.event }),
    ...(groupBy === undefined ? {} : { group_by: groupBy }),
    ...(p.where.length === 0 ? {} : { where: JSON.stringify(p.where) }),
  }
}

/**
 * A relative preset becomes `{ days }` -- the funnel run endpoint derives
 * both ends from ONE reading of the server's clock, which is the fix for a
 * client-computed `since` overshooting the 90-day cap by the request's
 * flight time (see `RangeBody`'s docstring). `auto` sends `{}` and takes the
 * server's seven-day default. Custom sends the two dates.
 */
export function funnelRangeOf(range: RangeChoice, now: Date): RangeBody {
  if (range.preset === AUTO) return {}
  if (range.preset === CUSTOM) return resolveRange(range, now)
  const spanMs = presetById(range.preset)?.spanMs ?? 0
  return { days: Math.round(spanMs / MS_PER_DAY) }
}

function funnelSpanDays(range: RangeChoice, now: Date): number | null {
  if (range.preset === AUTO) return null
  if (range.preset === CUSTOM) {
    const { since, until } = resolveRange(range, now)
    if (since === undefined || until === undefined) return null
    return (new Date(until).getTime() - new Date(since).getTime()) / MS_PER_DAY
  }
  return Math.round((presetById(range.preset)?.spanMs ?? 0) / MS_PER_DAY)
}

/** Decision 5 of the spec, on load: the ceiling the report's own screen
 *  would refuse to send past, computed for the stored definition under the
 *  dashboard's range. `null` means "send it". */
export function ceilingFor(tile: ResolvedTile, range: RangeChoice, now: Date): TileCeiling | null {
  if (tile.report === null) return null
  switch (tile.kind) {
    case 'trend': {
      // The COMPARISON is `tooManyBuckets`, not a second `count > MAX_BUCKETS`
      // restated here: the whole point of this module is that a tile refuses
      // exactly what the report's own screen refuses, and two spellings of one
      // threshold is how the two would come to disagree about the boundary.
      // `bucketCount` is still called, for the number the message names.
      const p = trendParamsOf(tile.report, range)
      const count = bucketCount(p, now)
      return tooManyBuckets(p, now) && count !== null
        ? { kind: 'buckets', count, max: MAX_BUCKETS }
        : null
    }
    case 'retention': {
      const p = retentionParamsOf(tile.report, range)
      const count = cohortCount(p, now)
      return tooManyCohorts(p, now) && count !== null
        ? { kind: 'cohorts', count, max: MAX_COHORTS }
        : null
    }
    case 'funnel': {
      const days = funnelSpanDays(range, now)
      return days !== null && days > FUNNEL_MAX_RANGE_DAYS
        ? { kind: 'funnel_days', max: FUNNEL_MAX_RANGE_DAYS }
        : null
    }
  }
}
