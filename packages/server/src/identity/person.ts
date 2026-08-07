import { chDateTime } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import type { ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
import { parseChDateTime } from '../ingest/row.js'
import type { SuppressionStore } from '../privacy/suppression-store.js'
import type { PersonAliases } from './aliases.js'
import type { IdentityBindings } from './bindings.js'
import { MAX_PERSON_RANGE_CLAUSES, personEventsPredicate, resolvePersonScope } from './scope.js'

// Re-exported so nothing importing it from person.ts (its home before the
// scope.ts extraction) breaks.
export { MAX_PERSON_RANGE_CLAUSES } from './scope.js'

export interface PersonDeps {
  projects: ProjectCache
  readiness: Readiness
  ch: ClickHouseClient
  bindings: IdentityBindings
  aliases: PersonAliases
  suppression: SuppressionStore
}

interface PersonParams {
  id: string
}

interface PersonEventsRow {
  first_seen: string
  last_seen: string
  // ClickHouse's HTTP interface quotes UInt64 values as JSON strings by
  // default (avoids precision loss past 2^53) — see the identical parsing
  // in schema-clickhouse.test.ts's count() assertions.
  events: string
}

/**
 * GET /v1/persons/:id — a single-person read that deliberately bypasses the
 * ClickHouse identity dictionaries (`identity_bindings`, `person_aliases`;
 * see dictionaries.ts). Those dictionaries refresh on a LIFETIME of 5-15s,
 * which is fine for a segment-wide count but not for a profile view opened
 * right after identify(): a dictionary-backed read could still show the
 * anonymous stranger for up to 15 seconds. This route instead resolves the
 * person's full id set from Postgres directly — authoritative, zero-lag —
 * via the exact same tables/classes the write path itself uses
 * (IdentityBindings, PersonAliases), and hands that set to ClickHouse as a
 * bound query parameter, never interpolated (the id is a caller-supplied URL
 * path segment).
 *
 * Server-key only, reusing routes.ts's makeAuthenticator/SERVER_KEY_HEADER
 * rather than a second auth implementation — this reads a person's data, so
 * it is gated the same way /v1/alias is gated against mutating one: the
 * public, browser-shipped write key must not reach it.
 *
 * TIME-AWARE, matching `resolvedPersonExpr` (resolve.ts) — this used to be a
 * UNION over every id ever associated with the person, with no timestamp
 * predicate at all, which is why a device shared or rebound between two
 * people put its ENTIRE history into both profiles. That divergence carried
 * across two plans (see person.test.ts's rewritten test for the full
 * history) and is closed here by mirroring `resolvedPersonExpr`'s two
 * stages directly in the query below:
 *
 *  - Stage 1: an event carrying its own non-empty `user_id` belongs to that
 *    person, full stop — the `user_id IN {group:...}` branch.
 *  - Stage 2: everything else resolves through the device it was recorded
 *    on, but only for the [from, to) window that device was actually bound
 *    to a member of this group — derived per device via `deriveTiling`
 *    (`@lyraflow/core`), the same reference derivation
 *    `identity_bindings_dict_src` (003_identity.sql) is required to agree
 *    with. Guarded on `user_id = ''` so stage 1 keeps its short-circuit: an
 *    event with its own `user_id` must never ALSO match here through the
 *    device it happens to sit on, which is exactly how a fix for the wide
 *    half of this defect can reintroduce the narrow half.
 *
 * `bindEventsForDevices` returns bind events for every person ever bound to
 * each device, not just this group — a device's windows are defined by its
 * whole bind sequence, and filtering to one person first would leave every
 * window open to infinity, reintroducing the union. Windows are filtered to
 * this group only after `deriveTiling` has seen the whole sequence.
 *
 * The full "which events belong to this person" derivation — alias
 * resolution, the device-id fallback, and the per-device windows — lives in
 * scope.ts's `resolvePersonScope`/`personEventsPredicate`, shared with the
 * export, the purge worker, and the deletion route's existence check.
 *
 * Also honours a deletion boundary, resolved from Postgres for the same
 * zero-lag reason as the identity resolution above — see the comment on
 * `boundary` inside the handler for why Postgres and not the ClickHouse
 * suppression dictionary.
 */
export function registerPersonRoutes(app: FastifyInstance, deps: PersonDeps): void {
  const { projects, readiness, ch, bindings, aliases, suppression } = deps

  const authenticateServer = makeAuthenticator(
    readiness,
    SERVER_KEY_HEADER,
    (key) => projects.byServerKey(key),
    'missing_server_key',
    'invalid_server_key',
  )

  app.get<{ Params: PersonParams }>('/v1/persons/:id', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return

    const scope = await resolvePersonScope({ bindings, aliases }, project.id, req.params.id)

    if (scope.windows.length > MAX_PERSON_RANGE_CLAUSES) {
      return reply.code(400).send({
        error: 'person_history_too_fragmented',
        detail: `this person spans ${scope.windows.length} device windows, above the limit of ${MAX_PERSON_RANGE_CLAUSES}`,
      })
    }

    // `project.id` is bound independently and is not optional: events rows
    // carry anonymous_id/user_id as plain text with no project qualifier
    // baked in, so a dropped project_id filter would let an identical id
    // from another project leak into this one's profile (see
    // person.test.ts's project-scoping test, which puts two projects in
    // genuine contention over the same id to catch exactly that).
    const boundary = await suppression.boundaryFor(project.id, scope.group)
    const params: Record<string, unknown> = { projectId: project.id }
    const identity = personEventsPredicate(scope, params)
    // Suppression, from Postgres rather than the ClickHouse dictionary — this
    // route bypasses the dictionaries for zero identity lag, and a 1-5s
    // dictionary LIFETIME would put that lag back on the one path where a
    // person reads their own data. Postgres also makes a just-requested
    // deletion take effect immediately, with no reload.
    //
    // Strictly greater than: the boundary is inclusive of the events it
    // erases (`timestamp <= suppressed_at` is suppressed), matching the
    // dictionary-side predicate in @lyraflow/core exactly. The two must agree
    // on the boundary instant itself, or a segment count and a profile
    // disagree by one event for anyone deleted at the same millisecond they
    // acted.
    let boundaryClause = ''
    if (boundary) {
      params.boundary = chDateTime(boundary)
      boundaryClause = ' AND timestamp > {boundary:DateTime64(3)}'
    }

    const rs = await ch.query({
      query: `
        SELECT
          min(timestamp) AS first_seen,
          max(timestamp) AS last_seen,
          count(DISTINCT event_id) AS events
        FROM events
        WHERE project_id = {projectId:UInt32}
          AND ${identity}${boundaryClause}
      `,
      query_params: params,
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<PersonEventsRow>()

    // Zero matching events: nothing under this project has ever heard of
    // this id, OR everything it ever did sits at or before its own deletion
    // boundary. 404, not a 200 with zeroed-out fields — an id with no events
    // anywhere is not a profile to render, and a 404 lets a caller tell
    // "no such person" apart from "a real person who happens to have zero
    // events" without inspecting the body. In practice the latter is not
    // reachable through this endpoint anyway: `scope.group` always includes
    // the canonical id itself even with no bindings or merges, so the only
    // way to land here with zero events is an id nothing has ever recorded,
    // or one entirely erased by the boundary above.
    //
    // Compared numerically, not `row.events === '0'`: ClickHouse's HTTP
    // interface quotes UInt64 values as JSON strings by default, but that is
    // a server-side formatting setting, not a guarantee — a string literal
    // comparison stays coupled to it for no reason, where Number(...) === 0
    // does not care either way.
    if (!row || Number(row.events) === 0) {
      return reply.code(404).send({ error: 'person_not_found' })
    }

    return reply.code(200).send({
      person_id: scope.canonical,
      ids: scope.ids,
      first_seen: parseChDateTime(row.first_seen).toISOString(),
      last_seen: parseChDateTime(row.last_seen).toISOString(),
      events: Number(row.events),
    })
  })
}
