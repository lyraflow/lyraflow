import type { Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import type { Authenticate } from '../auth/bridge.js'

export interface ProjectDeps {
  authenticate: Authenticate
  pg: Pool
}

/**
 * The project's own identity, including the write key.
 *
 * The two keys are not peers. The WRITE key is public by construction: it
 * ships inside the browser bundle and is readable in devtools on any
 * instrumented page, and it authenticates ingest only. The SERVER key is a
 * secret: it authenticates every read path, is stored as a SHA-256 hash, and
 * is unrecoverable. A caller holding the server key can already read every
 * person, event and segment in the project, so handing it a value printed on
 * the customer's own website widens nothing.
 *
 * This route exists because the write key was otherwise unreadable after
 * project creation -- printed once by `create-project` and served by
 * nothing -- so a self-hoster who lost it had no recovery but raw SQL.
 *
 * NEVER serialise the cached `Project` here. It carries `serverKeyHash`,
 * which segment cursor signing uses as an HMAC key; project-cache.ts's
 * docstring records that nothing in this codebase puts it on the wire, and
 * this route is the first that serialises anything project-shaped. Build
 * the response field by field, as below, and source `name`/`write_key` from
 * a direct Postgres read -- the cache does not carry either.
 */
export function registerProjectRoutes(app: FastifyInstance, deps: ProjectDeps): void {
  const { authenticate, pg } = deps

  app.get('/v1/project', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    // Scoped by the authenticated project's id -- never by anything a caller
    // could put on the request -- so no query parameter can select another
    // project's row.
    const res = await pg.query<{ name: string; slug: string; write_key: string }>(
      'SELECT name, slug, write_key FROM projects WHERE id = $1',
      [project.id],
    )
    const row = res.rows[0]
    // This response varies entirely on the `x-lyraflow-server-key` header,
    // which the response carries no `Vary` for, and it is the first route in
    // this codebase whose 200 body is a credential (the write key). A shared
    // cache keying on URL alone -- ignoring the auth header -- could serve
    // one project's write key back out to a different caller. See
    // privacy/export.ts's identical `no-store` for the same reasoning
    // applied to a subject-access response.
    reply.header('cache-control', 'no-store')
    if (!row) return reply.code(404).send({ error: 'project_not_found' })

    return reply.code(200).send({
      name: row.name,
      slug: row.slug,
      write_key: row.write_key,
    })
  })
}
