import type {
  RangeBody,
  ResolvedTile,
  RetentionReport,
  StatsQuery,
  TileKind,
  TrendReport,
} from '../../api/types.js'
import { RANGE_DAY_OPTIONS, type RangeDays } from '../funnels/RangePicker.js'
import {
  MAX_COHORTS,
  type RetentionParams,
  cohortCount,
  tooManyCohorts,
} from '../retention/params.js'
import {
  AUTO,
  CUSTOM,
  type RangeChoice,
  presetById,
  resolveRange,
  writeRange,
} from '../shared/range.js'
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

/** `MAX_TILES` in `server/src/dashboards/store.ts`, restated for the same
 *  reason as the three ceilings above: the screen must say so before sending
 *  an add the server refuses with a field-level 400 an operator cannot act on. */
export const MAX_TILES = 12

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

/** The ceiling the report's own screen refuses to send past, computed for
 *  the stored definition under the dashboard's range. `null` means "send
 *  it". A tile asks exactly what that screen would ask, so it must decline
 *  exactly what that screen would decline. */
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

/**
 * The dashboard's range as the funnel screen's own control spells it, or
 * `null` when that screen cannot express it.
 *
 * `RANGE_DAY_OPTIONS` is the whole vocabulary there -- four day counts, and
 * deliberately not free text (see `RangePicker`). So `auto` (no bounds at
 * all), a custom pair of dates, and the two presets longer than 90 days have
 * no spelling, and the honest answer is to send none: the funnel opens on
 * its own default and says on screen which range it ran.
 */
function funnelDaysOf(range: RangeChoice): RangeDays | null {
  if (range.preset === AUTO || range.preset === CUSTOM) return null
  const days = Math.round((presetById(range.preset)?.spanMs ?? 0) / MS_PER_DAY)
  // The MEMBERSHIP test is `RANGE_DAY_OPTIONS`, not a `days <= 90` of its
  // own: the set the funnel screen offers is the set its `<select>` renders,
  // and a second spelling of it here is how a `?days=` the picker cannot
  // display would come to be linked to.
  return RANGE_DAY_OPTIONS.find((d) => d === days) ?? null
}

/**
 * The query string a tile appends to its report's own path, so that opening
 * the report from a dashboard opens it over the range the dashboard was
 * showing rather than over the report's default.
 *
 * Trends and Retention both hold their range in the URL and read it with
 * `readRange`, so both get exactly what `writeRange` produces -- the same
 * bytes those screens write when their own picker moves. A funnel does not:
 * see `funnelDaysOf`.
 *
 * Includes the leading `?`, and is `''` when there is nothing to say.
 */
export function reportQuery(kind: TileKind, range: RangeChoice): string {
  if (kind === 'funnel') {
    const days = funnelDaysOf(range)
    return days === null ? '' : `?days=${days}`
  }
  const query = writeRange(new URLSearchParams(), range).toString()
  return query === '' ? '' : `?${query}`
}
