import { ProjectExistsError, createProject, slugify } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { SESSION_COOKIE, requireUiHeader } from '../auth/cookie.js'
import type { ProjectCache } from '../auth/project-cache.js'
import type { SessionStore } from '../auth/sessions.js'
import { type Readiness, refuseIfDraining } from '../health.js'

export interface AdminProjectDeps {
  pg: Pool
  sessions: SessionStore
  projects: ProjectCache
  readiness: Readiness
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

/**
 * The instance-scoped admin surface: which projects exist, and creating a
 * new one. Both are the project switcher's and the create-project flow's
 * backing routes for the coming web UI.
 */
export function registerAdminProjectRoutes(app: FastifyInstance, deps: AdminProjectDeps): void {
  const { pg, sessions, projects, readiness } = deps

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
    }>(
      `SELECT id, name, slug, created_at, retention_months, monthly_event_quota, disabled_at
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

    const id = Number(req.params.id)
    // `Number('12abc')` is NaN and `Number('')` is 0, so both the shape and
    // the range are checked -- a bare parse would send `NaN` to Postgres as
    // a bind parameter and fail as a 500 rather than a 400.
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid_id' })

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
      // `undefined` rather than "active".
      disabled_at: null,
      write_key: created.writeKey,
      server_key: created.serverKey,
    })
  })
}
