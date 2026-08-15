import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'

/** Prefixes that belong to the API and must never receive the SPA fallback. */
const API_PREFIXES = ['/v1/', '/health', '/ready', '/metrics', '/lyraflow']

/**
 * Serves the built SPA at `/`, with a fallback so client-side routes work on
 * a hard refresh.
 *
 * THE FALLBACK IS NARROW ON PURPOSE. It answers only GET, and only for paths
 * that are not the API's. Widening it in either direction is a real defect
 * rather than a convenience:
 *
 * - Answering non-GET would turn every mistyped API POST into a 200 carrying
 *   a web page, which a scripted caller cannot act on.
 * - Answering /v1/* would do the same to every unknown endpoint, and would
 *   also shadow app.ts's error handler, which deliberately maps an unknown
 *   /v1/* THROW to 503 + retry-after while leaving genuine 4xx alone.
 *
 * `root` is absent in development and in most tests, where the UI has never
 * been built. That is not an error: the API must run without a frontend, so
 * this registers nothing and every path behaves exactly as it did before.
 */
export function registerStatic(app: FastifyInstance, opts: { root: string }): void {
  if (!existsSync(join(opts.root, 'index.html'))) {
    app.log.info({ root: opts.root }, 'no built UI found; serving API only')
    return
  }

  app.register(fastifyStatic, { root: opts.root, wildcard: false })

  app.setNotFoundHandler((req, reply) => {
    const isApi = API_PREFIXES.some((p) => req.url.startsWith(p))
    if (req.method !== 'GET' || isApi) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return reply.sendFile('index.html')
  })
}
