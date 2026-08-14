import { ProjectExistsError, createProject, slugify } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { SESSION_COOKIE, requireUiHeader } from '../auth/cookie.js'
import type { ProjectCache } from '../auth/project-cache.js'
import type { SessionStore } from '../auth/sessions.js'
import type { Readiness } from '../health.js'

export interface AdminProjectDeps {
  pg: Pool
  sessions: SessionStore
  projects: ProjectCache
  readiness: Readiness
}

const CreateBody = z.object({ name: z.string().min(1).max(200) })

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
    if (readiness.draining) {
      reply.code(503).header('retry-after', '5').send({ error: 'draining' })
      return false
    }
    if (!requireUiHeader(req, reply)) return false
    const token = req.cookies?.[SESSION_COOKIE]
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
    }>(
      `SELECT id, name, slug, created_at, retention_months, monthly_event_quota
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
      })),
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
    reply.header('cache-control', 'no-store')
    return reply.code(201).send({
      name: created.name,
      slug: created.slug,
      write_key: created.writeKey,
      server_key: created.serverKey,
    })
  })
}
