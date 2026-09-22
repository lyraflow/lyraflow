import type { FastifyInstance } from 'fastify'

/**
 * The writes a read-only install still accepts, as Fastify route patterns.
 *
 * An allow-list, not a deny-list, and that is the whole design: a route
 * added later is refused until someone decides it belongs here, rather than
 * accepted until someone remembers to ban it. Every entry is one of three
 * kinds:
 *
 * - **Signing in and out.** Without these nobody reaches the read-only UI.
 * - **Ingest.** Read-only means the admin surface: ingest still accepts
 *   events, so a read-only install's live feed stays live.
 * - **Reads that travel as POST.** Previews and runs carry a definition or a
 *   range in a body too large or too structured for a query string. None of
 *   them change stored state on a read-only install -- the two that record a
 *   run snapshot skip it there (see funnels/routes.ts, segments/routes.ts).
 *
 * The match is on the route pattern Fastify resolved (`req.routeOptions.url`),
 * never the raw URL, so a query string cannot smuggle an allowed path in.
 * A param renamed in a route file (`:id` to `:funnelId`) makes its entry
 * stop matching and the read starts answering 403 -- loud, and pinned by the
 * test that checks every entry against the real app's routes.
 */
export const READ_ONLY_ALLOW: ReadonlyArray<{ method: string; url: string }> = [
  { method: 'POST', url: '/v1/auth/login' },
  { method: 'POST', url: '/v1/auth/logout' },
  { method: 'POST', url: '/v1/track' },
  { method: 'POST', url: '/v1/identify' },
  { method: 'POST', url: '/v1/page' },
  { method: 'POST', url: '/v1/batch' },
  { method: 'POST', url: '/v1/alias' },
  { method: 'POST', url: '/v1/segments/preview' },
  { method: 'POST', url: '/v1/segments/:id/preview' },
  { method: 'POST', url: '/v1/reports/retention' },
  { method: 'POST', url: '/v1/funnels/preview' },
  { method: 'POST', url: '/v1/funnels/:id/run' },
  { method: 'POST', url: '/v1/funnels/:id/dropoff' },
  { method: 'POST', url: '/v1/funnels/:id/people' },
  // A shared dashboard's tiles run through this. A link made before the
  // install went read-only keeps working; no new link can be made.
  { method: 'POST', url: '/v1/shared/:token/tiles/:index/run' },
]

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Refuses every write not in `READ_ONLY_ALLOW` with `403 read_only_install`.
 *
 * Call it on the root instance, before any route: a root-level hook applies
 * to every route and plugin registered after it, encapsulated ones included
 * (read-only.test.ts pins that). `onRequest` rather than `preHandler`, so a
 * refused write never has its body parsed. A URL no route matches has no
 * pattern and is refused unless the method is safe -- a 404 for a write on a
 * read-only install is not owed.
 */
export function registerReadOnlyGuard(app: FastifyInstance, enabled: boolean): void {
  if (!enabled) return
  const allowed = new Set(READ_ONLY_ALLOW.map((r) => `${r.method} ${r.url}`))
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE.has(req.method)) return
    if (allowed.has(`${req.method} ${req.routeOptions.url}`)) return
    return reply.code(403).send({ error: 'read_only_install' })
  })
}
