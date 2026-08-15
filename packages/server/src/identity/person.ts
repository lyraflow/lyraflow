import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import type { Authenticate } from '../auth/bridge.js'
import { parseChDateTime } from '../ingest/row.js'
import type { SuppressionStore } from '../privacy/suppression-store.js'
import type { PersonAliases } from './aliases.js'
import type { IdentityBindings } from './bindings.js'
import { MAX_PERSON_RANGE_CLAUSES, personEventSummary, resolvePersonScope } from './scope.js'

// Re-exported so nothing importing it from person.ts (its home before the
// scope.ts extraction) breaks.
export { MAX_PERSON_RANGE_CLAUSES } from './scope.js'

export interface PersonDeps {
  authenticate: Authenticate
  ch: ClickHouseClient
  bindings: IdentityBindings
  aliases: PersonAliases
  suppression: SuppressionStore
}

interface PersonParams {
  id: string
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
 * scope.ts's `resolvePersonScope`. The query below it (first-seen/last-seen/
 * event count) is scope.ts's `personEventSummary`, shared with the deletion
 * route's existence check specifically so the two can never drift apart on
 * what counts as "this person has data" — see that function's own docstring
 * for why a structural guess at existence (identity-graph shape alone)
 * under-covers a real subject.
 *
 * Also honours a deletion boundary, resolved from Postgres for the same
 * zero-lag reason as the identity resolution above — see the comment on
 * `boundary` inside the handler for why Postgres and not the ClickHouse
 * suppression dictionary.
 */
export function registerPersonRoutes(app: FastifyInstance, deps: PersonDeps): void {
  const { authenticate, ch, bindings, aliases, suppression } = deps

  app.get<{ Params: PersonParams }>('/v1/persons/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
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
    //
    // Suppression, from Postgres rather than the ClickHouse dictionary — this
    // route bypasses the dictionaries for zero identity lag, and a 1-5s
    // dictionary LIFETIME would put that lag back on the one path where a
    // person reads their own data. Postgres also makes a just-requested
    // deletion take effect immediately, with no reload.
    const boundary = await suppression.boundaryFor(project.id, scope.group)
    const summary = await personEventSummary(ch, project.id, scope, {
      // `undefined` when there is no boundary, not `null` — personEventSummary
      // reads `opts.after` as "apply a boundary clause at all", and `after:
      // null` would still be a truthy `opts.after` key check away from that.
      after: boundary ?? undefined,
    })

    // Zero matching events: nothing under this project has ever heard of
    // this id, OR everything it ever did sits at or before its own deletion
    // boundary. 404, not a 200 with zeroed-out fields — an id with no events
    // anywhere is not a profile to render, and a 404 lets a caller tell
    // "no such person" apart from "a real person who happens to have zero
    // events" without inspecting the body. In practice the latter is not
    // reachable through this endpoint anyway: `scope.group` always includes
    // the canonical id itself even with no bindings or merges, so the only
    // way to land here with zero events is an id nothing has ever recorded,
    // one entirely erased by the boundary above, OR — since Plan 9 — one
    // whose every event has aged out under data retention (see README's
    // *Retention* section). That third cause 404s identically to the other
    // two even though `person_traits` and `identity_bindings` can still
    // hold real, undeleted data for that person: this query only counts
    // events, so a person past retention is indistinguishable here from one
    // who never existed. There is no way to tell the three apart from this
    // response alone.
    if (summary.events === 0) {
      return reply.code(404).send({ error: 'person_not_found' })
    }

    return reply.code(200).send({
      person_id: scope.canonical,
      ids: scope.ids,
      first_seen: parseChDateTime(summary.firstSeen).toISOString(),
      last_seen: parseChDateTime(summary.lastSeen).toISOString(),
      events: summary.events,
    })
  })
}
