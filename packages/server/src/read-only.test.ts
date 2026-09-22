import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { READ_ONLY_ALLOW, registerReadOnlyGuard } from './read-only.js'

/**
 * The allow-list as this file expects it, written out rather than read from
 * `READ_ONLY_ALLOW`. Iterating the exported constant would make each row
 * vanish along with the entry it tests, so removing an entry from the guard
 * would fail nothing. Written here, removing one fails exactly its own row.
 */
const EXPECTED_ALLOW = [
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
  { method: 'POST', url: '/v1/shared/:token/tiles/:index/run' },
] as const

/** A concrete URL for a route pattern: every `:param` becomes `7`. */
const concrete = (pattern: string) => pattern.replace(/:[A-Za-z]+/g, '7')

let app: FastifyInstance | undefined

afterEach(async () => {
  await app?.close()
  app = undefined
})

/**
 * The guard FIRST, then every route -- the order `buildApp` uses. The routes
 * a write would reach are all registered after the hook, which is the
 * property the guard depends on: it names only what it lets through, never
 * what it refuses.
 */
async function build(enabled: boolean): Promise<FastifyInstance> {
  const a = Fastify()
  registerReadOnlyGuard(a, enabled)
  const ok = async () => ({ ok: true })
  for (const { method, url } of EXPECTED_ALLOW) a.route({ method, url, handler: ok })
  a.post('/v1/funnels', ok)
  a.get('/v1/funnels', ok)
  // Registered inside an encapsulated plugin, after the guard and never named
  // by it -- the shape of a route somebody adds next year. A root-level
  // onRequest hook reaching into a child context is what this proves.
  a.register(async (child) => {
    child.delete('/v1/new-thing', ok)
    child.put('/v1/new-thing', ok)
    child.patch('/v1/new-thing', ok)
    child.post('/v1/new-thing', ok)
  })
  await a.ready()
  app = a
  return a
}

describe('registerReadOnlyGuard, enabled', () => {
  it('refuses a write with 403 read_only_install', async () => {
    const a = await build(true)
    const res = await a.inject({ method: 'POST', url: '/v1/funnels', payload: { name: 'x' } })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'read_only_install' })
  })

  it.each(EXPECTED_ALLOW)('allows $method $url', async ({ method, url }) => {
    const a = await build(true)
    const res = await a.inject({ method, url: concrete(url), payload: {} })
    expect(res.statusCode).toBe(200)
  })

  it('has no allow-list entry this file does not expect', () => {
    const extra = READ_ONLY_ALLOW.filter(
      (e) => !EXPECTED_ALLOW.some((x) => x.method === e.method && x.url === e.url),
    )
    expect(extra).toEqual([])
  })

  it.each(['GET', 'HEAD', 'OPTIONS'] as const)('allows %s', async (method) => {
    const a = await build(true)
    // OPTIONS has no route here, so it reaches the 404 handler -- the point
    // is that the guard let it through rather than answering 403 itself.
    const res = await a.inject({ method, url: '/v1/funnels' })
    expect(res.statusCode).not.toBe(403)
  })

  // The allow decision reads Fastify's matched route pattern, never the raw
  // URL, so an allowed path smuggled into a query string buys nothing and an
  // allowed route with a query string still matches.
  it('matches an allowed route even with a query string naming another path', async () => {
    const a = await build(true)
    const res = await a.inject({ method: 'POST', url: '/v1/funnels/7/run?x=/v1/auth/login' })
    expect(res.statusCode).toBe(200)
  })

  it('refuses a write whose query string names an allowed path', async () => {
    const a = await build(true)
    const res = await a.inject({ method: 'POST', url: '/v1/funnels?next=/v1/auth/login' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'read_only_install' })
  })

  it('refuses a route registered after the guard that the guard never names', async () => {
    const a = await build(true)
    const res = await a.inject({ method: 'DELETE', url: '/v1/new-thing' })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'read_only_install' })
  })

  // One row per write method, on the same unlisted route. PATCH is every
  // edit in the product; a SAFE set that grew to include it must fail here.
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)('refuses %s', async (method) => {
    const a = await build(true)
    const res = await a.inject({ method, url: '/v1/new-thing', payload: {} })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'read_only_install' })
  })

  // No route matches, so there is no pattern to allow. A 404 for a write on
  // a read-only install is not owed; the refusal is the same either way.
  it('refuses a write to a URL no route matches', async () => {
    const a = await build(true)
    const res = await a.inject({ method: 'POST', url: '/v1/nowhere' })
    expect(res.statusCode).toBe(403)
  })

  // onRequest runs before the body is parsed. A malformed body on a refused
  // write answers the refusal, not a 400 from the JSON parser -- proof the
  // body of a refused request is never read.
  it('refuses before the body is parsed', async () => {
    const a = await build(true)
    const res = await a.inject({
      method: 'POST',
      url: '/v1/funnels',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'read_only_install' })
  })
})

describe('registerReadOnlyGuard, disabled', () => {
  it.each([
    ['POST', '/v1/funnels'],
    ['DELETE', '/v1/new-thing'],
  ] as const)('refuses nothing: %s %s', async (method, url) => {
    const a = await build(false)
    const res = await a.inject({ method, url, payload: {} })
    expect(res.statusCode).toBe(200)
  })
})
