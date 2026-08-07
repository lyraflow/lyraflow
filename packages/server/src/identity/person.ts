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
 *
 * KNOWN DIVERGENCE — read this before changing anything below. This route
 * returns the UNION over every id ever associated with the person. It is NOT
 * the time-split resolution `resolvedPersonExpr` (resolve.ts) applies to
 * events, and the two can return different people for the same event row:
 *
 *  - `devicesForAny` returns every device ever bound to the group, with no
 *    notion of when each binding was in force, and the ClickHouse query
 *    below carries no timestamp predicate at all. `resolvedPersonExpr`
 *    splits the same device by `toDateTime(timestamp)` against the range
 *    dictionary. So a device D bound to `alice` at t1 and rebound to `bob`
 *    at t2 puts D's ENTIRE event history into both profiles: alice's counts
 *    everything after t2, bob's counts everything before it. Both
 *    `first_seen`/`last_seen` windows are too wide and both `events` counts
 *    are too high, in opposite directions.
 *  - No rebind is needed for a narrower version of the same thing: an event
 *    carrying `user_id='bob'` with `anonymous_id='D'`, where D is bound to
 *    `alice`, resolves to `bob` in the dictionary (stage 1's `user_id != ''`
 *    short-circuit) but is counted for `alice` here, because D is in her id
 *    set.
 *
 * The fix is to derive per-device validity windows into the predicate below,
 * which is the query work Plan 3 owns; it is deliberately NOT attempted here.
 * Until then the divergence is documented (README's *Reading a person*) and
 * pinned by an explicit test — person.test.ts's "counts a rebound device's
 * whole history for BOTH people", which asserts today's behaviour and names
 * what the time-split path would answer instead. If you fix this, that test
 * is what will fail, and it is meant to.
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
    // Step 2: every id ever merged INTO that canonical (PersonAliases again)
    // — not just the canonical itself. Step 3: every device bound to *any*
    // id in that whole group (IdentityBindings), in one round trip.
    //
    // Step 2 is not optional. `/v1/alias` only ever writes to person_aliases;
    // it never repoints identity_bindings.person_id. So a device bound to an
    // id that later gets merged away stays bound to that old id in Postgres
    // forever — querying IdentityBindings for the canonical alone would never
    // find it, and neither would an event recorded with that old id as its
    // raw user_id. Skipping step 2 previously meant a person's own profile
    // could be *missing* history a segment query (which resolves through
    // both dictionary stages unconditionally — see resolve.ts) would still
    // count — the read path meant to be more authoritative than the lagging
    // dictionary returning a strictly less complete answer than it. Every id
    // in `group` below is treated equally: the canonical has no special
    // status once resolved, it is simply one more member whose own devices
    // must be included.
    const canonical = await aliases.canonicalFor(project.id, req.params.id)
    const mergedFrom = await aliases.mergedFrom(project.id, canonical)
    const group = [canonical, ...mergedFrom]
    const devices = await bindings.devicesForAny(project.id, group)
    // Deduped and sorted: `group` and `devices` can overlap (e.g.
    // identify({anonymous_id:'x', user_id:'x'}) binds a device id that is
    // identical to the person id, which would otherwise put 'x' in `ids`
    // twice), and neither query above carries an ORDER BY. The response is a
    // set, not a log; nothing about it should depend on Postgres's incidental
    // row order.
    const ids = Array.from(new Set([...group, ...devices])).sort()

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
    // reachable through this endpoint anyway: `group` always includes the
    // canonical id itself even with no bindings or merges, so the only way
    // to land here with zero events is an id nothing has ever recorded.
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
      person_id: canonical,
      ids,
      first_seen: parseChDateTime(row.first_seen).toISOString(),
      last_seen: parseChDateTime(row.last_seen).toISOString(),
      events: Number(row.events),
    })
  })
}
