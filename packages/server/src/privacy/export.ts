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
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
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
 * for exactly the group + devices a resolved `PersonScope` names.
 *
 * Traits carry no event time (see 004_person_traits.sql: value_str/
 * value_num/has_num are `argMax(…, timestamp)` states with the timestamp
 * itself discarded, not stored per row) — so unlike the events query below,
 * there is no timestamp predicate to add here. That absence is exactly why
 * the caller only calls this when there is no deletion boundary at all: a
 * trait cannot be split at an instant it does not carry.
 *
 * `scope.devices`, not `scope.windows` — a trait predicate has no window to
 * restrict to; any device this group has EVER owned qualifies, the same
 * unrestricted-by-time reach `compile.ts`'s segment-wide trait CTE gives
 * every person's traits.
 */
async function readTraits(
  ch: ClickHouseClient,
  projectId: number,
  scope: Pick<PersonScope, 'group' | 'devices'>,
): Promise<Record<string, string | number>> {
  const params: Record<string, unknown> = { projectId, group: scope.group }
  // Mirrors personEventsPredicate's own conditional device branch: omitted
  // entirely for a person with no device ever bound (e.g. server-side-only
  // identify()), rather than binding an empty Array(String) for no reason.
  let deviceClause = ''
  if (scope.devices.length > 0) {
    params.devices = scope.devices
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
  const { projects, readiness, ch, bindings, aliases, suppression } = deps

  const authenticateServer = makeAuthenticator(
    readiness,
    SERVER_KEY_HEADER,
    (key) => projects.byServerKey(key),
    'missing_server_key',
    'invalid_server_key',
  )

  app.get<{ Params: ExportParams }>('/v1/persons/:id/export', async (req, reply) => {
    const project = await authenticateServer(req, reply)
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
    const totals = await personEventSummary(ch, project.id, scope, {
      after: boundary ?? undefined,
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
          // one.
          query: `SELECT event_id, timestamp, received_at, event_name, anonymous_id, user_id,
                         properties, properties_num, url, path, referrer,
                         utm_source, utm_medium, utm_campaign, utm_term, utm_content,
                         device_type, os, browser, country, region, city
                  FROM events
                  WHERE ${where}
                  ORDER BY timestamp ASC, event_id ASC
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
