import { existsSync } from 'node:fs'
import { join } from 'node:path'
import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { normalizePath } from './url-path.js'

/**
 * Bare prefixes (no trailing slash) that belong to the API and must never
 * receive the SPA fallback. Matched by `isApiPath` below against both the
 * bare path itself (`/v1`) and anything nested under it (`/v1/...`), so a
 * prefix is listed here exactly once rather than twice.
 */
const API_PREFIXES = ['/v1', '/health', '/ready', '/metrics', '/lyraflow']

/** True for the prefix itself, or anything nested under it. */
function isApiPath(url: string): boolean {
  const path = normalizePath(url)
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))
}

/**
 * True when the final path segment contains a dot — i.e. the request names
 * a file (`/assets/index-abc123.js`, `/favicon.svg`) rather than a
 * client-side route (`/feed`). Goes through the same `normalizePath` as
 * `isApiPath` — see that function's own docstring for why the two must
 * never normalize independently again.
 */
function looksLikeFile(url: string): boolean {
  const path = normalizePath(url)
  const lastSegment = path.slice(path.lastIndexOf('/') + 1)
  return lastSegment.includes('.')
}

/**
 * Serves the built SPA at `/`, with a fallback so client-side routes work on
 * a hard refresh.
 *
 * THE FALLBACK IS NARROW ON PURPOSE. It answers only GET, only for paths
 * that are not the API's, and only for paths that do not name a file.
 * Widening it in any of those three directions is a real defect rather than
 * a convenience — in every case the fallback would hand an HTML document to
 * a caller that asked for something else, and the failure that produces
 * points somewhere other than the cause:
 *
 * - Answering non-GET would turn every mistyped API POST into a 200 carrying
 *   a web page, which a scripted caller cannot act on.
 * - Answering /v1/* (or /v1 itself) would do the same to every unknown
 *   endpoint, and would also shadow app.ts's error handler, which
 *   deliberately maps an unknown /v1/* THROW to 503 + retry-after while
 *   leaving genuine 4xx alone.
 * - Answering a request for a file that doesn't exist — most importantly a
 *   hashed asset from a *previous* build, which is exactly what a browser
 *   holding a stale cached `index.html` requests right after an upgrade —
 *   would hand back a web page where a script or stylesheet was expected.
 *   The browser refuses to execute an HTML document as a JS module; the
 *   result is a MIME/parse error in the console instead of a clean 404 that
 *   a chunk-load handler could catch and turn into a reload prompt.
 *
 * The tradeoff of the file check: a future client-side route must not have
 * a dot in its final path segment, or it will 404 instead of falling
 * through to the SPA. That is a constraint worth having on its own —
 * such a route would be ambiguous to every proxy and CDN in front of this
 * server too, not just to this handler.
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
    if (req.method !== 'GET' || isApiPath(req.url) || looksLikeFile(req.url)) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return reply.sendFile('index.html')
  })
}
