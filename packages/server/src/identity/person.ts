import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import type { ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
import { parseChDateTime } from '../ingest/row.js'
import type { PersonAliases } from './aliases.js'
import type { IdentityBindings } from './bindings.js'

export interface PersonDeps {
  projects: ProjectCache
  readiness: Readiness
  ch: ClickHouseClient
  bindings: IdentityBindings
  aliases: PersonAliases
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
 */
export function registerPersonRoutes(app: FastifyInstance, deps: PersonDeps): void {
  const { projects, readiness, ch, bindings, aliases } = deps

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

    // Step 1: the canonical person for the requested id (PersonAliases).
    // Step 2: every id known for that *canonical* — the canonical itself
    // plus each device bound to it (IdentityBindings). Resolving step 2
    // against the canonical, not the raw path id, matters: a caller who
    // supplies an older id that has since been merged away must still see
    // every device bound to the surviving canonical, not an empty set.
    const canonical = await aliases.canonicalFor(project.id, req.params.id)
    const ids = await bindings.personIdsFor(project.id, canonical)

    // `ids` and `project.id` are both bound as query parameters, never
    // interpolated into the SQL text — the id set traces back to a
    // caller-supplied URL segment. project_id is bound independently and is
    // not optional: events rows carry anonymous_id/user_id as plain text
    // with no project qualifier baked in, so a dropped project_id filter
    // would let an identical id from another project leak into this one's
    // profile (see person.test.ts's project-scoping test, which puts two
    // projects in genuine contention over the same id to catch exactly that).
    const rs = await ch.query({
      query: `
        SELECT
          min(timestamp) AS first_seen,
          max(timestamp) AS last_seen,
          count(DISTINCT event_id) AS events
        FROM events
        WHERE project_id = {projectId:UInt32}
          AND (anonymous_id IN {ids:Array(String)} OR user_id IN {ids:Array(String)})
      `,
      query_params: { projectId: project.id, ids },
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<PersonEventsRow>()

    // Zero matching events: nothing under this project has ever heard of
    // this id. 404, not a 200 with zeroed-out fields — an id with no events
    // anywhere is not a profile to render, and a 404 lets a caller tell
    // "no such person" apart from "a real person who happens to have zero
    // events" without inspecting the body. In practice the latter is not
    // reachable through this endpoint anyway: personIdsFor always includes
    // the canonical id itself even with no bindings, so the only way to land
    // here with zero events is an id nothing has ever recorded.
    if (!row || row.events === '0') {
      return reply.code(404).send({ error: 'person_not_found' })
    }

    return reply.code(200).send({
      person_id: canonical,
      ids,
      first_seen: parseChDateTime(row.first_seen).toISOString(),
      last_seen: parseChDateTime(row.last_seen).toISOString(),
      events: Number(row.events),
    })
  })
}
