import { ProjectExistsError, createProject, slugify } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { SESSION_COOKIE, requireUiHeader } from '../auth/cookie.js'
import type { ProjectCache } from '../auth/project-cache.js'
import type { SessionStore } from '../auth/sessions.js'
import { type Readiness, refuseIfDraining } from '../health.js'
import { SERVER_VERSION } from '../version.js'
import type { ProjectDeletionStore } from './deletion-store.js'

export interface AdminProjectDeps {
  pg: Pool
  sessions: SessionStore
  projects: ProjectCache
  readiness: Readiness
  /** The SAME instance app.ts built for ProjectPurgeWorker — see its own comment. */
  deletions: ProjectDeletionStore
  /** The SAME configured value ProjectPurgeWorker claims under — see GET /v1/project-deletions/:id. */
  maxAttempts: number
  /** The SAME configured value ProjectPurgeWorker's claim() uses — see GET /v1/project-deletions/:id. */
  leaseMs: number
  /**
   * Drops every cached segment preview for a project, at the moment its data
   * stops being what a cached preview says it is. The SAME `SegmentCache`
   * `DELETE /v1/persons/:id` and the retention sweep clear through — a
   * lookalike built here would leave the entries those two can see
   * untouched. See the DELETE route below for the window it closes.
   */
  clearSegmentCache: (projectId: number) => void
}

const CreateBody = z.object({ name: z.string().min(1).max(200) })

/**
 * Both fields are optional INDEPENDENTLY: absent means "leave alone", which
 * is how a rename happens without touching the archive state and vice versa
 * -- the same contract `PATCH /v1/project` uses for retention and quota.
 * A body with neither is a no-op rather than an error; it changes nothing
 * and the response still tells the caller what the row is.
 */
const UpdateBody = z.object({
  name: z.string().min(1).max(200).optional(),
  archived: z.boolean().optional(),
})

const DeleteBody = z.object({ slug: z.string().min(1) })

/**
 * `Number('12abc')` is NaN and `Number('')` is 0, so both the shape and the
 * range are checked -- a bare parse would send `NaN` to Postgres as a bind
 * parameter and fail as a 500 rather than a 400. Extracted once a third
 * route needed the identical check (PATCH, DELETE, GET
 * /v1/project-deletions/:id) -- `privacy/routes.ts`'s `parseDeletionId` is
 * the same idea; kept local here since every call site in this file answers
 * the same `invalid_id` body, unlike that one.
 */
function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * The instance-scoped admin surface: which projects exist, and creating a
 * new one. Both are the project switcher's and the create-project flow's
 * backing routes for the coming web UI.
 */
export function registerAdminProjectRoutes(app: FastifyInstance, deps: AdminProjectDeps): void {
  const { pg, sessions, projects, readiness, deletions, maxAttempts, leaseMs, clearSegmentCache } =
    deps

  /**
   * Session-only, and deliberately NOT routed through auth/bridge.ts. These
   * two routes are instance-scoped -- "which projects exist" has no project
   * to resolve -- so the bridge's `x-lyraflow-project` requirement would be
   * nonsense here, and accepting a server key would let one project's
   * credential enumerate every other project on the install.
   */
  async function requireSession(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    // MINOR A: shared with every other session-surface route via
    // refuseIfDraining, not a third copy of the same check.
    if (refuseIfDraining(readiness, reply)) return false
    if (!requireUiHeader(req, reply)) return false
    const token = req.cookies?.[SESSION_COOKIE]
    // Non-renewing by default (see SessionStore.verify's own docstring):
    // this is the same "verify a session cookie" call the bridge makes,
    // and neither route can re-send a cookie, so it must not opt in to the
    // renewing form either. GET /v1/projects is the one place a project
    // switcher hits routinely, which is exactly why this one mattered as
    // much as the bridge's copy did.
    if (!token || !(await sessions.verify(token))) {
      reply.code(401).send({ error: 'invalid_session' })
      return false
    }
    return true
  }

  /**
   * What release this install is running. Read by the Settings screen's
   * Install card, where an operator decides whether to upgrade and finds the
   * number to quote into a bug report.
   *
   * Session-gated, not on `/health`, and that is the whole point: a version
   * number tells a caller which published advisories apply to the install,
   * and `/health` answers anything that can reach the port. It is
   * instance-scoped for the same reason `/v1/projects` is -- "what version is
   * this" names no project, so a server key cannot answer it.
   *
   * `/v1/meta` rather than `/v1/version` because the path is the expensive
   * half to change later and the body is not. One field today; if the card
   * ever wants the schema version or a build date beside it, they arrive here
   * without a second route or a breaking rename. Adding one is a decision
   * about what an install discloses about itself, and the test pinning this
   * key set exactly is what makes it one.
   */
  app.get('/v1/meta', async (req, reply) => {
    if (!(await requireSession(req, reply))) return
    return { version: SERVER_VERSION }
  })

  app.get('/v1/projects', async (req, reply) => {
    if (!(await requireSession(req, reply))) return

    // Field by field, and NO KEY OF EITHER KIND. This is the only response
    // in the product that names every project at once, so a key leaking
    // here leaks the whole install rather than one project. The write key
    // is available per-project from GET /v1/project, which is scoped to a
    // caller who already holds that project's credential.
    const res = await pg.query<{
      id: string
      name: string
      slug: string
      created_at: Date
      retention_months: number
      monthly_event_quota: string | null
      disabled_at: Date | null
      deleting_at: Date | null
    }>(
      `SELECT id, name, slug, created_at, retention_months, monthly_event_quota, disabled_at, deleting_at
       FROM projects ORDER BY created_at ASC, id ASC`,
    )
    reply.header('cache-control', 'no-store')
    return reply.code(200).send({
      projects: res.rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        slug: r.slug,
        created_at: r.created_at.toISOString(),
        retention_months: r.retention_months,
        // null means unlimited and must survive as null -- Number(null) is
        // 0, which isOverQuota refuses to evaluate at all.
        monthly_event_quota: r.monthly_event_quota === null ? null : Number(r.monthly_event_quota),
        disabled_at: r.disabled_at === null ? null : r.disabled_at.toISOString(),
        // A project mid-deletion is still listed -- the settings screen
        // shows progress against this rather than the row disappearing
        // mid-teardown.
        deleting_at: r.deleting_at === null ? null : r.deleting_at.toISOString(),
      })),
    })
  })

  /**
   * Rename a project, archive it, or restore it.
   *
   * **A rename never touches the slug.** The slug is what a project is
   * addressed by outside this API -- `lyraflow seed-demo demo-data`, and
   * anything an operator has scripted around it -- so deriving a new slug
   * from a new name would break stored commands silently, at the moment
   * somebody fixed a typo in a display name. Nothing else about a name is
   * unique, so a rename cannot collide and this route has no 409.
   *
   * **Archiving is not deleting.** It stops ingest and nothing else: every
   * read keeps working, retention keeps sweeping (archived data still ages,
   * and skipping it would turn an archive into unbounded storage growth),
   * and restoring is one more call. Deleting a project would have to clean
   * ClickHouse as well as Postgres -- three partition drops and two
   * asynchronous mutations, in an order that cannot orphan data -- which is
   * what #39 and #60 park on and is not this route.
   */
  app.patch<{ Params: { id: string } }>('/v1/projects/:id', async (req, reply) => {
    if (!(await requireSession(req, reply))) return

    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_id' })

    const body = UpdateBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' })

    const name = body.data.name?.trim()
    if (name !== undefined && name.length === 0) {
      return reply.code(400).send({ error: 'invalid_name' })
    }

    // One statement, so a name and an archive state given together cannot
    // half-apply. COALESCE leaves `name` alone when none was sent; the
    // archive expression distinguishes all three cases -- true stamps now,
    // false clears, absent keeps whatever is there.
    const res = await pg.query<{
      id: string
      name: string
      slug: string
      created_at: Date
      retention_months: number
      monthly_event_quota: string | null
      disabled_at: Date | null
    }>(
      `UPDATE projects
          SET name = COALESCE($2, name),
              disabled_at = CASE
                WHEN $3::boolean IS NULL THEN disabled_at
                WHEN $3::boolean THEN COALESCE(disabled_at, now())
                ELSE NULL
              END
        WHERE id = $1
    RETURNING id, name, slug, created_at, retention_months, monthly_event_quota, disabled_at`,
      [id, name ?? null, body.data.archived ?? null],
    )

    const row = res.rows[0]
    if (!row) return reply.code(404).send({ error: 'project_not_found' })

    // MUST come after the write and MUST happen even for a rename. The
    // write-key authenticator reads `disabledAt` off this cache, so an
    // archive that skipped this keeps admitting events until the TTL lapses
    // -- and the cache is keyed by id and by both keys, so there is no
    // cheaper eviction than the whole thing. `PATCH /v1/project` invalidates
    // for exactly the same reason.
    projects.invalidate()

    reply.header('cache-control', 'no-store')
    return reply.code(200).send({
      id: Number(row.id),
      name: row.name,
      slug: row.slug,
      created_at: row.created_at.toISOString(),
      retention_months: row.retention_months,
      monthly_event_quota:
        row.monthly_event_quota === null ? null : Number(row.monthly_event_quota),
      disabled_at: row.disabled_at === null ? null : row.disabled_at.toISOString(),
    })
  })

  app.post('/v1/projects', async (req, reply) => {
    if (!(await requireSession(req, reply))) return

    const body = CreateBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' })
    const name = body.data.name.trim()
    // slugify strips everything but [a-z0-9-], so a name of only punctuation
    // yields '' -- which would insert a row with an empty slug and make the
    // NEXT such name a unique violation instead of a validation error.
    if (name.length === 0 || slugify(name).length === 0) {
      return reply.code(400).send({ error: 'invalid_name' })
    }

    let created: Awaited<ReturnType<typeof createProject>>
    try {
      created = await createProject(pg, name)
    } catch (err) {
      if (err instanceof ProjectExistsError) {
        return reply.code(409).send({ error: 'project_exists' })
      }
      throw err
    }

    // The new project's keys are not in the cache and its id is not either;
    // nothing stale exists to evict. This invalidation is for the negative
    // entry a caller may have created by probing the id or key first.
    projects.invalidate()

    // The server key appears here and nowhere else, ever: only its SHA-256
    // is stored. `no-store` for the same reason GET /v1/project carries it
    // -- this 200 body is a credential.
    //
    // Every other field GET /v1/projects lists for a project is included
    // too (#89): the UI adds the new row to its in-memory list from this
    // response alone, without a second GET /v1/projects whose result could
    // race a concurrent PATCH and clobber it. Converted the same way that
    // route's own row mapping does -- id/monthly_event_quota come back from
    // Postgres as strings.
    reply.header('cache-control', 'no-store')
    return reply.code(201).send({
      id: Number(created.id),
      name: created.name,
      slug: created.slug,
      created_at: created.createdAt.toISOString(),
      retention_months: created.retentionMonths,
      monthly_event_quota:
        created.monthlyEventQuota === null ? null : Number(created.monthlyEventQuota),
      // Always null for a project that was created a millisecond ago, and
      // present anyway so this response is the same shape GET /v1/projects
      // returns -- the UI appends this row to that list (#89) and a missing
      // field would make the new row the only one whose archive state is
      // `undefined` rather than "active". `deleting_at` for the same reason:
      // a missing field here would make this the one project in the UI's
      // list whose deletion state reads `undefined` instead of a real value.
      disabled_at: null,
      deleting_at: null,
      write_key: created.writeKey,
      server_key: created.serverKey,
    })
  })

  /**
   * Destroy a project and everything it holds, in both stores.
   *
   * **The slug in the body is the confirmation.** Not a header, not a query
   * parameter: the caller has to name the thing they are destroying, and a
   * mismatch is a 409 rather than a 400 because the request is well-formed and
   * the *state* is what refuses it.
   *
   * **202, not 200.** The teardown is minutes of partition drops and
   * asynchronous mutations; a route that waited would hit every proxy timeout
   * between here and the operator. `GET /v1/project-deletions/:id` reports how
   * it went.
   *
   * **There is no cancel.** `deleting_at` is stamped here and never cleared --
   * see migration 019.
   */
  app.delete<{ Params: { id: string } }>('/v1/projects/:id', async (req, reply) => {
    if (!(await requireSession(req, reply))) return

    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_id' })

    const body = DeleteBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' })

    const found = await pg.query<{ slug: string }>('SELECT slug FROM projects WHERE id = $1', [id])
    const row = found.rows[0]
    if (!row) return reply.code(404).send({ error: 'project_not_found' })
    if (row.slug !== body.data.slug) return reply.code(409).send({ error: 'slug_mismatch' })

    const result = await deletions.request(id)
    if (result === 'not_found') return reply.code(404).send({ error: 'project_not_found' })
    if ('alreadyDeleting' in result) {
      return reply.code(409).send({ error: 'already_deleting', id: result.alreadyDeleting })
    }

    // MUST come after the write, for the reason PATCH documents: the write-key
    // authenticator reads `deletingAt` off this cache, so skipping it keeps
    // admitting events into partitions this request is about to drop.
    //
    // It closes the window for THIS PROCESS ONLY, which is worth being exact
    // about: another app process's cache is untouched by it, and the CLI can
    // reach no cache at all. What actually bounds those is the claim delay
    // (`purgeClaimDelayMs`, config.ts) — no purge may start until the whole
    // cache horizon has passed. This call makes the refusal immediate here
    // rather than eventual; it does not make it universal.
    projects.invalidate()

    // The third path that changes what a segment preview could return, and
    // the reason `app.ts`'s retention comment asks for this call. A preview
    // hit within `SegmentCache`'s 30s TTL would otherwise keep serving this
    // project's member rows — person ids, traits, first/last seen — out of a
    // snapshot taken before the project was destroyed. Wrapped for the same
    // reason `DELETE /v1/persons/:id` wraps its own call: the deletion is
    // already committed, and a future change to `clearProject` must not be
    // able to turn an accepted request into a 500.
    try {
      clearSegmentCache(id)
    } catch (err) {
      req.log.error({ err, projectId: id }, 'segment cache invalidation failed')
    }

    reply.header('cache-control', 'no-store')
    return reply.code(202).send({ id: result.id, project_id: id, status: 'pending' })
  })

  /**
   * Instance-scoped, not project-scoped like `GET /v1/deletions/:id` -- by the
   * time this answers `completed` there is no project row left to scope by.
   */
  app.get<{ Params: { id: string } }>('/v1/project-deletions/:id', async (req, reply) => {
    if (!(await requireSession(req, reply))) return

    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_id' })

    const found = await deletions.get(id)
    if (!found) return reply.code(404).send({ error: 'deletion_not_found' })

    reply.header('cache-control', 'no-store')
    const requested_at = found.requestedAt.toISOString()
    if (found.completedAt) {
      return reply
        .code(200)
        .send({ status: 'completed', requested_at, completed_at: found.completedAt.toISOString() })
    }
    // Terminal: attempts exhausted, never completed. The request WAS accepted
    // and did not finish; `last_error` carries why.
    if (found.attempts >= maxAttempts) {
      return reply
        .code(200)
        .send({ status: 'failed', requested_at, completed_at: null, error: found.lastError })
    }
    // An attempt failed and the request is not dead yet -- reported as pending
    // WITH its error, ahead of the lease check, for the reason
    // `GET /v1/deletions/:id` documents: `fail()` leaves `claimed_at` set, so a
    // request failing every attempt would otherwise report `in_progress`
    // continuously and never surface `last_error` until it was already dead.
    if (found.lastError !== null) {
      return reply
        .code(200)
        .send({ status: 'pending', requested_at, completed_at: null, error: found.lastError })
    }
    const leased = found.claimedAt !== null && Date.now() - found.claimedAt.getTime() < leaseMs
    return reply.code(200).send({
      status: leased ? 'in_progress' : 'pending',
      requested_at,
      completed_at: null,
      error: null,
    })
  })
}
