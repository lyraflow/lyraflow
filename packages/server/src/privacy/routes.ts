import type { ClickHouseClient, Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import type { ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import type { PersonAliases } from '../identity/aliases.js'
import type { IdentityBindings } from '../identity/bindings.js'
import { resolvePersonScope } from '../identity/scope.js'
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
import type { DeletionStore } from './deletion-store.js'
import type { SuppressionStore } from './suppression-store.js'

export interface PrivacyDeps {
  projects: ProjectCache
  readiness: Readiness
  pg: Pool
  ch: ClickHouseClient
  bindings: IdentityBindings
  aliases: PersonAliases
  deletions: DeletionStore
  /** Task 7's export route shares this deps object and needs the boundary. */
  suppression: SuppressionStore
  /** For the status endpoint's "failed" verdict; same value the worker uses. */
  maxAttempts: number
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
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * DELETE /v1/persons/:id and GET /v1/deletions/:id — the public surface of
 * erasure. Server-key only, through the same makeAuthenticator/
 * SERVER_KEY_HEADER as every other route that reads or mutates a person's
 * data: the write key ships in browser JavaScript, and a deletion endpoint
 * reachable with it would be a public erase button.
 */
export function registerPrivacyRoutes(app: FastifyInstance, deps: PrivacyDeps): void {
  const { projects, readiness, ch, bindings, aliases, deletions, maxAttempts } = deps

  const authenticateServer = makeAuthenticator(
    readiness,
    SERVER_KEY_HEADER,
    (key) => projects.byServerKey(key),
    'missing_server_key',
    'invalid_server_key',
  )

  app.delete<{ Params: PersonParams }>('/v1/persons/:id', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return

    // The exact same resolution GET /v1/persons/:id uses, including its
    // device-id fallback (scope.ts's step 4) — deletion covers exactly the
    // subject that route describes. `group.length === 1 && devices.length
    // === 0` on the RETURNED scope is "nothing this project has ever
    // recorded for this id": no alias of its own, nothing merged into it,
    // no device bound to it directly, and the device-id fallback inside
    // resolvePersonScope also came up empty (had it found an owning
    // device, that owner's own resolveGroup would have populated `devices`
    // with at least that device). An id with no identity binding and no
    // events is not a subject, and pre-emptively suppressing it would write
    // rows nothing can ever purge.
    const scope = await resolvePersonScope({ bindings, aliases }, project.id, req.params.id)
    if (scope.group.length === 1 && scope.devices.length === 0) {
      return reply.code(404).send({ error: 'person_not_found' })
    }

    // The CANONICAL person, never the requested id — suppressing a
    // pre-alias id would leave the survivor's data visible, the same
    // defect class as an unresolved second stage in resolvedPersonExpr.
    const { id, suppressedAt } = await deletions.request(project.id, scope.canonical, new Date())

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

    return reply.code(202).send({
      request_id: id,
      person_id: scope.canonical,
      suppressed_at: suppressedAt.toISOString(),
    })
  })

  app.get<{ Params: DeletionParams }>('/v1/deletions/:id', async (req, reply) => {
    const project = await authenticateServer(req, reply)
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

    // Claimed, not completed, and under the attempt cap: a worker has this
    // request in hand right now. `DeletionRequest` carries no lease
    // duration (PrivacyDeps has no `leaseMs` — only `maxAttempts`, per this
    // route's own interface), so this cannot distinguish a claim genuinely
    // in flight from one abandoned by a crashed worker whose lease has
    // since expired but has not yet been reclaimed. That distinction does
    // not change what a caller should do either way ("keep polling"), and a
    // stale claim is transient: the next claim() call (worker-side, see
    // DeletionStore.claim) picks it back up and refreshes `claimed_at` the
    // moment its lease actually ages out.
    if (found.claimedAt) {
      return reply.code(200).send({
        status: 'in_progress',
        requested_at: found.requestedAt.toISOString(),
        completed_at: null,
      })
    }

    return reply.code(200).send({
      status: 'pending',
      requested_at: found.requestedAt.toISOString(),
      completed_at: null,
    })
  })
}
