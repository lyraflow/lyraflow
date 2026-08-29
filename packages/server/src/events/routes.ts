import {
  MAX_WHERE_PREDICATES,
  Params,
  WherePredicate,
  chDateTime,
  notSuppressedExpr,
  resolvedPersonExpr,
  wherePredicate,
} from '@lyraflow/core'
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
import {
  type Breakdown,
  BreakdownError,
  MAX_BREAKDOWN_ROWS,
  breakdownColumns,
  breakdownExpr,
  breakdownOverflowed,
  foldSeries,
  parseBreakdown,
} from './breakdown.js'
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

const Query = z
  .object({
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    event: z.string().max(128).optional(),
    person: z.string().max(128).optional(),
    limit: countParam({ min: 1, max: EVENTS_MAX_LIMIT, fallback: 50 }),
    after: z.string().max(512).optional(),
    /** The backwards half of the keyset walk. Same codec as `after`; opposite
     * direction. Mutually exclusive with it -- see the refinement below. */
    before: z.string().max(512).optional(),
  })
  .refine((q) => !(q.after !== undefined && q.before !== undefined), {
    // Silently preferring one hands a caller a page they did not ask for,
    // walking away from the position they gave.
    message: 'before and after name opposite directions and cannot be combined',
    path: ['before'],
  })

/**
 * The `where` predicates' own schema -- the SAME one `reports/routes.ts`
 * validates a retention run's `start_where`/`return_where` against, not a
 * second notion of a valid predicate. `MAX_WHERE_PREDICATES` is imported
 * rather than restated for the reason its own docstring gives: an editor
 * that disables its "add" control has to know the number the schema rejects
 * on, and two literals a package apart drift into a form that builds a
 * request the server refuses.
 */
const StatsWhere = z.array(WherePredicate).max(MAX_WHERE_PREDICATES)

const StatsQuery = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  interval: z.enum(['1m', '1h', '1d', '1w']).default('1h'),
  /**
   * One event name, narrowing the aggregate the same way `Query.event`
   * narrows the feed above -- same field, same ceiling, same semantics.
   *
   * It exists because the two are read TOGETHER. The feed screen draws this
   * aggregate as a chart directly above the table `/v1/events` fills, so an
   * event filter that reached only one of them would leave a chart counting
   * everything above a table showing one event, with nothing on the screen
   * saying they were answering different questions.
   *
   * Independent of `group_by`: filtering to one event and grouping by event
   * name is a legitimate (if thin) request, and rejecting the combination
   * would be a rule the caller has to learn for no reason.
   */
  event: z.string().max(128).optional(),
  /**
   * Free-typed here and parsed by `parseBreakdown`, not a Zod enum, because
   * the `property:<key>` form carries a caller-supplied key that no enum can
   * enumerate. The two halves that DO reach SQL as identifiers -- an event
   * column name, and the interval -- are both checked against closed lists
   * before they get there; a property key is a bound parameter and never an
   * identifier at all.
   *
   * `event_name` still parses bare, which is the only value this parameter
   * had before trends and is what `cli/src/api/commands/snippet.ts` sends.
   */
  group_by: z.string().max(160).optional(),
  /**
   * The predicate list, as JSON, narrowing WHICH occurrences of the event
   * are counted.
   *
   * A `z.string()` here and the real schema below, because a query string
   * carries text while `WherePredicate` describes a value. JSON in a query
   * parameter is not pretty and the alternative is worse: a chart is
   * shareable as a link (`screens/trends/params.ts`), so a filter that could
   * not live in the URL would make a shared link reproduce a DIFFERENT chart
   * from the one the sender was looking at.
   *
   * The segment grammar verbatim -- the same `WherePredicate` a funnel step
   * and both sides of a retention grid carry -- so `contains` means one
   * thing in all four places and an operator added later arrives here for
   * free.
   */
  where: z.string().max(4000).optional(),
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
  series?: string
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
 * THREE PAGING SHAPES, ONE OUTPUT ORDERING. With no cursor, the only way to
 * get the *most recent* N events is to sort `DESC` and take the top N. A
 * backwards walk (`before`) wants the same thing relative to a position —
 * the N newest events *below* the cursor — so it reads `DESC` too. Only a
 * forward walk (`after`) wants the N events immediately following a
 * position, in the order they occurred, so it is the one shape that reads
 * `ASC` directly. Either `DESC` case is reversed in JS before responding,
 * because the response is always meant to read like a log — oldest of the
 * page first, newest last — and `--follow`'s next call should be able to
 * pick up from the very last event this call showed. Seeing `DESC` in the
 * SQL and an ascending response is not a bug: the reversal IS what makes
 * that true, and skipping it for a backwards page (it already arrives in
 * the order a profile would display it) is the shortcut that makes page 1
 * ascending and page 2 descending — a seam invisible to any test that
 * fetches a single page. One ordering, always; a screen that wants
 * newest-first reverses once, itself.
 *
 * The keyset predicate — `(timestamp, event_id) > (at, aid)` forward,
 * `<` backward — is the same tuple comparison either way; ClickHouse
 * compares tuples lexicographically, which is exactly keyset semantics: it
 * moves past `at` only when `event_id` is also past `aid` AT that same
 * instant, so two events sharing a timestamp are never skipped the way a
 * bare `timestamp > at` (or `<`) would skip them.
 *
 * `next_cursor` is always built from the LAST row of the page in the
 * returned (ascending) order — the newest event this call actually showed —
 * and `prev_cursor` from the FIRST (oldest), whichever direction produced
 * the page: the uniformity is the contract, the direction is an
 * implementation detail of one query. Either is `null` on an empty page:
 * there is nothing to continue from in that direction.
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

    // One cursor, plus which way it points. The codec is shared: the
    // position is the same fact in both directions, and this cursor is
    // deliberately unsigned (cursor.ts's module docstring) because it
    // enforces nothing -- an `after` value replayed as `before` is a
    // legitimate walk the other way from a real position, not a forgery.
    // That is why these need no distinct labels, unlike the funnel
    // reached/dropped cursors, which index different POPULATIONS.
    let cursor: { timestamp: string; eventId: string } | null = null
    let backwards = false
    const rawCursor = q.data.before ?? q.data.after
    if (rawCursor !== undefined) {
      backwards = q.data.before !== undefined
      try {
        cursor = decodeFeedCursor(rawCursor)
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
    //
    // Same argument, flipped: a `before` walk into 2024 with the default
    // still applied would end at whatever `now - 24h` happens to be, with
    // no error and no marker, exactly as arbitrarily as the `after` case
    // above. `cursor` below is set from EITHER `before` or `after` (see the
    // cursor-decode block above), so `!cursor` already closes both — this
    // is not two defaults to disable, it is one, gated on whether a keyset
    // predicate is already bounding the scan.
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
    // The keyset predicate. `<` walks into the past, `>` walks toward now;
    // ClickHouse compares tuples lexicographically, which is exactly what
    // stops two events sharing a timestamp from being skipped in EITHER
    // direction -- it moves past `at` only when `event_id` is also past
    // `aid` at that same instant.
    let afterClause = ''
    let cursorParams: Record<string, unknown> = {}
    if (cursor) {
      const at = params.add(cursor.timestamp, 'DateTime64(3)')
      cursorParams = { cursorEventId: cursor.eventId }
      const op = backwards ? '<' : '>'
      afterClause = ` AND (timestamp, event_id) ${op} (${at}, {cursorEventId:UUID})`
    }

    // DESC for "the N nearest the ceiling" -- true of the no-cursor call
    // (the newest N overall) and of a backwards walk (the newest N below the
    // cursor). Only a forward walk reads ASC, because a forward keyset
    // continuation wants the N immediately AFTER the cursor, in the order
    // they occurred.
    const direction = cursor && !backwards ? 'ASC' : 'DESC'

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

    // See this function's own docstring: DESC fetched the page newest-first
    // -- true of both the no-cursor call and a backwards walk -- and
    // reversing here is what turns that into a log read
    // oldest-of-the-page-first, so EVERY response this route produces is
    // ascending. The tempting shortcut is to return a backwards page
    // unreversed -- it already arrives in the order a profile displays --
    // but that makes page 1 (no cursor, DESC-then-reverse) ascending and
    // page 2 (backwards, unreversed) descending, and the seam is invisible
    // to any test that fetches a single page. One ordering, always; a
    // screen that wants newest-first reverses once, itself. Only a forward
    // walk fetched ASC already and needs no reversal.
    const rows = direction === 'DESC' ? fetched.reverse() : fetched

    // Always the page's own ends: `prev_cursor` from the first (oldest) row,
    // `next_cursor` from the last (newest), in every response whichever
    // direction produced it. The uniformity is the contract; the direction
    // is an implementation detail of one query. Null on an empty page --
    // there is nothing to continue from in either direction.
    const first = rows[0]
    const last = rows[rows.length - 1]
    const prev_cursor = first
      ? encodeFeedCursor({ timestamp: first.timestamp, eventId: first.event_id })
      : null
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
      prev_cursor,
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
    const { since, until, interval, event, group_by, where } = q.data

    let breakdown: Breakdown | undefined
    try {
      breakdown = parseBreakdown(group_by)
    } catch (err) {
      if (!(err instanceof BreakdownError)) throw err
      return reply.code(400).send({ error: 'invalid_group_by', detail: err.message })
    }

    // Two steps, and both failures are the SAME error code: from the
    // caller's side "that is not JSON" and "that is not a predicate" are one
    // mistake in one parameter. Refused rather than ignored -- a dropped
    // filter answers a wider question than was asked and looks exactly like
    // a correct answer.
    let predicates: WherePredicate[] = []
    if (where !== undefined) {
      let parsed: unknown
      try {
        parsed = JSON.parse(where)
      } catch {
        return reply
          .code(400)
          .send({ error: 'invalid_where', detail: 'where must be a JSON array of predicates' })
      }
      const list = StatsWhere.safeParse(parsed)
      if (!list.success) {
        return reply.code(400).send({
          error: 'invalid_where',
          detail: `that filter is not a valid predicate list (at most ${MAX_WHERE_PREDICATES} predicates)`,
        })
      }
      predicates = list.data
    }

    // Kept as its own flag: `group_by=event_name` must still put an
    // `event_name` field on every row, which is what the CLI's snippet
    // command reads. The generic `series` field is added alongside it rather
    // than replacing it.
    const groupBy = breakdown?.source === 'event_name'

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
    // INSIDE the inner select, beside the window clauses, not in the outer
    // `WHERE` -- the inner select is what `LIMIT 1 BY project_id, event_id`
    // dedups over, and its per-row memory is the ceiling this route's
    // default-window comment measures. Narrowing there makes the filter cut
    // the scan; narrowing outside would read every event in the window and
    // throw most of them away, which is the shape that exhausts memory.
    const eventClause =
      event === undefined ? '' : ` AND event_name = ${params.add(event, 'String')}`

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
    const now = new Date()
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
      return reply.code(400).send({
        error: 'too_many_series',
        detail: `that breakdown produces more than ${MAX_BREAKDOWN_ROWS} bucket/series rows; pick a lower-cardinality field, a coarser interval, or a narrower window`,
      })
    }

    const points = rows.map((r) => ({
      bucket: parseChDateTime(r.bucket).toISOString(),
      series: r.series ?? '',
      events: Number(r.events),
    }))

    if (seriesExpr === null) {
      return reply.code(200).send({
        buckets: points.map((p) => ({ bucket: p.bucket, events: p.events })),
      })
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

    return reply.code(200).send({
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
