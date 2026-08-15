import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { VERSION } from '@lyraflow/sdk-browser'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

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
 * package's main entry) because `dist/lyraflow.js` is not itself an
 * advertised entry point — it's the IIFE bundle `scripts/bundle.mjs`
 * produces from `src/index.ts`, not one of `exports`' listed subpaths.
 * sdk-browser's `exports` map (added for `SNIPPET_METHODS`'s own subpath,
 * IMPORTANT 4 from the whole-branch review) explicitly lists
 * `"./package.json"` for exactly this resolution — the same fix this
 * repo's own `@lyraflow/core` needed for the identical reason, so a bare
 * `exports` map here can't silently break this call the way it almost did
 * there.
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
 *   version, for as long as this server runs that version.
 * - `/lyraflow.js` expires quickly, so an upgrade actually reaches browsers
 *   that already cached the old bundle at the bare path.
 *
 * **The versioned path is cache-busting, not pinning, and must not be put in
 * a script tag.** It is only ever registered for the version this process is
 * running, so upgrading the server makes the previous one 404 — the promise
 * is "this URL's bytes never change", not "this version is served forever".
 * A site that pinned it would keep working from cache and then silently stop
 * collecting from every new visitor the moment the operator upgraded, which
 * is the failure this docstring and the README both used to invite by saying
 * "forever" without qualification.
 *
 * The versioned path is registered as a single literal route for the
 * current `VERSION`, not a `:version` parameter that serves the same bundle
 * for anything matching the pattern. That is deliberate: a request for a
 * version this process does not have must 404, not silently receive
 * whatever the current bundle happens to be — this is the only mechanism
 * that guarantees it, since Fastify 404s any path with no matching route.
 *
 * Both paths serve gzip to any client that accepts it — which is every
 * browser — from a copy compressed once at registration.
 *
 * The bundle is read once, here, at registration — it is a few kilobytes
 * and does not change while the process lives. If it is missing (the
 * sibling package was never built), the read fails, a warning is logged,
 * and both routes answer `503` for the life of the process rather than
 * stopping the server from starting: an optional static asset being absent
 * should not take the rest of the app down with it.
 */
/**
 * Whether this client wants gzip. Deliberately narrow: anything other than a
 * clear `gzip` acceptance gets the plain bundle, because serving an encoding
 * a client did not ask for is a broken script tag, and a broken script tag on
 * a customer's site is a worse failure than a few extra kilobytes.
 *
 * `gzip;q=0` is an explicit refusal and is honoured as one — it is the one
 * shape a bare substring test would get exactly backwards.
 */
function wantsGzip(req: FastifyRequest): boolean {
  const header = req.headers['accept-encoding']
  const value = Array.isArray(header) ? header.join(',') : (header ?? '')
  for (const part of value.split(',')) {
    const [coding, ...params] = part.trim().split(';')
    if (coding?.toLowerCase() !== 'gzip') continue
    const q = params.find((p) => p.trim().startsWith('q='))
    return q === undefined || Number(q.trim().slice(2)) > 0
  }
  return false
}

export function registerSdkRoutes(app: FastifyInstance): void {
  const bundle = loadBundle()

  if (!bundle) {
    app.log.warn(
      `@lyraflow/sdk-browser bundle not found (dist/lyraflow.js) — /lyraflow.js and /lyraflow-${VERSION}.js will answer 503 until the package is built`,
    )
  }

  // Compressed once, here, for the same reason the bundle itself is read
  // once: it is a few kilobytes and cannot change while the process lives.
  //
  // The route compresses rather than the README assuming a proxy in front of
  // it. The whole claim this endpoint exists to support is that a self-hosted
  // install needs no infrastructure outside itself — an install that ships
  // 12KB where 5KB would do, on every uncached page load, because the
  // operator did not know to add nginx, is that claim quietly not holding.
  // Compressing here is ~15 lines and no dependency; `@fastify/compress`
  // across every route would be neither, and this is the only static asset
  // the server has.
  const gzipped = bundle ? gzipSync(bundle, { level: 9 }) : undefined

  const serve = (cacheControl: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!bundle) return reply.code(503).send()
    reply.type(CONTENT_TYPE).header('cache-control', cacheControl)
    // Always announced, whichever branch runs: a cache that stored the
    // gzipped response must not hand it to a client that cannot read it.
    reply.header('vary', 'accept-encoding')
    if (gzipped && wantsGzip(req)) {
      return reply.header('content-encoding', 'gzip').send(gzipped)
    }
    return reply.send(bundle)
  }

  app.get('/lyraflow.js', serve(BARE_CACHE_CONTROL))
  app.get(`/lyraflow-${VERSION}.js`, serve(VERSIONED_CACHE_CONTROL))

  // A LEGIBLE 404 for any OTHER version, which is what a pinned script tag
  // meets the first time the operator upgrades.
  //
  // This does not soften the guarantee above — it cannot serve a bundle. It
  // only replaces Fastify's generic "Route not found" with a body naming the
  // version this server actually has and what to use instead, because the
  // alternative is an operator staring at a bare 404 for a URL that was
  // correct last week.
  //
  // Registered as a parametric route, which Fastify matches only AFTER the
  // static one above — so a request for the current version still reaches the
  // real handler and never this. A test pins that precedence, since getting it
  // backwards would turn the working path into a 404 for everyone.
  app.get<{ Params: { version: string } }>('/lyraflow-:version.js', async (_req, reply) =>
    reply
      .code(404)
      .header('cache-control', 'no-store')
      .send({
        error: 'sdk_version_not_served',
        // The version asked for is deliberately NOT echoed: it is caller-
        // controlled and would be reflected into a response body.
        served_version: VERSION,
        detail: `this server serves the browser SDK at /lyraflow-${VERSION}.js. The versioned path is cache-busting, not pinning — it stops being served when the server is upgraded. Use /lyraflow.js in a script tag.`,
      }),
  )
}
