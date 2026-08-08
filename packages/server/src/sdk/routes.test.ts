import { VERSION } from '@lyraflow/sdk-browser'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerSdkRoutes } from './routes.js'

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
})
