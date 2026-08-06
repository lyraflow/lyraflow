import type { FastifyInstance } from 'fastify'

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

export function registerHealth(app: FastifyInstance, readiness: Readiness): void {
  app.get('/health', async () => ({ status: 'ok' }))
  app.get('/ready', async (_req, reply) => {
    if (!readiness.ready) return reply.code(503).send({ status: 'not_ready' })
    return { status: 'ready' }
  })
}
