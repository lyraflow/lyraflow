import { Params, chDateTime, notSuppressedExpr, resolvedPersonExpr } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Authenticate } from '../auth/bridge.js'
import type { PersonAliases } from '../identity/aliases.js'
import type { IdentityBindings } from '../identity/bindings.js'
import {
  MAX_PERSON_RANGE_CLAUSES,
  personEventsPredicate,
  resolvePersonScope,
} from '../identity/scope.js'
import { parseChDateTime } from '../ingest/row.js'
import { countParam } from '../numeric-id.js'
import { SEGMENT_MAX_EXECUTION_SECONDS, SEGMENT_MAX_MEMORY_BYTES } from '../segments/execute.js'
import { FeedCursorError, decodeFeedCursor, encodeFeedCursor } from './cursor.js'

/**
 * Bounded because this route is reachable by an authenticated caller on
 * repeat, and an unbounded `limit` is how a single request turns into an
 * unbounded ClickHouse scan. `Query` below rejects (400) anything above
 * this rather than silently clamping it — the same choice `/v1/schema/*`
 * makes (see schema/routes.test.ts): a caller that asked for too much is
 * told so, rather than getting a page that is quietly smaller than what it
 * asked for and having no way to tell that apart from "there were only this
 * many events".
 */
export const EVENTS_MAX_LIMIT = 500

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
}

/**
 * Bounded for the same reason `EVENTS_MAX_LIMIT` is: this route is reachable
 * by an authenticated caller on repeat, and an unbounded `limit` is how a
 * single request turns into an unbounded ClickHouse scan.
 */
export const REJECTIONS_MAX_LIMIT = 500

/**
 * Bounds the scan. `events_dead_letter` has a 30-day TTL, so this cap plus
 * that TTL are what keep a deep page from becoming an unbounded read -- the
 * same class of ceiling EVENTS_MAX_LIMIT exists for on the feed.
 */
export const REJECTIONS_MAX_OFFSET = 100_000

/**
 * MINOR B from the feat/admin-sessions whole-branch review: a full page
 * alone is not enough to promise there is a reachable next page.
 * offset=100_000 with a full page computes next_offset=100_002, which
 * REJECTIONS_MAX_OFFSET's own Zod ceiling (`RejectionsQuery` below) then
 * refuses with 400 -- a UI paging on `has_more` walks into that dead end.
 * Pulled out as its own pure function so the boundary can be pinned
 * directly, without needing a 100,000+ row ClickHouse fixture to reach it
 * through the route.
 */
export function rejectionsHasMore(
  rowsReturned: number,
  limit: number,
  nextOffset: number,
  maxOffset: number = REJECTIONS_MAX_OFFSET,
): boolean {
  return rowsReturned === limit && nextOffset <= maxOffset
}

const RejectionsQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  reason: z.string().min(1).max(64).optional(),
  limit: countParam({ min: 1, max: REJECTIONS_MAX_LIMIT, fallback: 50 }),
  offset: countParam({ min: 0, max: REJECTIONS_MAX_OFFSET, fallback: 0 }),
})

/** The exact column list this route selects and returns — a compile-time allowlist. */
interface RejectionRow {
  received_at: string
  reason: string
  detail: string
  payload: string
}

export interface EventsDeps {
  authenticate: Authenticate
  ch: ClickHouseClient
  bindings: IdentityBindings
  aliases: PersonAliases
  database: string
}

const Query = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  event: z.string().max(128).optional(),
  person: z.string().max(128).optional(),
  limit: countParam({ min: 1, max: EVENTS_MAX_LIMIT, fallback: 50 }),
  after: z.string().max(512).optional(),
})

const StatsQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  interval: z.enum(['1m', '1h', '1d']).default('1h'),
  group_by: z.literal('event_name').optional(),
})

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
  events: string
}

/** The exact column list this route selects and returns — a compile-time allowlist. */
interface FeedRow {
  event_id: string
  timestamp: string
  event_name: string
  anonymous_id: string
  user_id: string
  properties: Record<string, string>
  properties_num: Record<string, number>
  url: string
  path: string
  referrer: string
  utm_source: string
  utm_medium: string
  utm_campaign: string
  utm_term: string
  utm_content: string
  device_type: string
  os: string
  browser: string
  country: string
  region: string
  city: string
}

/**
 * GET /v1/events — the feed. "Is my instrumentation working" is the first
 * question anyone has after instrumenting a site, and until this route
 * existed the API had no way to answer it: every other read needs an id or a
 * filter tree the caller already wrote.
 *
 * THE FIFTH READ PATH. Segment counts, segment members, the person read, and
 * the export all enforce the same deletion boundary — a suppressed person's
 * data must never re-surface through any of them. This route adds a fifth,
 * and the risk a plan found twice already is that a guardrail holding on one
 * route and not its neighbour is exactly what a per-task review cannot see.
 * So suppression here is NOT a bespoke clause: it is `notSuppressedExpr`
 * (`@lyraflow/core`), the one dictionary-side derivation every ClickHouse
 * read path shares, compared against each row's own `timestamp` — the
 * PER-EVENT shape `behaviourCte` (segments/behaviour.ts) uses, not the
 * person-level `last_seen` comparison the base population uses. `resolved`
 * mirrors `behaviourCte`'s own nesting exactly: the inner subquery is
 * aliased `e`, and `resolvedPersonExpr({ database, alias: 'e' })` reads off
 * that alias's own columns, which only exist once the subquery is in scope —
 * it cannot be hoisted into the inner WHERE.
 *
 * This deliberately does NOT go through `PersonAliases`/`SuppressionStore`
 * (Postgres, zero replication lag) the way GET /v1/persons/:id and the
 * export do. Those routes need zero lag because they answer "does this
 * specific person's profile exist right now". This route answers a
 * different question — "what happened, project-wide, recently" — over a
 * result set the ClickHouse dictionaries' few-second LIFETIME is the right
 * cost for, and reusing the one expression the rest of the segment-query
 * path already depends on is exactly the convergence the boundary this task
 * exists to close.
 *
 * The `person` filter is a different concern from suppression and goes
 * through the OTHER converged path instead — `resolvePersonScope` +
 * `personEventsPredicate` (identity/scope.ts), the same zero-lag resolution
 * GET /v1/persons/:id performs, so a device id or a merged-away id finds the
 * right person here exactly as it would there.
 *
 * `LIMIT 1 BY project_id, event_id` in the inner subquery is not optional,
 * and not merely a race against merge timing: `events` is a
 * `ReplacingMergeTree` ordered by
 * `(project_id, timestamp, anonymous_id, event_id)`, and a retried delivery
 * that omitted `timestamp` is assigned a FRESH server timestamp on
 * redelivery — a genuinely different ORDER BY key, not just a different
 * `received_at` (the engine's *version* column, which decides which
 * duplicate wins on merge, but is not part of the sort key itself).
 * ReplacingMergeTree only ever collapses rows that share the identical sort
 * key; two rows differing in `timestamp` are never touched by any merge, at
 * any time, so `LIMIT 1 BY` is the only thing that ever deduplicates this
 * case — permanently, not until a background merge gets around to it. (A
 * retry that reused the exact same `timestamp` — identical sort key, only
 * `received_at` differing — is the one shape a merge *does* eventually
 * collapse on its own; `LIMIT 1 BY` still has to cover the window before
 * that merge runs. `routes.test.ts`'s dedup fixture exercises that
 * narrower, temporary case, since it is also the one a naively-built test
 * can pass for the wrong reason if merges are not paused — see that test's
 * own comment.)
 *
 * KNOWN LIMITATION, not fixed here: `afterClause`'s keyset predicate is
 * applied *inside* the same inner subquery as the dedup, and that subquery
 * has no `ORDER BY` of its own — so when the two physical rows of an
 * omitted-timestamp retry straddle a page boundary (one at `timestamp` t1,
 * the other at a later t2, with a cursor landing between them), WHICH
 * physical row `LIMIT 1 BY` keeps on each page is arbitrary rather than
 * consistently "the newest": in principle the same logical event could
 * appear on page 1 via its t1 row and again on page 2 via its t2 row.
 * Fixing this properly means filtering outside the dedup, which needs the
 * suppression check restructured too and is a larger change than this task
 * covers. Documented rather than fixed because triggering it needs a retry
 * that omitted `timestamp` specifically — normal delivery, and everything
 * `packages/sdk-browser` ever sends, always carries one.
 *
 * TWO PAGING DIRECTIONS, ONE OUTPUT ORDERING. With no cursor, the only way
 * to get the *most recent* N events is to sort `DESC` and take the top N —
 * then this handler reverses that page in JS before responding, because the
 * response is meant to read like a log (oldest of the page first, newest
 * last), and `--follow`'s next call should be able to pick up from the very
 * last event this call showed. Seeing `DESC` in the SQL and an ascending
 * response is not a bug: the reversal IS what makes that true. With a
 * cursor, the direction flips to `ASC` and a keyset predicate —
 * `(timestamp, event_id) > (at, aid)` — takes over; ClickHouse compares
 * tuples lexicographically, which is exactly keyset semantics: it moves past
 * `at` only when `event_id` is also past `aid` AT that same instant, so two
 * events sharing a timestamp are never skipped the way a bare
 * `timestamp > at` would skip them.
 *
 * `next_cursor` is always built from the LAST row of the page in the
 * returned (ascending) order — the newest event this call actually showed —
 * so a follow poll's next call continues from there. `null` on an empty
 * page: there is nothing to continue from.
 *
 * Ceilings mirror `segments/execute.ts`'s: this route is reachable by an
 * authenticated caller on repeat, and `timeout_overflow_mode: 'throw'`
 * matters here for the same reason it matters there — a silently truncated
 * feed reads as "instrumentation is fine, nothing else happened", which is
 * worse than a loud error.
 *
 * Server-key only: this reads person data across the whole project, exactly
 * like GET /v1/persons/:id, and the public, browser-shipped write key must
 * not reach it.
 */
export function registerEventsRoutes(app: FastifyInstance, deps: EventsDeps): void {
  const { authenticate, ch, bindings, aliases, database } = deps

  app.get('/v1/events', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const q = Query.safeParse(req.query)
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' })
    const { since, until, event, person, limit } = q.data

    let cursor: { timestamp: string; eventId: string } | null = null
    if (q.data.after !== undefined) {
      try {
        cursor = decodeFeedCursor(q.data.after)
      } catch (err) {
        if (err instanceof FeedCursorError) {
          return reply.code(400).send({ error: 'invalid_cursor' })
        }
        throw err
      }
    }

    // `project_id` is bound from the authenticated key, never from the
    // query string — nothing below reads `req.query.project_id`, and there
    // is no such field on `Query` for a caller to even attempt.
    const params = new Params()
    const projectParam = params.add(project.id, 'UInt32')

    // `since` defaults to 24h before now when the caller omits it AND
    // there is no cursor. `behaviourCte` (segments/behaviour.ts), whose
    // two-layer shape this route copies, always carries a `scanBound`;
    // every behavioural node's window is finite unless it says `ever`
    // explicitly. The NO-CURSOR call had no equivalent, and `LIMIT 1 BY`
    // in the inner subquery blocks any early stop the outer
    // `ORDER BY ... LIMIT n` might otherwise offer — ClickHouse cannot
    // know the `LIMIT 1 BY` output already comes out sorted, since the
    // inner subquery carries no `ORDER BY` of its own (see the
    // `afterClause` comment above for why it can't). Measured directly
    // against a 500,000-row fixture: this exact no-cursor query, with
    // `limit=50` and no `since` at all, read all 500,000 rows and 52 MiB —
    // linear in project size, not in `limit`, extrapolating to a hard
    // `503` around 40M events. It fails loudly (`timeout_overflow_mode:
    // 'throw'`, below) rather than truncating, so it was never a
    // correctness bug, but it was an unbounded-by-default operational
    // ceiling nobody had noticed.
    //
    // A CURSOR MUST NOT GET THIS DEFAULT. `(timestamp, event_id) >
    // (at, aid)` in `afterClause` below is ITSELF a lower bound on the
    // scan — a cursor-paged call was never the unbounded case the default
    // exists to close, only the no-cursor call was. Applying the default
    // on top of an older cursor position creates TWO lower bounds where
    // the tighter (more recent) one silently wins: a follower whose
    // cursor has fallen more than 24h behind would have every event
    // between the cursor and the window edge silently dropped from that
    // page — and since `next_cursor` only ever advances, that gap becomes
    // permanently unreachable, with no error and no gap marker. Proven
    // directly: an event at -30h (the stale cursor position), a gap event
    // at -27h, and one at -1h — paging from the -30h cursor with no
    // `since` returned ONLY the -1h event, silently losing the -27h one.
    // An explicit `since` alongside a cursor still applies below (a
    // caller deliberately narrowing is not the default firing); only the
    // DEFAULT must stay off whenever a cursor is doing the job instead.
    const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000
    let sinceClause = ''
    if (since) {
      sinceClause = ` AND timestamp >= ${params.add(chDateTime(new Date(since)), 'DateTime64(3)')}`
    } else if (!cursor) {
      const defaultSince = new Date(Date.now() - DEFAULT_SINCE_MS)
      sinceClause = ` AND timestamp >= ${params.add(chDateTime(defaultSince), 'DateTime64(3)')}`
    }

    let untilClause = ''
    if (until) {
      untilClause = ` AND timestamp <= ${params.add(chDateTime(new Date(until)), 'DateTime64(3)')}`
    }
    let eventClause = ''
    if (event) {
      eventClause = ` AND event_name = ${params.add(event, 'String')}`
    }

    // The identity half only — resolved through Postgres directly (zero
    // replication lag), the same derivation GET /v1/persons/:id uses, so a
    // device id or an id later merged away still finds the right person.
    // Named params from `personEventsPredicate` (`group`, `d0`, `f0`, `t0`,
    // …) never collide with `Params`' own `p0`, `p1`, … — the latter always
    // matches `/^p\d+$/` and the former never does.
    let personClause = ''
    let personParams: Record<string, unknown> = {}
    if (person) {
      const scope = await resolvePersonScope({ bindings, aliases }, project.id, person)
      if (scope.windows.length > MAX_PERSON_RANGE_CLAUSES) {
        return reply.code(400).send({
          error: 'person_history_too_fragmented',
          detail: `this person spans ${scope.windows.length} device windows, above the limit of ${MAX_PERSON_RANGE_CLAUSES}`,
        })
      }
      personParams = {}
      const predicate = personEventsPredicate(scope, personParams)
      personClause = ` AND ${predicate}`
    }

    // `event_id` is `UUID` in ClickHouse's schema (002_events.sql), which is
    // not one of `Params`' own `ChType`s (String/UInt32/Float64/
    // DateTime64(3)/UInt8 — a fixed set shared with the segment compiler).
    // Bound directly, under a name that cannot collide with `Params`' own
    // `p0`, `p1`, … generated names, rather than widening `ChType` for one
    // caller.
    let afterClause = ''
    let cursorParams: Record<string, unknown> = {}
    if (cursor) {
      const at = params.add(cursor.timestamp, 'DateTime64(3)')
      cursorParams = { cursorEventId: cursor.eventId }
      afterClause = ` AND (timestamp, event_id) > (${at}, {cursorEventId:UUID})`
    }

    // No cursor: DESC is the only way to get the most recent N, and the
    // handler reverses the page below. A cursor means a keyset continuation,
    // which only makes sense walking forward.
    const direction = cursor ? 'ASC' : 'DESC'

    const resolved = resolvedPersonExpr({ database, alias: 'e' })
    const notSuppressed = notSuppressedExpr({
      database,
      projectId: project.id,
      params,
      person: resolved,
      instant: 'e.timestamp',
    })

    const limitParam = params.add(limit, 'UInt32')

    const sql = `
      SELECT event_id, timestamp, event_name, anonymous_id, user_id,
             properties, properties_num, url, path, referrer,
             utm_source, utm_medium, utm_campaign, utm_term, utm_content,
             device_type, os, browser, country, region, city
      FROM (
        SELECT project_id, event_id, timestamp, event_name, anonymous_id, user_id,
               properties, properties_num, url, path, referrer,
               utm_source, utm_medium, utm_campaign, utm_term, utm_content,
               device_type, os, browser, country, region, city
        FROM events
        WHERE project_id = ${projectParam}${sinceClause}${untilClause}${eventClause}${personClause}${afterClause}
        LIMIT 1 BY project_id, event_id
      ) AS e
      WHERE ${notSuppressed}
      ORDER BY timestamp ${direction}, event_id ${direction}
      LIMIT ${limitParam}
    `

    const rs = await ch.query({
      query: sql,
      query_params: { ...params.values, ...personParams, ...cursorParams },
      format: 'JSONEachRow',
      clickhouse_settings: {
        max_execution_time: SEGMENT_MAX_EXECUTION_SECONDS,
        max_memory_usage: String(SEGMENT_MAX_MEMORY_BYTES),
        // Without this, ClickHouse would rather return a partial page than
        // fail — a silently truncated feed is worse than an error.
        timeout_overflow_mode: 'throw',
      },
    })
    const fetched = await rs.json<FeedRow>()

    // See this function's own docstring: DESC fetched the most recent N in
    // newest-first order; reversing here is what turns that into a log read
    // oldest-of-the-page-first. The cursor path fetched ASC already and
    // needs no reversal.
    const rows = cursor ? fetched : fetched.reverse()

    const last = rows[rows.length - 1]
    const next_cursor = last
      ? encodeFeedCursor({ timestamp: last.timestamp, eventId: last.event_id })
      : null

    return reply.code(200).send({
      events: rows.map((r) => ({
        event_id: r.event_id,
        timestamp: parseChDateTime(r.timestamp).toISOString(),
        event_name: r.event_name,
        anonymous_id: r.anonymous_id,
        user_id: r.user_id,
        properties: r.properties,
        properties_num: r.properties_num,
        url: r.url,
        path: r.path,
        referrer: r.referrer,
        utm_source: r.utm_source,
        utm_medium: r.utm_medium,
        utm_campaign: r.utm_campaign,
        utm_term: r.utm_term,
        utm_content: r.utm_content,
        device_type: r.device_type,
        os: r.os,
        browser: r.browser,
        country: r.country,
        region: r.region,
        city: r.city,
      })),
      next_cursor,
    })
  })

  /**
   * GET /v1/events/stats — time-bucketed counts, the other half of "is my
   * instrumentation working": the feed above answers "what happened", this
   * answers "how much, over time". Built directly on the feed's own nested
   * shape — an aggregation over the identical deduplicated,
   * suppression-checked inner select — because a guardrail that holds on
   * the feed and not on this sibling read path is exactly the "fifth read
   * path" failure this module's own docstring warns about, just one route
   * later.
   *
   * FLAT ROWS, NOT A NESTED OBJECT PER BUCKET. `{ buckets: [{ bucket,
   * event_name?, events }] }` is what stays pipeable into `jq`/`sort`
   * without restructuring first — a caller scripting against this should
   * not need to flatten a `{ bucket: { event_name: count } }` map before it
   * can sort or filter.
   *
   * BUCKET-COUNT GUARD, NOT A QUERY-TIME LIMIT. This route sums groups
   * server-side rather than paging rows, so — unlike the feed — it has no
   * `LIMIT` to hide an oversized window behind: a 1-minute interval over a
   * year is roughly half a million buckets. `STATS_MAX_BUCKETS` is enforced
   * with cheap arithmetic on the EFFECTIVE window (defaults already
   * resolved) before any query runs, the same reasoning `validateTree`
   * (segments/validate.ts) uses for an over-cap filter tree.
   *
   * `since` defaults to a window scaled to `interval` when omitted
   * (`STATS_DEFAULT_WINDOW_MS`) — for the identical underlying reason the
   * feed's fixed 24h default exists (an unbounded scan is unbounded
   * whether or not the route happens to aggregate the result afterwards),
   * but a single fixed 24h figure collides with `STATS_MAX_BUCKETS` at
   * fine resolutions; see that constant's own docstring. Unlike the feed,
   * this route has no cursor to conflict with the default, so it always
   * applies when `since` is missing.
   *
   * Server-key only, the same authenticator as the feed: this aggregates
   * project-wide event data, not a per-caller public surface.
   *
   * BUCKET ATTRIBUTION INHERITS THE FEED'S ARBITRARY-ROW LIMITATION. The
   * feed's own KNOWN LIMITATION above documents that `LIMIT 1 BY` has no
   * tie-break, so for an omitted-timestamp retry which physical row
   * survives is arbitrary. Here that surfaces as bucket attribution: the
   * one logical event lands in whichever of its retried physical rows'
   * buckets `LIMIT 1 BY` happens to keep, not deterministically the
   * earliest or the latest.
   */
  app.get('/v1/events/stats', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const q = StatsQuery.safeParse(req.query)
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' })
    const { since, until, interval, group_by } = q.data
    const groupBy = group_by === 'event_name'

    const sinceDate = since
      ? new Date(since)
      : new Date(Date.now() - STATS_DEFAULT_WINDOW_MS[interval])
    const untilDate = until ? new Date(until) : new Date()

    // Cheap arithmetic before any query — see this route's own docstring.
    // Computed from the EFFECTIVE window (defaults already resolved
    // above), since that is what actually determines how many buckets the
    // query would produce, not just whatever the caller happened to type.
    const windowMs = untilDate.getTime() - sinceDate.getTime()
    const bucketCount = Math.ceil(windowMs / STATS_INTERVAL_MS[interval])
    if (bucketCount > STATS_MAX_BUCKETS) {
      return reply.code(400).send({
        error: 'window_too_large',
        detail: `this window at ${interval} resolution would produce ${bucketCount} buckets, above the limit of ${STATS_MAX_BUCKETS}`,
      })
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
    const sql = `
      SELECT toStartOfInterval(timestamp, ${STATS_INTERVALS[interval]}) AS bucket,
             ${groupBy ? 'event_name,' : ''}
             count(DISTINCT event_id) AS events
      FROM (
        SELECT project_id, event_id, timestamp, event_name, anonymous_id, user_id
        FROM events
        WHERE project_id = ${projectParam}${sinceClause}${untilClause}
        LIMIT 1 BY project_id, event_id
      ) AS e
      WHERE ${notSuppressed}
      GROUP BY bucket${groupBy ? ', event_name' : ''}
      ORDER BY bucket ASC${groupBy ? ', event_name ASC' : ''}
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

    return reply.code(200).send({
      buckets: rows.map((r) => ({
        bucket: parseChDateTime(r.bucket).toISOString(),
        ...(groupBy ? { event_name: r.event_name } : {}),
        events: Number(r.events),
      })),
    })
  })

  /**
   * GET /v1/events/rejections — rejected events, read from the dead-letter
   * table that has stored them since 002_events.sql. Nothing served this
   * before, which is why an operator's only signal that ingest was refusing
   * traffic was a counter.
   *
   * OFFSET-PAGED, NOT KEYSET-PAGED, unlike GET /v1/events — and the reason is
   * in the table rather than in taste. `events_dead_letter` has no unique row
   * identity: its columns are project_id, received_at, reason, detail and
   * payload, and nothing else. A keyset needs a tiebreaker, and the only
   * candidate is a hash of the row's own content — which makes two
   * byte-identical rejections in the same millisecond skip each other. A
   * client looping on one malformed payload produces exactly that, and it is
   * the single most valuable thing this endpoint ever shows, so losing it
   * silently is the worst failure available here.
   *
   * Offset paging's own weakness — rows arriving at the head shifting the
   * window — is closed by the caller pinning `until` from the first page and
   * paging inside that fixed window. The CLI and the UI both do that.
   */
  app.get('/v1/events/rejections', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const q = RejectionsQuery.safeParse(req.query)
    if (!q.success) return reply.code(400).send({ error: 'invalid_query' })
    const { since, until, reason, limit, offset } = q.data

    const params = new Params()
    const projectParam = params.add(project.id, 'UInt32')
    let clauses = ''
    if (since)
      clauses += ` AND received_at >= ${params.add(chDateTime(new Date(since)), 'DateTime64(3)')}`
    if (until)
      clauses += ` AND received_at <= ${params.add(chDateTime(new Date(until)), 'DateTime64(3)')}`
    if (reason) clauses += ` AND reason = ${params.add(reason, 'String')}`

    // limit and offset are interpolated as validated integers rather than
    // bound: they are already through Zod's int()/max() and ClickHouse does
    // not accept a bound parameter in LIMIT/OFFSET position.
    const sql = `
      SELECT received_at, reason, detail, payload
        FROM events_dead_letter
       WHERE project_id = ${projectParam}${clauses}
       ORDER BY received_at DESC
       LIMIT ${limit} OFFSET ${offset}`

    // Two steps, matching the shape every other ClickHouse read in this file
    // uses (the feed and stats handlers above), rather than introducing a
    // second convention. Same execution ceilings as those handlers too: a
    // silently truncated dead-letter page reads as "nothing was rejected",
    // which is worse than a loud error.
    const rs = await ch.query({
      query: sql,
      query_params: params.values,
      format: 'JSONEachRow',
      clickhouse_settings: {
        max_execution_time: SEGMENT_MAX_EXECUTION_SECONDS,
        max_memory_usage: String(SEGMENT_MAX_MEMORY_BYTES),
        timeout_overflow_mode: 'throw',
      },
    })
    const rows = await rs.json<RejectionRow>()

    const nextOffset = offset + rows.length

    reply.header('cache-control', 'no-store')
    return reply.code(200).send({
      // `received_at` is converted through the same `parseChDateTime(...)
      // .toISOString()` the feed and stats handlers above use, not sent
      // verbatim. ClickHouse emits a space-separated, zone-less string
      // ("2026-08-15 13:09:59.000"); `new Date(...)` on that shape is
      // parsed as LOCAL time by the browser, not UTC, so an unconverted
      // row rendered under a non-UTC TZ silently disagrees with the
      // Accepted tab one tab over about what "now" is.
      rejections: rows.map((r) => ({
        received_at: parseChDateTime(r.received_at).toISOString(),
        reason: r.reason,
        detail: r.detail,
        payload: r.payload,
      })),
      // A full page means there is more behind it — the same contract the
      // feed states, and the reason the UI must always send an explicit
      // limit. See rejectionsHasMore's own docstring for why that alone
      // is not sufficient.
      has_more: rejectionsHasMore(rows.length, limit, nextOffset),
      next_offset: nextOffset,
    })
  })
}
