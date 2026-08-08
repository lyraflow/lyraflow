import { Params, chDateTime, notSuppressedExpr, resolvedPersonExpr } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import type { PersonAliases } from '../identity/aliases.js'
import type { IdentityBindings } from '../identity/bindings.js'
import {
  MAX_PERSON_RANGE_CLAUSES,
  personEventsPredicate,
  resolvePersonScope,
} from '../identity/scope.js'
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
import { parseChDateTime } from '../ingest/row.js'
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

export interface EventsDeps {
  projects: ProjectCache
  readiness: Readiness
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
  limit: z.coerce.number().int().positive().max(EVENTS_MAX_LIMIT).default(50),
  after: z.string().max(512).optional(),
})

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
  const { projects, readiness, ch, bindings, aliases, database } = deps

  const authenticateServer = makeAuthenticator(
    readiness,
    SERVER_KEY_HEADER,
    (key) => projects.byServerKey(key),
    'missing_server_key',
    'invalid_server_key',
  )

  app.get('/v1/events', async (req, reply) => {
    const project = await authenticateServer(req, reply)
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

    // `since` defaults to 24h before now when the caller omits it —
    // ALWAYS applied, never an unbounded lower edge. `behaviourCte`
    // (segments/behaviour.ts), whose two-layer shape this route copies,
    // always carries a `scanBound`; every behavioural node's window is
    // finite unless it says `ever` explicitly. This route had no
    // equivalent, and `LIMIT 1 BY` in the inner subquery blocks any early
    // stop the outer `ORDER BY ... LIMIT n` might otherwise offer —
    // ClickHouse cannot know the `LIMIT 1 BY` output already comes out
    // sorted, since the inner subquery carries no `ORDER BY` of its own
    // (see the `afterClause` comment above for why it can't). Measured
    // directly against a 500,000-row fixture: this exact query, with
    // `limit=50` and no `since` at all, read all 500,000 rows and 52 MiB —
    // linear in project size, not in `limit`, extrapolating to a hard
    // `503` around 40M events. It fails loudly (`timeout_overflow_mode:
    // 'throw'`, below) rather than truncating, so it was never a
    // correctness bug, but it was an unbounded-by-default operational
    // ceiling nobody had noticed. Defaulting the window bounds every
    // unmarked call, matches what a real `--follow`-style caller would
    // send anyway, and an explicit, older `since` is still available for
    // anyone who genuinely wants more.
    const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000
    const sinceDate = since ? new Date(since) : new Date(Date.now() - DEFAULT_SINCE_MS)
    const sinceClause = ` AND timestamp >= ${params.add(chDateTime(sinceDate), 'DateTime64(3)')}`

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
}
