import {
  Params,
  type WherePredicate,
  chDateTime,
  notSuppressedExpr,
  resolvedPersonExpr,
  wherePredicate,
} from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import { parseChDateTime } from '../ingest/row.js'
import { SEGMENT_MAX_EXECUTION_SECONDS, SEGMENT_MAX_MEMORY_BYTES } from '../segments/execute.js'
import {
  type Breakdown,
  MAX_BREAKDOWN_ROWS,
  breakdownColumns,
  breakdownExpr,
  breakdownOverflowed,
  foldSeries,
} from './breakdown.js'

/**
 * Bounded for the same class of reason as `EVENTS_MAX_LIMIT`, but on the
 * other side of the trade: `/v1/events/stats` sums groups server-side
 * rather than paging rows, so it has no `LIMIT` to hide an oversized window
 * behind. A 1-minute interval over a year is roughly half a million
 * buckets — checked with cheap arithmetic on the requested window BEFORE
 * any query runs, the same reasoning `validateTree` (segments/validate.ts)
 * uses for an over-cap filter tree: reject rather than run something that
 * was always going to be too expensive.
 */
export const STATS_MAX_BUCKETS = 1000

/**
 * The interval reaches SQL only through this compile-time record, never as
 * the request string. `StatsQuery`'s `z.enum(['1m', '1h', '1d'])` already
 * rejects anything else at the parse boundary; this record is the SECOND
 * line of defence, the one that makes the interval structurally
 * uninjectable rather than merely validated against — a lookup into a
 * closed, compile-time set of literals can never emit anything but one of
 * those three fixed strings, regardless of what reaches it.
 */
export const STATS_INTERVALS = {
  '1m': 'INTERVAL 1 MINUTE',
  '1h': 'INTERVAL 1 HOUR',
  '1d': 'INTERVAL 1 DAY',
  // Weekly, because `1d` cannot draw a quarter: 90 days is 90 buckets, but a
  // year is 365 against a cap of 1000 and is unreadable long before it is
  // refused.
  //
  // MONDAY, and measured rather than assumed: `toStartOfInterval(t, INTERVAL
  // 1 WEEK)` buckets 2026-06-03 (a Wednesday) to 2026-06-01 against
  // ClickHouse 24.8 -- the same Monday `toStartOfWeek(t, 1)` gives, and the
  // same anchoring the retention grid settled on. A weekly trend and a weekly
  // cohort row that disagreed about where a week starts would be two charts
  // nobody could read against each other.
  '1w': 'INTERVAL 1 WEEK',
} as const

/**
 * Milliseconds per bucket, keyed identically to `STATS_INTERVALS` — used
 * only for the pre-query `STATS_MAX_BUCKETS` arithmetic below, never for
 * SQL text. The SQL side always goes through the record above, never
 * through arithmetic on the request.
 */
const STATS_INTERVAL_MS: Record<keyof typeof STATS_INTERVALS, number> = {
  '1m': 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
}

/**
 * The default `since` window when the caller omits it, scaled to
 * `interval` — a fixed 24h default (this route's original behaviour)
 * collides with `STATS_MAX_BUCKETS` at fine resolutions: 24h at `1m`
 * resolution is 1440 buckets against a cap of 1000, so `?interval=1m` with
 * no other parameters — the obvious first thing to try, and exactly what
 * "is my instrumentation working right now" means — was an unconditional
 * 400.
 *
 * Each entry is 60/24/7 BUCKETS — roughly a screenful at every resolution,
 * not an independently-chosen span per interval. That also keeps every
 * bare request comfortably under `STATS_MAX_BUCKETS` regardless of which
 * interval is picked. `1h`'s entry is unchanged from the original fixed
 * default (24h, 24 buckets), so the documented default at the default
 * interval is exactly what it always was.
 *
 * `1d`'s entry was originally 30 days (30 buckets, the same screenful
 * reasoning) but measured too wide against a real query: `LIMIT 1 BY
 * project_id, event_id` in the inner select holds one hash entry per
 * DISTINCT `event_id` in the SCANNED window, at roughly 108 bytes/row —
 * the same figure the feed's own `since`-default comment above measures —
 * so `SEGMENT_MAX_MEMORY_BYTES` (4 GiB) is exhausted around 40M events
 * inside the window, independent of `interval` or `STATS_MAX_BUCKETS`
 * (neither bounds row count, only bucket count). At 30 days that ceiling
 * is ~1.3M events/day (~15/sec sustained) before a BARE `?interval=1d`
 * call — no other parameters — starts failing; at 7 days it's ~5.7M
 * events/day (~66/sec sustained), a substantially higher bar for the
 * default case to hit. Either way this fails LOUDLY as a `503`
 * (`timeout_overflow_mode: 'throw'`, below) rather than by truncating, so
 * it was never a correctness bug — but a narrower default pushes the wall
 * further out for the one call shape that can't be narrowed by the caller
 * at all.
 *
 * Applies ONLY when `since` is omitted; an explicit `since` (with or
 * without an explicit `until`) always goes through `STATS_MAX_BUCKETS`
 * unchanged, no matter how wide it is — that guard bounds bucket count,
 * not row count, so it does not and cannot protect against the ceiling
 * above either way. Exported so Task 7's CLI docs state the real
 * per-interval default rather than a single 24h figure that only ever
 * applied to one of the three intervals.
 */
export const STATS_DEFAULT_WINDOW_MS: Record<keyof typeof STATS_INTERVALS, number> = {
  '1m': 60 * 60_000,
  '1h': 24 * 60 * 60_000,
  '1d': 7 * 24 * 60 * 60_000,
  // 12 buckets, not the 60/24/7 the others use: a quarter is the span a
  // weekly trend is FOR, and seven weeks is a window somebody would have
  // picked `1d` for.
  '1w': 12 * 7 * 24 * 60 * 60_000,
}

/**
 * One aggregated row as ClickHouse returns it. `event_name` is present only
 * when `group_by=event_name` was requested — omitted from the SELECT list
 * otherwise, so it is simply absent from the row rather than null. `events`
 * is `count(DISTINCT event_id)`, a `UInt64` that JSONEachRow serializes as a
 * JSON string (the same shape `person_count` takes in
 * `segments/execute.ts`), converted with `Number(...)` below.
 */
interface StatsRow {
  bucket: string
  event_name?: string
  series?: string
  events: string
}

export type StatsInterval = keyof typeof STATS_INTERVALS

export interface StatsRunDeps {
  ch: ClickHouseClient
  database: string
}

export interface StatsRunInput {
  since?: Date
  until?: Date
  interval: StatsInterval
  event?: string
  breakdown?: Breakdown
  predicates: WherePredicate[]
}

/** The two refusals the run itself can make after the request has parsed.
 *  The route maps both to `400 { error: code, detail }`, byte for byte what
 *  it sent before this function existed. */
export class StatsQueryError extends Error {
  constructor(
    readonly code: 'window_too_large' | 'too_many_series',
    readonly detail: string,
  ) {
    super(detail)
    this.name = 'StatsQueryError'
  }
}

export type StatsBody =
  | { buckets: { bucket: string; events: number }[] }
  | {
      buckets: { bucket: string; event_name?: string; series: string; events: number }[]
      folded_series: number
    }

/** The window a request asks over once defaults apply -- ONE place, so the
 *  shared run path and the authenticated route cannot default differently. */
export function resolveStatsWindow(
  interval: StatsInterval,
  since: Date | undefined,
  until: Date | undefined,
  now: Date,
): { since: Date; until: Date } {
  const untilDate = until ?? now
  const sinceDate = since ?? new Date(now.getTime() - STATS_DEFAULT_WINDOW_MS[interval])
  return { since: sinceDate, until: untilDate }
}

/**
 * `GET /v1/events/stats` from the resolved window onward. Lifted out of the
 * route so a shared dashboard can run a STORED trend through exactly this
 * code; the route parses, this runs. Every comment that travelled here
 * with the body still applies.
 */
export async function runStats(
  deps: StatsRunDeps,
  project: { id: number },
  input: StatsRunInput,
): Promise<StatsBody> {
  const { ch, database } = deps
  const { interval, event, breakdown, predicates } = input
  const now = new Date()
  const { since: sinceDate, until: untilDate } = resolveStatsWindow(
    interval,
    input.since,
    input.until,
    now,
  )

  // Kept as its own flag: `group_by=event_name` must still put an
  // `event_name` field on every row, which is what the CLI's snippet
  // command reads. The generic `series` field is added alongside it rather
  // than replacing it.
  const groupBy = breakdown?.source === 'event_name'

  // Cheap arithmetic before any query — see this route's own docstring.
  // Computed from the EFFECTIVE window (defaults already resolved
  // above), since that is what actually determines how many buckets the
  // query would produce, not just whatever the caller happened to type.
  const windowMs = untilDate.getTime() - sinceDate.getTime()
  const bucketCount = Math.ceil(windowMs / STATS_INTERVAL_MS[interval])
  if (bucketCount > STATS_MAX_BUCKETS) {
    throw new StatsQueryError(
      'window_too_large',
      `this window at ${interval} resolution would produce ${bucketCount} buckets, above the limit of ${STATS_MAX_BUCKETS}`,
    )
  }

  // `project_id` is bound from the authenticated key, never from the
  // query string — same rule as the feed above.
  const params = new Params()
  const projectParam = params.add(project.id, 'UInt32')

  // `untilClause` is emitted unconditionally from the already-resolved
  // `untilDate` (explicit, or `now` by default) — NOT only when `until`
  // was explicitly passed. `untilDate` is what the bucket-count guard
  // above already assumed as the window's upper edge; making the SQL
  // upper bound conditional on `until` being explicit would let the two
  // disagree. `clampTimestamp` (@lyraflow/core, MAX_CLOCK_SKEW_MS = 24h)
  // admits ingested events up to 24h in the future, so an explicit
  // narrow `since` with no `until` could otherwise scan events the
  // guard never counted, past the ceiling it was meant to enforce.
  const sinceClause = ` AND timestamp >= ${params.add(chDateTime(sinceDate), 'DateTime64(3)')}`
  const untilClause = ` AND timestamp <= ${params.add(chDateTime(untilDate), 'DateTime64(3)')}`
  // INSIDE the inner select, beside the window clauses, not in the outer
  // `WHERE` -- the inner select is what `LIMIT 1 BY project_id, event_id`
  // dedups over, and its per-row memory is the ceiling this route's
  // default-window comment measures. Narrowing there makes the filter cut
  // the scan; narrowing outside would read every event in the window and
  // throw most of them away, which is the shape that exhausts memory.
  const eventClause = event === undefined ? '' : ` AND event_name = ${params.add(event, 'String')}`

  // INSIDE the inner select, beside `eventClause`, for that clause's own
  // reason: narrowing there makes the filter cut the scan, while narrowing
  // outside would read every event in the window and throw most of them
  // away.
  //
  // No column projection is needed, and that is the one real difference
  // from `retention/compile.ts`, which has to call `attributeColumns` and
  // re-project `properties`/`properties_num` because its predicates run
  // against an outer CTE. Here they run against `events` itself, where
  // every column `wherePredicate` can name is already in scope.
  //
  // Each compiled string is appended as-is. Retention's `clause()` drops a
  // `'1'`, but that is its own base condition for an `ANY_EVENT` side --
  // `wherePredicate` never returns it.
  const whereClause = predicates.map((w) => ` AND ${wherePredicate(w, params, now)}`).join('')

  // Built BEFORE the SQL below so its bound property key takes its place in
  // the same positional parameter sequence. Only the columns a breakdown
  // actually names are projected out of the inner scan -- the same rule
  // `attributeColumns` follows for segment predicates, and for the same
  // reason: `events` is columnar and the hot path, so reading two map
  // columns that nothing references would cost every trend in the product.
  const seriesExpr = breakdown ? breakdownExpr(breakdown, params) : null
  const extraColumns = breakdownColumns(breakdown)
  const extraSelect = extraColumns.length > 0 ? `, ${extraColumns.join(', ')}` : ''

  // The identical suppression derivation the feed uses above:
  // `notSuppressedExpr` against each event's own timestamp, inside the
  // same nested shape — one clause, never a second bespoke one.
  const resolved = resolvedPersonExpr({ database, alias: 'e' })
  const notSuppressed = notSuppressedExpr({
    database,
    projectId: project.id,
    params,
    person: resolved,
    instant: 'e.timestamp',
  })

  // `LIMIT 1 BY project_id, event_id` below is the real dedup — the same
  // guarantee the feed's own docstring establishes above, and pinned
  // independently here by routes.test.ts's bucket-straddling retry test
  // (a retry whose two physical rows land in DIFFERENT buckets, which no
  // per-bucket GROUP BY aggregate can collapse across groups). The outer
  // `count(DISTINCT event_id)` is defence in depth, not a second
  // mechanism doing real work: `LIMIT 1 BY` already guarantees at most
  // one row per `event_id` reaches this SELECT, so no ingest-producible
  // input can make `count(DISTINCT event_id)` differ from a plain
  // `count()` here. Kept as DISTINCT anyway — it costs nothing, and
  // stays correct if the inner subquery's dedup shape ever changes —
  // but no test can, or should try to, prove it necessary on its own.
  // `LIMIT MAX_BREAKDOWN_ROWS + 1` is a TRIPWIRE, not a page. Nothing
  // truncated is ever returned: the handler reads one row past the ceiling
  // and refuses the whole request, because a chart silently missing its
  // rarest series is one the caller cannot tell is incomplete. No ORDER BY
  // is needed to make that sound -- which rows come back does not matter
  // when the only thing done with an over-limit result is to reject it.
  const rowCap = seriesExpr === null ? '' : `\n      LIMIT ${MAX_BREAKDOWN_ROWS + 1}`
  const sql = `
      SELECT toStartOfInterval(timestamp, ${STATS_INTERVALS[interval]}) AS bucket,
             ${seriesExpr === null ? '' : `${seriesExpr} AS series,`}
             count(DISTINCT event_id) AS events
      FROM (
        SELECT project_id, event_id, timestamp, event_name, anonymous_id, user_id${extraSelect}
        FROM events
        WHERE project_id = ${projectParam}${sinceClause}${untilClause}${eventClause}${whereClause}
        LIMIT 1 BY project_id, event_id
      ) AS e
      WHERE ${notSuppressed}
      GROUP BY bucket${seriesExpr === null ? '' : ', series'}
      ORDER BY bucket ASC${seriesExpr === null ? '' : ', series ASC'}${rowCap}
    `

  const rs = await ch.query({
    query: sql,
    query_params: params.values,
    format: 'JSONEachRow',
    clickhouse_settings: {
      max_execution_time: SEGMENT_MAX_EXECUTION_SECONDS,
      max_memory_usage: String(SEGMENT_MAX_MEMORY_BYTES),
      // Without this, ClickHouse would rather return a partial set of
      // buckets than fail — a silently truncated aggregate reads as
      // "instrumentation is fine, nothing else happened", the same
      // reasoning the feed's identical setting documents above.
      timeout_overflow_mode: 'throw',
    },
  })
  const rows = await rs.json<StatsRow>()

  if (seriesExpr !== null && breakdownOverflowed(rows.length)) {
    throw new StatsQueryError(
      'too_many_series',
      `that breakdown produces more than ${MAX_BREAKDOWN_ROWS} bucket/series rows; pick a lower-cardinality field, a coarser interval, or a narrower window`,
    )
  }

  const points = rows.map((r) => ({
    bucket: parseChDateTime(r.bucket).toISOString(),
    series: r.series ?? '',
    events: Number(r.events),
  }))

  if (seriesExpr === null) {
    return {
      buckets: points.map((p) => ({ bucket: p.bucket, events: p.events })),
    }
  }

  // Folded HERE rather than in SQL, deliberately. Ranking series by their
  // total needs every series' total, so doing it in SQL means either a
  // second scan of `events` or a window function over an inlined CTE that
  // ClickHouse would scan twice anyway. The row cap above is what makes it
  // safe to bring them all back and rank them in memory.
  //
  // NEVER for `group_by=event_name`, and that is a contract rather than a
  // preference. That form predates trends and its callers -- the CLI's
  // snippet command among them -- read it as the LIST of event names this
  // project has recorded; folding the rarest into `(other)` would silently
  // shorten that list, which is exactly the "silent cap" this fold exists
  // in the other direction to avoid. It also needs no cap: event-name
  // cardinality is already bounded at ingest (`event_name_cardinality` is a
  // rejection reason), unlike a property key, which is bounded by nothing.
  //
  // Caught by an existing test rather than reasoned about: a rare probe
  // event vanished from a `group_by=event_name` response the moment the
  // fold was applied to it.
  const { points: folded, folded: foldedCount } = groupBy
    ? { points, folded: 0 }
    : foldSeries(points)

  return {
    buckets: folded.map((p) => ({
      bucket: p.bucket,
      // `event_name` is the pre-trends field and stays exactly where it
      // was for `group_by=event_name`; `series` is the general one.
      ...(groupBy ? { event_name: p.series } : {}),
      series: p.series,
      events: p.events,
    })),
    // Named so a caller can say "and 340 others" rather than implying there
    // were only ten. Zero when nothing was folded.
    folded_series: foldedCount,
  }
}
