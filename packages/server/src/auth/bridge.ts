import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Readiness } from '../health.js'
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
import { PROJECT_HEADER, SESSION_COOKIE, UI_HEADER } from './cookie.js'
import type { Project, ProjectCache } from './project-cache.js'
import type { SessionStore } from './sessions.js'

export interface BridgeDeps {
  readiness: Readiness
  projects: ProjectCache
  sessions: SessionStore
}

/**
 * The shared shape every project-scoped route authenticates through --
 * either `makeServerOrSessionAuthenticator`'s return value directly, or
 * (Task 9) whichever of the eight route modules is wired to it. Declared
 * once here and reused rather than restated at each call site, so the same
 * type checker that catches a route passing the wrong deps also catches two
 * call sites drifting to two different signatures for "authenticate".
 */
export type Authenticate = (req: FastifyRequest, reply: FastifyReply) => Promise<Project | null>

/**
 * Resolves EITHER a project server key OR an admin session to the same
 * `Project`, so that every project-scoped route serves the API and the
 * browser through one implementation. The alternative -- a second `/admin/*`
 * route group over the same stores -- is the second query path #32 exists to
 * prevent, and that divergence never arrives as a decision, only one
 * endpoint at a time.
 *
 * THE SERVER KEY IS TRIED FIRST AND WINS OUTRIGHT when both are present. A
 * scripted client that happens to carry a browser cookie (a shared curl
 * cookie jar, a proxy that injects one) must not have the project its call
 * acts on silently decided by that cookie.
 *
 * `makeAuthenticator` is CALLED, not modified. The write-key path
 * (`/v1/track` and its three siblings) is built from the same function, and
 * editing it in place to understand sessions would put every ingest request
 * one mistake away from accepting a browser cookie. The separation here is
 * structural; `ingest/routes.test.ts` pins it from the other side.
 *
 * The "no credentials at all" answer stays `missing_server_key`, exactly as
 * before. It is a published contract that existing API clients match on, and
 * a friendlier code would be a silent breaking change for zero benefit -- the
 * UI never reaches that branch, because it always sends a cookie.
 */
export function makeServerOrSessionAuthenticator(deps: BridgeDeps): Authenticate {
  const { readiness, projects, sessions } = deps
  const byServerKey = makeAuthenticator(
    readiness,
    SERVER_KEY_HEADER,
    (key) => projects.byServerKey(key),
    'missing_server_key',
    'invalid_server_key',
  )

  return async (req: FastifyRequest, reply: FastifyReply): Promise<Project | null> => {
    const serverKey = req.headers[SERVER_KEY_HEADER]
    const token = req.cookies?.[SESSION_COOKIE]

    // No cookie, or a server key present: this is the API path, byte for
    // byte what it was before this function existed -- including the drain
    // check, the two error codes, and their status.
    if (typeof serverKey === 'string' || !token) {
      return byServerKey(req, reply)
    }

    // The session path runs the drain check itself rather than inheriting
    // it: a session must not become a way past the gate that stops the API
    // during shutdown.
    if (readiness.draining) {
      reply.code(503).header('retry-after', '5').send({ error: 'draining' })
      return null
    }

    if (req.headers[UI_HEADER] === undefined) {
      reply.code(403).send({ error: 'missing_ui_header' })
      return null
    }

    const session = await sessions.verify(token)
    if (!session) {
      reply.code(401).send({ error: 'invalid_session' })
      return null
    }

    const raw = req.headers[PROJECT_HEADER]
    if (typeof raw !== 'string' || raw.length === 0) {
      reply.code(400).send({ error: 'missing_project' })
      return null
    }
    // Integer-only and strictly positive: `Number('1.5')` is 1.5 and
    // `Number('-1')` is -1, and both would reach Postgres as a bind
    // parameter rather than being refused here.
    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) {
      reply.code(400).send({ error: 'invalid_project' })
      return null
    }

    const project = await projects.byId(id)
    if (!project) {
      reply.code(404).send({ error: 'project_not_found' })
      return null
    }
    return project
  }
}
