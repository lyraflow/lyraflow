import { Readable } from 'node:stream'
import { chDateTime } from '@lyraflow/core'
import type { FastifyInstance } from 'fastify'
import {
  MAX_PERSON_RANGE_CLAUSES,
  personEventSummary,
  personEventsPredicate,
  resolvePersonScope,
} from '../identity/scope.js'
import { mergeTraits, readPersonTraitRows } from '../identity/traits.js'
import { parseChDateTime } from '../ingest/row.js'
import { SEGMENT_MAX_MEMORY_BYTES } from '../segments/execute.js'
import { DEAD_LETTER_MATCH, DEAD_LETTER_OWNED_BY_IDS } from './dead-letter.js'
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
 * GET /v1/persons/:id/export — a subject-access request, streamed as
 * NDJSON: one `person` line, the `event` lines, then any `rejection`
 * lines, then a terminating `end` line carrying the counts actually
 * emitted.
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
 * boundary exists — see readPersonTraitRows's own docstring (identity/
 * traits.ts) for why they cannot be split at it the way an event can.
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

    // Traits are omitted entirely once a boundary exists — see
    // readPersonTraitRows's own docstring.
    const traits = boundary
      ? {}
      : mergeTraits(await readPersonTraitRows(ch, project.id, scope, EXPORT_MAX_EXECUTION_SECONDS))

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
      let rejections = 0
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

        // Rejected payloads are matched by the SAME predicate the purge
        // deletes them with (dead-letter.ts), so what deletion treats as
        // this person's data, the export shows as this person's data. It is
        // a substring match over text that failed to parse, which the
        // `match` field says on every line.
        const dl = await ch.query({
          query: `SELECT received_at, reason, detail, payload
                    FROM events_dead_letter
                   WHERE project_id = {projectId:UInt32}
                     AND ${DEAD_LETTER_OWNED_BY_IDS}${boundary ? ' AND received_at > {boundary:DateTime64(3)}' : ''}
                   ORDER BY received_at ASC`,
          query_params: {
            projectId: params.projectId,
            ids: scope.ids,
            ...(boundary ? { boundary: chDateTime(boundary) } : {}),
          },
          format: 'JSONEachRow',
          clickhouse_settings: {
            max_execution_time: EXPORT_MAX_EXECUTION_SECONDS,
            max_memory_usage: String(SEGMENT_MAX_MEMORY_BYTES),
            timeout_overflow_mode: 'throw',
          },
        })
        for await (const rows of dl.stream()) {
          for (const row of rows) {
            const r = row.json<{
              received_at: string
              reason: string
              detail: string
              payload: string
            }>()
            rejections += 1
            yield `${JSON.stringify({
              type: 'rejection',
              received_at: parseChDateTime(r.received_at).toISOString(),
              reason: r.reason,
              detail: r.detail,
              payload: r.payload,
              match: DEAD_LETTER_MATCH,
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
      yield `${JSON.stringify({ type: 'end', events: emitted, rejections })}\n`
    }

    reply.header('content-type', 'application/x-ndjson')
    // A subject-access response must not sit in an intermediary's cache.
    reply.header('cache-control', 'no-store')
    return reply.send(Readable.from(lines()))
  })
}
