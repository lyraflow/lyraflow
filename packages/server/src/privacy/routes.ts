import type { ClickHouseClient, Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import type { Authenticate } from '../auth/bridge.js'
import type { PersonAliases } from '../identity/aliases.js'
import type { IdentityBindings } from '../identity/bindings.js'
import {
  MAX_PERSON_RANGE_CLAUSES,
  chunkWindows,
  personEventSummary,
  resolvePersonScope,
} from '../identity/scope.js'
import type { SegmentCache } from '../segments/cache.js'
import type { DeletionStore } from './deletion-store.js'
import type { SuppressionStore } from './suppression-store.js'

export interface PrivacyDeps {
  authenticate: Authenticate
  pg: Pool
  ch: ClickHouseClient
  bindings: IdentityBindings
  aliases: PersonAliases
  deletions: DeletionStore
  /** Task 7's export route shares this deps object and needs the boundary. */
  suppression: SuppressionStore
  /**
   * The SAME cache instance `registerSegmentRoutes` reads previews from
   * (app.ts shares one). DELETE clears this project's entries the moment a
   * deletion is accepted — see the call below — so a preview cached within
   * the last 30s cannot hand a suppressed person's row back out.
   */
  segmentCache: SegmentCache
  /** For the status endpoint's "failed" verdict; same value the worker uses. */
  maxAttempts: number
  /** For the status endpoint's "in_progress" vs "pending" verdict; same value the worker uses. */
  leaseMs: number
}

interface PersonParams {
  id: string
}

interface DeletionParams {
  id: string
}

/**
 * Parses the `:id` path param for the status route. A non-numeric or
 * non-positive id is a deterministic client error, not a lookup miss —
 * mirrors segments/routes.ts's `parseSegmentId` (kept as a private copy
 * rather than imported/exported, the same way that route file keeps its
 * own). Without this, `Number('not-a-number')` is `NaN`, which reaches
 * Postgres as a query parameter and trips app.ts's generic error handler
 * into a `503` for what is a deterministic client error.
 */
function parseDeletionId(raw: string): number | null {
  const id = Number(raw)
  // Bounded above by MAX_SAFE_INTEGER, not just "is an integer": a value
  // like 1e20 passes Number.isInteger (it is exactly representable as a
  // float) but is far outside Postgres's bigint range, and reaches
  // DeletionStore#get as a query parameter that Postgres itself rejects —
  // the exact "deterministic client error surfaces as a 503" outcome this
  // function exists to prevent for every other malformed shape.
  return Number.isInteger(id) && id > 0 && id <= Number.MAX_SAFE_INTEGER ? id : null
}

/**
 * DELETE /v1/persons/:id and GET /v1/deletions/:id — the public surface of
 * erasure. Gated on `authenticate` (a project server key or an admin
 * session — see auth/bridge.ts), the same as every other route that reads
 * or mutates a person's data: the write key ships in browser JavaScript,
 * and a deletion endpoint reachable with it would be a public erase button.
 */
export function registerPrivacyRoutes(app: FastifyInstance, deps: PrivacyDeps): void {
  const {
    authenticate,
    ch,
    bindings,
    aliases,
    deletions,
    suppression,
    segmentCache,
    maxAttempts,
    leaseMs,
  } = deps

  app.delete<{ Params: PersonParams }>('/v1/persons/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    // The exact same resolution GET /v1/persons/:id uses, including its
    // device-id fallback (scope.ts's step 4) — deletion covers exactly the
    // subject that route describes.
    const scope = await resolvePersonScope({ bindings, aliases }, project.id, req.params.id)

    // The existence check GET /v1/persons/:id itself runs — "does this
    // scope match any events" — via the SAME shared helper, not a
    // structural guess at the identity graph's shape (e.g. "has a device
    // binding"). A structural guess under-covers a real subject: a person
    // identified with only a `user_id` (no `anonymous_id`) gets no
    // `identity_bindings` row at all, so `group.length === 1 &&
    // devices.length === 0` would 404 them even though they have a real,
    // recorded event and GET finds it. See scope.ts's personEventSummary
    // for the full argument.
    //
    // Deliberately NOT boundary-filtered (no `after` passed): until the
    // purge worker actually deletes the rows, they are still sitting in
    // ClickHouse, and 404ing a person whose data is merely SUPPRESSED —
    // not yet erased — would misreport the one thing this endpoint exists
    // to guarantee. It also keeps a repeat request idempotent: an operator
    // re-requesting deletion after a purge exhausted its attempts, for a
    // person with no activity since their first request, must still get a
    // `202` and an advanced boundary, not a `404`. DO NOT "fix" this by
    // passing a boundary through for symmetry with GET — that is exactly
    // the change that breaks the operator-recovery path above, silently:
    // every test in this file still passes with a boundary applied, because
    // none of them re-request a deletion for a person with no NEW activity
    // since their first one. See routes.test.ts's
    // "still 202s a repeat deletion..." test, which exists specifically to
    // catch that regression.
    //
    // Chunked, not one unbounded call: GET caps at MAX_PERSON_RANGE_CLAUSES
    // and answers 400 past it, which is a fine answer for a profile view
    // and an unacceptable one for an erasure request — refusing to erase
    // the most fragmented people is itself the compliance failure. Each
    // chunk is independently bounded regardless of how fragmented the
    // person's device history is, and this stops at the first chunk that
    // matches ANY event: existence is a yes/no question, so paying for
    // every remaining chunk once the answer is already "yes" is wasted
    // work. chunkWindows always yields at least one chunk (even for zero
    // windows), which is what lets a person whose events all carry their
    // own user_id — no device window ever needed — be found by the very
    // first chunk's group-only predicate.
    let exists = false
    for (const [i, windows] of chunkWindows(scope.windows, MAX_PERSON_RANGE_CLAUSES).entries()) {
      const summary = await personEventSummary(
        ch,
        project.id,
        { group: scope.group, windows },
        { prefix: `c${i}_` },
      )
      if (summary.events > 0) {
        exists = true
        break
      }
    }
    if (!exists) {
      // No events — but that is not the same question as "nothing left to
      // erase". The purge deletes events FIRST and identity LAST (purge.ts,
      // and the order is load-bearing), so a purge that failed part-way
      // through leaves a person with zero events and their `person_traits`
      // and `identity_bindings` still in place. Once `attempts` reaches the
      // cap, `claim()` stops handing the request out (deletion-store.ts) and
      // this route is the operator's only way back in — answering `404` here
      // reads as "already gone" and strands a half-erased subject with no API
      // route to finish the job.
      //
      // So: an incomplete request for this canonical means the erasure was
      // accepted and never finished. Reset it and answer `202` with the
      // ORIGINAL request's id, rather than filing a second request for the
      // same person — the caller can keep polling the id they already have,
      // and the recorded `person_ids` ceiling stays exactly as it was at
      // request time (deliberately NOT re-widened to the current scope; see
      // 009_deletion_request_ids.sql).
      //
      // Resolution still works in this state precisely BECAUSE identity goes
      // last: `scope.canonical` is derived from `person_aliases`, which the
      // purge only touches in its final step. The one state this does not
      // reach is a purge whose every step succeeded but whose `complete()`
      // call then failed, re-requested under a MERGED-AWAY id: identity is
      // gone by then, so that id resolves to itself rather than to the
      // canonical and finds no request. Everything is genuinely erased in
      // that state, so `404` is the honest answer; re-requesting under the
      // canonical id still reopens it.
      const reopened = await deletions.reopen(project.id, scope.canonical)
      if (!reopened) {
        return reply.code(404).send({ error: 'person_not_found' })
      }
      // The boundary this person already carries, not a new one: their
      // suppression rows were written when the request was first accepted and
      // are never deleted (005_suppression.sql), so there is nothing to
      // advance and re-running the fan-out would only rewrite the same rows.
      // `requestedAt` is an unreachable fallback kept for total-ness rather
      // than sending `null` on a field the caller parses as a date.
      const boundary = await suppression.boundaryFor(project.id, [reopened.personId])
      return reply.code(202).send({
        request_id: reopened.id,
        person_id: reopened.personId,
        suppressed_at: (boundary ?? reopened.requestedAt).toISOString(),
      })
    }

    // The CANONICAL person, never the requested id, is what `deletion_requests`
    // names — suppressing a pre-alias id there would leave the survivor's
    // data visible, the same defect class as an unresolved second stage in
    // resolvedPersonExpr. But the SUPPRESSION rows fan out over `scope.ids`
    // (the canonical, every id merged into it, and every device): the purge
    // deletes the identity_bindings/person_aliases mappings resolvedPersonExpr
    // depends on, so once it has run a merged-away id or an anonymous device
    // event resolves to ITSELF, not the canonical — a suppression row keyed
    // on the canonical alone would stop protecting them from that point on
    // (e.g. a restored backup of the event store). See
    // DeletionStore.request's own docstring for the full argument.
    const { id, suppressedAt } = await deletions.request(
      project.id,
      scope.canonical,
      scope.ids,
      new Date(),
    )

    // Forces the segment-facing dictionary to pick up this deletion within
    // this request rather than within its own 1-5s LIFETIME. Wrapped in its
    // own try/catch: by the time this runs, both rows have already
    // committed — Postgres is the authority, and GET /v1/persons/:id
    // (which reads Postgres directly, not the dictionary) is already
    // correct. A failure here costs a few seconds of dictionary lag on
    // segment queries, nothing more; reporting a failure for a deletion
    // that in fact succeeded would tell the caller to retry something that
    // already happened.
    try {
      await ch.command({ query: 'SYSTEM RELOAD DICTIONARY suppressed_persons' })
    } catch (err) {
      app.log.error(
        { err, projectId: project.id, requestId: id },
        'suppression dictionary reload failed',
      )
    }

    // Same reasoning, same "must not fail an already-committed deletion"
    // shape, as the dictionary reload just above — but a DIFFERENT failure
    // mode if skipped: the dictionary is only ever stale for a few seconds
    // regardless, while `SegmentCache` entries live for its full 30s TTL
    // (segments/cache.ts), so a preview request landing in that window would
    // otherwise keep serving this person's row — their first_seen/last_seen
    // and context fields, not just a stale count — straight through the
    // `202` this response is about to send. `clearProject` is synchronous
    // and cannot itself throw today, but this is wrapped anyway: a future
    // change to that method must not be able to turn a successful deletion
    // into a failed request by accident.
    try {
      segmentCache.clearProject(project.id)
    } catch (err) {
      app.log.error(
        { err, projectId: project.id, requestId: id },
        'segment cache invalidation failed',
      )
    }

    return reply.code(202).send({
      request_id: id,
      person_id: scope.canonical,
      suppressed_at: suppressedAt.toISOString(),
    })
  })

  app.get<{ Params: DeletionParams }>('/v1/deletions/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const id = parseDeletionId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_deletion_id' })

    // Project-scoped in DeletionStore#get: another project's request is
    // indistinguishable from one that does not exist. A 403 would confirm
    // the id.
    const found = await deletions.get(project.id, id)
    if (!found) return reply.code(404).send({ error: 'deletion_not_found' })

    if (found.completedAt) {
      return reply.code(200).send({
        status: 'completed',
        requested_at: found.requestedAt.toISOString(),
        completed_at: found.completedAt.toISOString(),
      })
    }

    // A poisoned request the worker has given up on: attempts exhausted,
    // never completed. Not an API error — the request WAS accepted, and the
    // caller needs to know it did not finish. `last_error` carries why.
    if (found.attempts >= maxAttempts) {
      return reply.code(200).send({
        status: 'failed',
        requested_at: found.requestedAt.toISOString(),
        completed_at: null,
        error: found.lastError,
      })
    }

    // An attempt has failed and the request is not dead yet: report it as
    // waiting for its next attempt, WITH the error, ahead of the lease check
    // below.
    //
    // This branch has to come first because `fail()` deliberately leaves
    // `claimed_at` set (that is what makes the retry wait out the lease
    // instead of hammering a broken dependency), and the lease check reads
    // "claimed within the lease" as "a worker has this in hand right now".
    // Without this branch, a request failing every attempt reports
    // `in_progress` almost continuously for ~50 minutes on the shipped
    // defaults, never once reports `pending`, and never surfaces
    // `last_error` until the request is already dead — during exactly the
    // interval an operator is polling to find out what is wrong.
    //
    // `pending` and not `failed`: the request has attempts left and WILL be
    // retried, which is the whole difference between the two states. The
    // `failed` branch above stays the terminal one.
    if (found.lastError !== null) {
      return reply.code(200).send({
        status: 'pending',
        requested_at: found.requestedAt.toISOString(),
        completed_at: null,
        error: found.lastError,
      })
    }

    // Claimed, not completed, under the attempt cap, no error recorded, and
    // the lease has not yet aged out: a worker genuinely has this request in
    // hand right now.
    // `leaseMs` is the SAME value DeletionStore.claim() uses to decide
    // whether a claim is still live (see DeletionStore.claim) — without it,
    // "claimed" alone cannot tell a request truly in flight apart from one
    // abandoned by a crashed process, and reporting the latter as
    // `in_progress` forever is exactly the state an operator is trying to
    // diagnose when they poll this endpoint.
    if (found.claimedAt && Date.now() - found.claimedAt.getTime() < leaseMs) {
      return reply.code(200).send({
        status: 'in_progress',
        requested_at: found.requestedAt.toISOString(),
        completed_at: null,
      })
    }

    // Either never claimed, or claimed once and abandoned past its lease —
    // both are "waiting for a worker to pick this up", the same `pending`
    // a caller sees before the first claim. The next `claim()` call
    // (worker-side) refreshes `claimed_at` the moment it takes the row
    // again; nothing here needs to distinguish the two beyond that.
    return reply.code(200).send({
      status: 'pending',
      requested_at: found.requestedAt.toISOString(),
      completed_at: null,
    })
  })
}
