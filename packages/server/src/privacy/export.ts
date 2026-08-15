import { Readable } from 'node:stream'
import { chDateTime } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import {
  MAX_PERSON_RANGE_CLAUSES,
  type PersonScope,
  personEventSummary,
  personEventsPredicate,
  resolvePersonScope,
} from '../identity/scope.js'
import { parseChDateTime } from '../ingest/row.js'
import { SEGMENT_MAX_MEMORY_BYTES } from '../segments/execute.js'
import type { PrivacyDeps } from './routes.js'

interface ExportParams {
  id: string
}

/**
 * A subject-access export may legitimately run long against a large
 * timeline; it may not run forever. Same shape as the segment query's own
 * `SEGMENT_MAX_EXECUTION_SECONDS` (segments/execute.ts), sized up because a
 * single person's full history can outrun one segment page.
 */
export const EXPORT_MAX_EXECUTION_SECONDS = 300

/**
 * Folds `person_traits`' argMax states into a plain object for the wire,
 * for exactly this group plus the devices it CURRENTLY owns.
 *
 * Traits carry no event time (see 004_person_traits.sql: value_str/
 * value_num/has_num are `argMax(…, timestamp)` states with the timestamp
 * itself discarded, not stored per row) — so unlike the events query below,
 * there is no per-event timestamp predicate to add here. That absence is
 * exactly why the caller only calls this when there is no deletion boundary
 * at all: a trait cannot be split at an instant it does not carry.
 *
 * An anonymous trait row (`user_id = ''`) is keyed only by `anonymous_id` —
 * it cannot itself say WHICH owner of that device it belongs to, and a
 * device can have had several over time. `compile.ts`'s segment-wide trait
 * CTE resolves this ambiguity by giving an anonymous row to the device's
 * CURRENT owner and no one else (`resolvedPersonExpr(..., 'tr')` with `now()
 * AS timestamp` — see that CTE's own comment). This function has to agree
 * with that exact rule, not merely "any device this group has ever owned":
 * `scope.windows` already carries this group's own per-device windows, and
 * `deriveTiling`/`coalesceContiguous` (scope.ts) guarantee at most one open
 * window per device — the one with no upper bound (`to === Infinity`) is
 * the device's current tile. Anything else is a PAST window, and handing a
 * past owner's export another owner's anonymous traits is a leak: an
 * anonymous `$identify` on a shared device is exactly the "identify
 * anonymously before login" shape that produces a `user_id = ''` trait row
 * in the first place, and `devicesForAny`/`scope.devices` has no time bound
 * at all — using it here (as an earlier version of this function did) would
 * fan that one row out to every past owner too, not just the current one.
 */
async function readTraits(
  ch: ClickHouseClient,
  projectId: number,
  scope: Pick<PersonScope, 'group' | 'windows'>,
): Promise<Record<string, string | number>> {
  const params: Record<string, unknown> = { projectId, group: scope.group }
  const currentDevices = scope.windows.filter((w) => !Number.isFinite(w.to)).map((w) => w.device)
  // Mirrors personEventsPredicate's own conditional device branch: omitted
  // entirely when this group owns no device's current window (e.g.
  // server-side-only identify(), or every device it ever touched has since
  // moved on to someone else), rather than binding an empty Array(String)
  // for no reason.
  let deviceClause = ''
  if (currentDevices.length > 0) {
    params.devices = currentDevices
    deviceClause = ` OR (user_id = '' AND anonymous_id IN {devices:Array(String)})`
  }

  const rs = await ch.query({
    query: `
      SELECT
        trait_key,
        argMaxMerge(value_str) AS value_str,
        argMaxMerge(value_num) AS value_num,
        argMaxMerge(has_num) AS has_num
      FROM person_traits
      WHERE project_id = {projectId:UInt32}
        AND (user_id IN {group:Array(String)}${deviceClause})
      GROUP BY trait_key
    `,
    query_params: params,
    format: 'JSONEachRow',
    // Its OR defeats person_traits' own sort key, making this an
    // argMaxMerge aggregate over the project's whole partition when no
    // ceiling is set — reachable by an authenticated caller on repeat, and
    // there is no server-side default anywhere in this repo. Same ceilings
    // as the events query below.
    clickhouse_settings: {
      max_execution_time: EXPORT_MAX_EXECUTION_SECONDS,
      max_memory_usage: String(SEGMENT_MAX_MEMORY_BYTES),
      timeout_overflow_mode: 'throw',
    },
  })
  const rows = await rs.json<{
    trait_key: string
    value_str: string
    value_num: number
    has_num: number
  }>()

  const traits: Record<string, string | number> = {}
  for (const row of rows) {
    // has_num distinguishes "numeric trait, possibly zero" from "string
    // trait, so value_num is a meaningless default" — same guard
    // predicates.ts's segment-side trait comparisons apply to t_has_num.
    traits[row.trait_key] = row.has_num ? Number(row.value_num) : row.value_str
  }
  return traits
}

/**
 * GET /v1/persons/:id/export — a subject-access request, streamed as
 * NDJSON: one `person` line, then one `event` line per surviving event,
 * then a terminating `end` line carrying the count actually emitted.
 *
 * Streamed, not buffered into one in-memory or on-disk document, because a
 * second copy of one person's complete personal data is exactly the new
 * privacy liability an async export job (or a buffered response) would
 * create, with its own retention, access control and deletion policy this
 * endpoint has none of by design — there is nothing to retain.
 *
 * The cost of streaming: status and headers commit the instant the body
 * starts, so a mid-stream ClickHouse failure cannot become an HTTP error.
 * The generator below logs and returns instead of throwing, ending the
 * response WITHOUT the `end` line — the wire format's own signal that a
 * response is incomplete and must be discarded (see the README section
 * this task adds, and export.test.ts's forced-failure test).
 *
 * Applies the deletion boundary, unlike the deletion route's own existence
 * check: this is a read, and an export that returned what deletion removed
 * would be a way to read it back. Traits are omitted entirely once a
 * boundary exists — see readTraits's own docstring for why they cannot be
 * split at it the way an event can.
 */
export function registerExportRoute(app: FastifyInstance, deps: PrivacyDeps): void {
  const { authenticate, ch, bindings, aliases, suppression } = deps

  app.get<{ Params: ExportParams }>('/v1/persons/:id/export', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    // The exact same resolution GET /v1/persons/:id uses, including its
    // device-id fallback (scope.ts's step 4).
    const scope = await resolvePersonScope({ bindings, aliases }, project.id, req.params.id)

    // Same cap, same 400, as the person read — unlike the deletion route
    // (which chunks and must never refuse to erase), refusing to RENDER an
    // export for the most fragmented people is an acceptable answer;
    // refusing to erase them would not be.
    if (scope.windows.length > MAX_PERSON_RANGE_CLAUSES) {
      return reply.code(400).send({
        error: 'person_history_too_fragmented',
        detail: `this person spans ${scope.windows.length} device windows, above the limit of ${MAX_PERSON_RANGE_CLAUSES}`,
      })
    }

    // From Postgres directly, not the ClickHouse suppression dictionary —
    // same zero-lag reasoning as GET /v1/persons/:id (suppression-store.ts's
    // own docstring): a just-requested deletion must be honoured by this
    // export immediately, with no dictionary reload to wait on.
    const boundary = await suppression.boundaryFor(project.id, scope.group)

    const params: Record<string, unknown> = { projectId: project.id }
    const identity = personEventsPredicate(scope, params)
    let boundaryClause = ''
    if (boundary) {
      params.boundary = chDateTime(boundary)
      // Strictly greater-than: the boundary instant itself is inclusive of
      // the events it erases, matching personEventSummary's own `after`
      // clause and GET /v1/persons/:id's identical comparison.
      boundaryClause = ' AND timestamp > {boundary:DateTime64(3)}'
    }
    const where = `project_id = {projectId:UInt32} AND ${identity}${boundaryClause}`

    // The 404 decision must be made BEFORE a single byte of the response is
    // written: the status line commits the moment the body starts. One
    // aggregate query — personEventSummary, the same one GET /v1/persons/:id
    // and the deletion route's existence check use — never a third
    // hand-rolled copy of it (see scope.ts's own docstring for why that
    // convergence matters).
    //
    // maxExecutionSeconds is this route's own EXPORT_MAX_EXECUTION_SECONDS,
    // not the interactive 30s default the other two callers keep: this is
    // the first query a subject-access request runs, over potentially this
    // person's entire history, and — unlike the per-event query below —
    // it runs BEFORE the response commits, so timing it out too early would
    // trade a real answer for an early, avoidable 503 on exactly the large
    // histories this endpoint most needs to finish for.
    const totals = await personEventSummary(ch, project.id, scope, {
      after: boundary ?? undefined,
      maxExecutionSeconds: EXPORT_MAX_EXECUTION_SECONDS,
    })
    if (totals.events === 0) {
      return reply.code(404).send({ error: 'person_not_found' })
    }

    // Traits are omitted entirely once a boundary exists — see readTraits's
    // own docstring.
    const traits = boundary ? {} : await readTraits(ch, project.id, scope)

    const person = {
      type: 'person',
      person_id: scope.canonical,
      ids: scope.ids,
      traits,
      first_seen: parseChDateTime(totals.firstSeen).toISOString(),
      last_seen: parseChDateTime(totals.lastSeen).toISOString(),
    }

    async function* lines(): AsyncGenerator<string> {
      yield `${JSON.stringify(person)}\n`
      let emitted = 0
      try {
        const rs = await ch.query({
          // Column list is a compile-time allowlist; no request data ever
          // reaches the SELECT. LIMIT 1 BY is the event_id deduplication
          // every count in this codebase owes it (see personEventSummary's
          // own `count(DISTINCT event_id)`) — `events` is a
          // ReplacingMergeTree, so a retried delivery that omitted
          // `timestamp` is a permanent second row, not a self-deduplicating
          // one. `(timestamp, event_id)` alone is not a total order across
          // duplicate deliveries of the SAME event_id at the SAME
          // timestamp, so a third key is needed to pick a row
          // deterministically — and `received_at DESC`, not ASC, is the
          // only choice that stays deterministic over time: `events` is
          // declared `ReplacingMergeTree(received_at)` (002_events.sql),
          // meaning `received_at` IS the engine's own version column, and a
          // background merge collapses duplicates to the row with the
          // HIGHEST received_at whether this query asks for it or not. An
          // ASC tiebreak would agree with LIMIT 1 BY only until the first
          // merge runs, then silently disagree with it — the exact same
          // export request answering differently before and after a merge
          // it never controls. DESC always agrees with where the engine is
          // already headed, so the answer is stable regardless of merge
          // timing.
          query: `SELECT event_id, timestamp, received_at, event_name, anonymous_id, user_id,
                         properties, properties_num, url, path, referrer,
                         utm_source, utm_medium, utm_campaign, utm_term, utm_content,
                         device_type, os, browser, country, region, city
                  FROM events
                  WHERE ${where}
                  ORDER BY timestamp ASC, event_id ASC, received_at DESC
                  LIMIT 1 BY project_id, event_id`,
          query_params: params,
          format: 'JSONEachRow',
          clickhouse_settings: {
            max_execution_time: EXPORT_MAX_EXECUTION_SECONDS,
            max_memory_usage: String(SEGMENT_MAX_MEMORY_BYTES),
            timeout_overflow_mode: 'throw',
          },
        })
        for await (const rows of rs.stream()) {
          for (const row of rows) {
            const e = row.json<Record<string, unknown>>()
            emitted += 1
            yield `${JSON.stringify({
              type: 'event',
              ...e,
              timestamp: parseChDateTime(String(e.timestamp)).toISOString(),
              received_at: parseChDateTime(String(e.received_at)).toISOString(),
            })}\n`
          }
        }
      } catch (err) {
        // The status line is long gone, so this cannot become an HTTP
        // error. The stream ends WITHOUT the `end` line, which is exactly
        // the signal the wire format defines: a caller that never sees
        // `end` has an incomplete export and must discard it.
        //
        // Deliberately not `throw`: a throw inside a streaming reply
        // destroys the response with an error the caller cannot
        // distinguish from a dropped connection anyway, and risks an
        // unhandled rejection on a path nothing awaits. The missing
        // terminator is the honest, checkable signal instead.
        req.log.error({ err }, 'person export failed mid-stream')
        return
      }
      yield `${JSON.stringify({ type: 'end', events: emitted })}\n`
    }

    reply.header('content-type', 'application/x-ndjson')
    // A subject-access response must not sit in an intermediary's cache.
    reply.header('cache-control', 'no-store')
    return reply.send(Readable.from(lines()))
  })
}
