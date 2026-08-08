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
