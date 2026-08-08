import { createRequire } from 'node:module'
import { gunzipSync } from 'node:zlib'
import { VERSION } from '@lyraflow/sdk-browser'
import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerSdkRoutes } from './routes.js'

// Toggled by the "missing bundle" test only. Defaults to passing every call
// through to the real node:fs, so the other tests in this file — which read
// the real, built dist/lyraflow.js — are unaffected. `vi.mock` calls are
// hoisted above imports by vitest, so this applies before `./routes.js`
// (and its own `readFileSync` import) is ever evaluated.
let failReadFileSync = false

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (failReadFileSync) {
        throw new Error('ENOENT (simulated): no such file or directory')
      }
      return actual.readFileSync(...args)
    },
  }
})

afterEach(() => {
  failReadFileSync = false
})

function app() {
  const f = Fastify()
  registerSdkRoutes(f)
  return f
}

describe('SDK routes', () => {
  it('serves the bundle as JavaScript', async () => {
    const res = await app().inject({ method: 'GET', url: '/lyraflow.js' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('javascript')
    expect(res.body.length).toBeGreaterThan(0)
  })

  it('needs no authentication', async () => {
    // It is a public asset, like /health. A script tag cannot send a key.
    const res = await app().inject({ method: 'GET', url: '/lyraflow.js' })
    expect(res.statusCode).toBe(200)
  })

  it('serves the versioned path immutably and the bare path briefly', async () => {
    const f = app()
    // The bare path must expire, or an upgrade never reaches the browsers that
    // already cached it.
    const versioned = await f.inject({ method: 'GET', url: `/lyraflow-${VERSION}.js` })
    expect(versioned.headers['cache-control']).toContain('immutable')
    const bare = await f.inject({ method: 'GET', url: '/lyraflow.js' })
    expect(bare.headers['cache-control']).not.toContain('immutable')
  })

  it('404s an unknown version rather than serving the current one', async () => {
    const res = await app().inject({ method: 'GET', url: '/lyraflow-9.9.9.js' })
    expect(res.statusCode).toBe(404)
  })

  it('serves the immutable path under the SDK package version an install ships', async () => {
    // The path is cached for a year with `immutable`, and it is built from a
    // hand-written constant in the SDK's source. This resolves the version
    // the same way the route resolves the bundle — through the installed
    // package, not through an import — so the URL browsers pin is tied to
    // the manifest that a release actually bumps.
    const require = createRequire(import.meta.url)
    const manifest = require('@lyraflow/sdk-browser/package.json') as { version: string }
    expect(VERSION).toBe(manifest.version)

    const res = await app().inject({ method: 'GET', url: `/lyraflow-${manifest.version}.js` })
    expect(res.statusCode).toBe(200)
  })

  it('serves the bundle gzipped to a browser, on both paths', async () => {
    // The README sells this route as the reason a self-hosted install needs
    // no infrastructure outside itself. Shipping it uncompressed meant every
    // uncached page load paid ~12KB for a bundle the branch polices at 5KB
    // gzipped, unless the operator knew to put a compressing proxy in front —
    // which is exactly the outside infrastructure the claim rules out.
    const f = app()
    for (const url of ['/lyraflow.js', `/lyraflow-${VERSION}.js`]) {
      const res = await f.inject({
        method: 'GET',
        url,
        headers: { 'accept-encoding': 'gzip, deflate, br' },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-encoding']).toBe('gzip')
      // Caches key on this, or a gzip body reaches a client that cannot read
      // it.
      expect(res.headers.vary).toContain('accept-encoding')

      const body = gunzipSync(res.rawPayload)
      expect(body.toString('utf8')).toContain('lyraflow')
      expect(res.rawPayload.byteLength).toBeLessThan(body.byteLength)
    }
  })

  it('serves the bundle uncompressed to a client that did not ask for gzip', async () => {
    // Including one that refuses it outright with `q=0` — the shape a bare
    // substring test for "gzip" gets exactly backwards, and an unreadable
    // script tag is a worse failure than a large one.
    const f = app()
    for (const accept of [undefined, 'identity', 'gzip;q=0', 'br']) {
      const res = await f.inject({
        method: 'GET',
        url: '/lyraflow.js',
        headers: accept === undefined ? {} : { 'accept-encoding': accept },
      })
      expect(res.statusCode).toBe(200)
      expect(res.headers['content-encoding'], `for accept-encoding: ${accept}`).toBeUndefined()
      expect(res.body).toContain('lyraflow')
    }
  })

  it('answers 503 and warns exactly once at registration when the bundle is missing', async () => {
    failReadFileSync = true
    const f = Fastify()
    const warn = vi.spyOn(f.log, 'warn')

    // The warning is the only signal an operator who never requests the
    // script gets that something is wrong — it must fire here, at
    // registration, not be deferred until (or repeated on) a request.
    registerSdkRoutes(f)
    expect(warn).toHaveBeenCalledTimes(1)

    const bare = await f.inject({ method: 'GET', url: '/lyraflow.js' })
    expect(bare.statusCode).toBe(503)
    const versioned = await f.inject({ method: 'GET', url: `/lyraflow-${VERSION}.js` })
    expect(versioned.statusCode).toBe(503)

    // Still exactly one: two requests against the missing bundle must not
    // have produced two more warnings.
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
