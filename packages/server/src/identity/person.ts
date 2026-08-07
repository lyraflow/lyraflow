import { chDateTime, coalesceContiguous, deriveTiling } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import type { ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
import { parseChDateTime } from '../ingest/row.js'
import type { PersonAliases } from './aliases.js'
import type { IdentityBindings } from './bindings.js'

/**
 * A person's windows are devices multiplied by rebinds, which is unbounded in
 * principle. Past this many clauses the request is refused rather than
 * widened: widening a range to fit is how the union behaviour comes back.
 */
export const MAX_PERSON_RANGE_CLAUSES = 200

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

  /**
   * Steps 1-3 of the resolution below, extracted because step 4 (the device
   * lookup) has to run all three again against the person it discovers.
   */
  interface ResolvedGroup {
    canonical: string
    /** The canonical plus every id merged into it. */
    group: string[]
    /** Every device bound to any member of `group`. */
    devices: string[]
  }
  async function resolveGroup(projectId: number, id: string): Promise<ResolvedGroup> {
    const canonical = await aliases.canonicalFor(projectId, id)
    const mergedFrom = await aliases.mergedFrom(projectId, canonical)
    const group = [canonical, ...mergedFrom]
    return { canonical, group, devices: await bindings.devicesForAny(projectId, group) }
  }

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
    const resolved = await resolveGroup(project.id, req.params.id)

    // Step 4, and only when steps 1-3 all came back empty-handed: the
    // requested id may be a DEVICE id rather than a person id. Everything
    // above is keyed on person_id, so without this a device id resolves to
    // itself and the route answers a plausible-looking but silently wrong
    // 200 (`person_id: "visitor-1", ids: ["visitor-1"]`) — worse than a 404,
    // because nothing in the response says it failed. README documents `:id`
    // as accepting a device id; this lookup is what makes that true, rather
    // than retreating in the docs.
    //
    // Gated on "no alias of its own, nothing merged into it, and no devices
    // of its own" — `group.length === 1` covers the first two, since an id
    // with an alias resolves to a canonical that has at least this id merged
    // into it. That is exactly the state in which nothing has ever identified
    // this id as a person. A real person id fails the gate the moment it has
    // been identified against, including the
    // identify({anonymous_id:'x', user_id:'x'}) case where the two ids
    // coincide (that id IS one of its own devices, so `devices` is
    // non-empty). So the device lookup can never shadow a real person, and
    // costs one extra query only on a path that would otherwise 404.
    //
    // A device bound to several people over time resolves to the most
    // recently bound — see mostRecentPersonFor for why that answer and not
    // another.
    const looksUnknown = resolved.group.length === 1 && resolved.devices.length === 0
    const owner = looksUnknown
      ? await bindings.mostRecentPersonFor(project.id, req.params.id)
      : null
    const { canonical, group, devices } = owner ? await resolveGroup(project.id, owner) : resolved
    // Deduped and sorted: `group` and `devices` can overlap (e.g.
    // identify({anonymous_id:'x', user_id:'x'}) binds a device id that is
    // identical to the person id, which would otherwise put 'x' in `ids`
    // twice), and neither query above carries an ORDER BY. The response is a
    // set, not a log; nothing about it should depend on Postgres's incidental
    // row order.
    const ids = Array.from(new Set([...group, ...devices])).sort()

    // Every bind event on every device this group ever touched, keyed by
    // device — scoped by project.id (see bindings.ts's bindEventsForDevices),
    // which matters here specifically because `devices` is caller-influenced
    // (it traces back to the group PersonAliases/IdentityBindings resolved
    // for a caller-supplied id): an unscoped lookup could pull another
    // project's bind rows for a device id that collides across projects (see
    // person.test.ts's "does not leak another project's binds" test, which
    // puts two projects in genuine contention on the SAME device id to catch
    // exactly that).
    const bindEvents = await bindings.bindEventsForDevices(project.id, devices)

    // One [from, to) window per device per CONTIGUOUS owner, derived through
    // the same function 003_identity.sql's view is required to agree with.
    // Keeping the derivation in one place is what "converge onto one
    // implementation of the tiling" actually asks for; the two SQL shapes
    // stay different because the two reads have different jobs.
    //
    // coalesceContiguous runs on every device's tiling before it is filtered
    // to this group. `deriveTiling` deliberately never collapses adjacent
    // same-person tiles (see its own docstring) — a logged-in browser's every
    // page load writes a fresh bind row (bindings.ts's GROWTH CHARACTERISTIC
    // note), each carrying a distinct server-receipt instant, so one device
    // used by one person for N page loads tiles as N boundary-touching,
    // same-person tiles rather than one. Left uncollapsed, that is N windows
    // per device instead of 1, and MAX_PERSON_RANGE_CLAUSES below turns a
    // routine 201st page view into a permanent 400 for that customer.
    //
    // This is NOT the widening MAX_PERSON_RANGE_CLAUSES exists to forbid.
    // Widening stretches a range across an actual gap or a different owner to
    // make something fit a budget, changing what the range means. Merging
    // alice[10,20) with alice[20,30) changes nothing: the boundary between
    // them is a same-person handoff, so their union IS EXACTLY alice[10,30) —
    // no approximation, no information lost. coalesceContiguous only ever
    // merges a true handoff (same personId, touching boundary); a gap can't
    // occur (deriveTiling's tiling is always gapless) and a different person
    // in between always breaks the merge, so this can only shrink the window
    // count, never change which person owns which instant. See
    // coalesceContiguous's own docstring in @lyraflow/core for the full
    // argument.
    const windows: Array<{ device: string; from: number; to: number }> = []
    for (const [device, events] of bindEvents) {
      for (const binding of coalesceContiguous(deriveTiling(events))) {
        if (group.includes(binding.personId)) {
          windows.push({ device, from: binding.from, to: binding.to })
        }
      }
    }

    if (windows.length > MAX_PERSON_RANGE_CLAUSES) {
      return reply.code(400).send({
        error: 'person_history_too_fragmented',
        detail: `this person spans ${windows.length} device windows, above the limit of ${MAX_PERSON_RANGE_CLAUSES}`,
      })
    }

    // Stage 1's short-circuit, expressed as SQL: an event carrying a
    // non-empty user_id belongs to that user, full stop. The device branch is
    // therefore guarded on user_id = '' — without that guard an event with
    // user_id='bob' sitting on alice's device is counted for BOTH, which is
    // the narrower defect this convergence is also meant to fix.
    //
    // Every value reaching SQL is a bound parameter, `project.id` included —
    // `group` traces back to a caller-supplied URL segment, and `device`
    // traces back to whatever anonymous_id a client chose to send.
    //
    // `w.from`/`w.to` can be ±Infinity — the earliest tile a device ever had
    // is unbounded below, and its current tile is unbounded above, which is
    // the common case, not an edge one: a device with exactly one bind ever
    // is both at once. `new Date(Infinity)` is an Invalid Date and
    // `chDateTime` would throw formatting it, so an infinite bound omits its
    // half of the range clause entirely rather than being clamped to some
    // representable-but-arbitrary date — the same "no clause means no bound"
    // shape `windowStart` uses for the segment compiler's `ever` window
    // (@lyraflow/core's behaviour.ts).
    const params: Record<string, unknown> = { projectId: project.id, group }
    const clauses = windows.map((w, i) => {
      params[`d${i}`] = w.device
      const parts = [`anonymous_id = {d${i}:String}`]
      if (Number.isFinite(w.from)) {
        params[`f${i}`] = chDateTime(new Date(w.from))
        parts.push(`timestamp >= {f${i}:DateTime64(3)}`)
      }
      if (Number.isFinite(w.to)) {
        params[`t${i}`] = chDateTime(new Date(w.to))
        parts.push(`timestamp < {t${i}:DateTime64(3)}`)
      }
      return `(${parts.join(' AND ')})`
    })

    const deviceBranch =
      clauses.length > 0 ? ` OR (user_id = '' AND (${clauses.join(' OR ')}))` : ''

    // `project.id` is bound independently and is not optional: events rows
    // carry anonymous_id/user_id as plain text with no project qualifier
    // baked in, so a dropped project_id filter would let an identical id
    // from another project leak into this one's profile (see
    // person.test.ts's project-scoping test, which puts two projects in
    // genuine contention over the same id to catch exactly that).
    const rs = await ch.query({
      query: `
        SELECT
          min(timestamp) AS first_seen,
          max(timestamp) AS last_seen,
          count(DISTINCT event_id) AS events
        FROM events
        WHERE project_id = {projectId:UInt32}
          AND (user_id IN {group:Array(String)}${deviceBranch})
      `,
      query_params: params,
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
