import type { FastifyInstance, FastifyReply } from 'fastify'

/**
 * Liveness and readiness are deliberately different signals. During a drain the
 * process is healthy — it is finishing work — but must not receive new traffic.
 */
export class Readiness {
  #ready = false
  #draining = false

  get ready(): boolean {
    return this.#ready && !this.#draining
  }

  get draining(): boolean {
    return this.#draining
  }

  markReady(): void {
    this.#ready = true
  }

  markDraining(): void {
    this.#draining = true
  }
}

/**
 * MINOR A from the feat/admin-sessions whole-branch review: the drain gate
 * used to be three separately-written copies (auth/routes.ts's login,
 * project/admin-routes.ts's requireSession, auth/bridge.ts's session path)
 * plus two session-surface routes with no gate at all -- GET
 * /v1/auth/session (which also performs SessionStore's renewal write, so
 * skipping the gate meant a drain-time request could still mutate the
 * sessions table) and POST /v1/auth/logout. Proved live: while draining,
 * those three answered 200/204/200 where GET /v1/projects and POST
 * /v1/auth/login correctly answered 503.
 *
 * One implementation, one response shape, shared by every session-surface
 * route -- so "does this route respect the drain gate" stops being a
 * per-route question. Returns `true` when it refused (the caller must
 * `return` immediately, sending nothing further); `false` when the caller
 * should proceed normally.
 */
export function refuseIfDraining(readiness: Readiness, reply: FastifyReply): boolean {
  if (!readiness.draining) return false
  reply.code(503).header('retry-after', '5').send({ error: 'draining' })
  return true
}

export function registerHealth(app: FastifyInstance, readiness: Readiness): void {
  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/ready', async (_req, reply) => {
    if (!readiness.ready) return reply.code(503).send({ status: 'not_ready' })
    return { status: 'ready' }
  })
}
