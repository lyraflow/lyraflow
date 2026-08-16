import type { FastifyReply, FastifyRequest } from 'fastify'
import { type Readiness, refuseIfDraining } from '../health.js'
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
import { parseNumericId } from '../numeric-id.js'
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
 * Parses the `x-lyraflow-project` header -- the one place a malformed id
 * reaches EVERY project-scoped route. See `numeric-id.ts`'s `parseNumericId`
 * for the shape this enforces and why.
 *
 * Without it, a value that passes lands as a `ProjectCache.byId` bind
 * parameter against `projects.id bigserial`, Postgres raises
 * `22P02`/`22003`, and `#lookup` rethrows into app.ts's catch-all -- turning
 * a deterministic client error into a `503 {"error":"unavailable"}` with a
 * `retry-after` header and a level-50 log line, on every request.
 */
function parseProjectId(raw: string): number | null {
  return parseNumericId(raw)
}

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
    // during shutdown. MINOR A: shared with every other session-surface
    // route via refuseIfDraining, not a fourth copy of the same check.
    if (refuseIfDraining(readiness, reply)) return null

    if (req.headers[UI_HEADER] === undefined) {
      reply.code(403).send({ error: 'missing_ui_header' })
      return null
    }

    // IMPORTANT 2: relies on verify()'s default, which is non-renewing.
    // This authenticator has no way to resend the session cookie -- it is
    // shared by every project-scoped route, none of which have ever sent a
    // Set-Cookie header -- so a renewing read here would slide expires_at
    // forward in Postgres on every request for a session's last 7 days
    // while the browser's own cookie Expires never moves, an unkept
    // promise and a hidden write on what looks like a read. `GET
    // /v1/auth/session` is the one place that opts in with
    // `{ renew: true }`; see SessionStore.verify's own docstring for why
    // non-renewing is the default rather than something a caller has to
    // ask for.
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
    const id = parseProjectId(raw)
    if (id === null) {
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
