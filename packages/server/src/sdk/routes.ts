import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { VERSION } from '@lyraflow/sdk-browser'
import type { FastifyInstance, FastifyReply } from 'fastify'

const CONTENT_TYPE = 'application/javascript; charset=utf-8'

// Short enough that an upgrade reaches already-cached browsers quickly, long
// enough that a page tracking several events in a row doesn't refetch the
// script on every navigation.
const BARE_CACHE_CONTROL = 'public, max-age=300'

// A year, `immutable`: the version is baked into the path, so the response
// for this exact URL can never change. Browsers that honour `immutable`
// skip revalidation entirely, not just the request — the whole point of
// giving upgrades their own path instead of overwriting this one in place.
const VERSIONED_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/**
 * Locates `@lyraflow/sdk-browser`'s built bundle without hard-coding a
 * relative path from this file to that package. `require.resolve` walks
 * node_modules the same way Node's own module loader would, so this holds
 * both for the workspace symlink pnpm creates in the repo
 * (`packages/server/node_modules/@lyraflow/sdk-browser -> ../../../sdk-browser`)
 * and for the copy `pnpm install` materialises in the Docker image — both
 * are ordinary resolvable packages as far as this call is concerned.
 * `package.json` is used as the resolution target (rather than, say, the
 * package's main entry) because sdk-browser declares no `exports` map, so
 * arbitrary subpaths — including its own manifest — resolve without needing
 * `dist/lyraflow.js` itself to be an advertised entry point.
 */
function loadBundle(): Buffer | undefined {
  try {
    const require = createRequire(import.meta.url)
    const manifestPath = require.resolve('@lyraflow/sdk-browser/package.json')
    const bundlePath = join(dirname(manifestPath), 'dist', 'lyraflow.js')
    return readFileSync(bundlePath)
  } catch {
    return undefined
  }
}

/**
 * Serves the browser SDK from the app itself — no CDN, so a self-hoster's
 * script tag never points anywhere but their own host. Unauthenticated,
 * like `/health`: a `<script>` tag cannot send a write key.
 *
 * Two paths, two cache policies:
 * - `/lyraflow-<version>.js` is immutable — the exact bundle for that
 *   version, forever.
 * - `/lyraflow.js` expires quickly, so an upgrade actually reaches browsers
 *   that already cached the old bundle at the bare path.
 *
 * The versioned path is registered as a single literal route for the
 * current `VERSION`, not a `:version` parameter that serves the same bundle
 * for anything matching the pattern. That is deliberate: a request for a
 * version this process does not have must 404, not silently receive
 * whatever the current bundle happens to be — this is the only mechanism
 * that guarantees it, since Fastify 404s any path with no matching route.
 *
 * The bundle is read once, here, at registration — it is a few kilobytes
 * and does not change while the process lives. If it is missing (the
 * sibling package was never built), the read fails, a warning is logged,
 * and both routes answer `503` for the life of the process rather than
 * stopping the server from starting: an optional static asset being absent
 * should not take the rest of the app down with it.
 */
export function registerSdkRoutes(app: FastifyInstance): void {
  const bundle = loadBundle()

  if (!bundle) {
    app.log.warn(
      `@lyraflow/sdk-browser bundle not found (dist/lyraflow.js) — /lyraflow.js and /lyraflow-${VERSION}.js will answer 503 until the package is built`,
    )
  }

  const serve = (cacheControl: string) => async (_req: unknown, reply: FastifyReply) => {
    if (!bundle) return reply.code(503).send()
    return reply.type(CONTENT_TYPE).header('cache-control', cacheControl).send(bundle)
  }

  app.get('/lyraflow.js', serve(BARE_CACHE_CONTROL))
  app.get(`/lyraflow-${VERSION}.js`, serve(VERSIONED_CACHE_CONTROL))
}
