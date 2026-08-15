import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { Readiness } from './health.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

let app: FastifyInstance

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../db/migrations')),
    appSchemaVersion: 999,
  })
  const config = loadConfig({
    LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
  } as NodeJS.ProcessEnv)
  const readiness = new Readiness()
  readiness.markReady()
  app = buildApp({ config, pg, ch, readiness })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await pg.end()
  await ch.close()
})

describe('serving the SPA', () => {
  it('serves index.html at the root', async () => {
    const res = await app.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/html/)
    expect(res.body).toContain('<div id="root">')
  })

  it('serves index.html for a client-side route that is not a file', async () => {
    const res = await app.inject({ method: 'GET', url: '/feed' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('<div id="root">')
  })

  // The trap. An unknown API path is a client error with a JSON body, and
  // handing it index.html turns "you called the wrong endpoint" into "here
  // is a web page", which a scripted caller cannot act on at all.
  it('does NOT serve index.html for an unknown /v1 path', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/not-a-route' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('<div id="root">')
  })

  it.each([['/health'], ['/ready'], ['/metrics'], ['/lyraflow.js']])(
    'leaves %s alone',
    async (url) => {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(200)
      expect(res.body).not.toContain('<div id="root">')
    },
  )

  // A POST to an unknown path is not a page request; only GET gets the
  // fallback. Otherwise every mistyped API POST answers 200 with HTML.
  it('does not serve index.html for a POST to an unknown path', async () => {
    const res = await app.inject({ method: 'POST', url: '/whatever' })
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('<div id="root">')
  })

  it('still authenticates a real API route', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/project' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'missing_server_key' })
  })

  // Fix round 1, finding 1. A browser holding a cached index.html after an
  // upgrade requests the PREVIOUS build's hashed chunk filenames. Those no
  // longer exist on disk, and handing back index.html turns a clean 404 (a
  // chunk-load handler can catch this and prompt a reload) into a script
  // tag that fails to execute at all, with a MIME/parse error that points
  // nowhere near the real cause.
  it('does NOT serve index.html for a missing hashed asset', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-doesnotexist.js' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_found' })
  })

  // Fix round 1, finding 2. API_PREFIXES holds the bare prefix, and a plain
  // startsWith('/v1/') (note the trailing slash) never matches the bare
  // path -- a very plausible typo, or a health probe someone wrote by hand.
  it('does NOT serve index.html for the bare /v1 API root', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_found' })
  })

  // Fix round 1, finding 3. /lyraflow.js and /lyraflow-<version>.js are
  // both REAL registered routes (see sdk/routes.ts) -- a request for either
  // never reaches setNotFoundHandler at all, so the "leaves /lyraflow.js
  // alone" case above never exercises the '/lyraflow' entry in
  // API_PREFIXES. A bare /lyraflow (no such route exists) does.
  it('does NOT serve index.html for the bare /lyraflow path', async () => {
    const res = await app.inject({ method: 'GET', url: '/lyraflow' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'not_found' })
  })

  // Important 8 from the whole-branch review. Proved live against the
  // running dev stack before the fix: `/v1?x=1`, `//v1/events` and
  // `/v1%2Fnope` all answered 200 text/html instead of 404 JSON, because
  // `isApiPath` matched `req.url` (query string and all) while its sibling
  // `looksLikeFile` normalized independently -- a seam inside a 15-line
  // module. `//v1/events` is the one that matters most: a base URL ending
  // in `/` joined with a path beginning with `/` is a routine client bug,
  // and it used to produce a clean JSON 404 a caller's error handling could
  // act on, not a 200 whose body fails `JSON.parse`.
  it.each([['/v1?x=1'], ['//v1/events'], ['/v1%2Fnope']])(
    'does NOT serve index.html for %s',
    async (url) => {
      const res = await app.inject({ method: 'GET', url })
      expect(res.statusCode).toBe(404)
      expect(res.headers['content-type']).toMatch(/application\/json/)
      expect(res.json()).toEqual({ error: 'not_found' })
    },
  )

  // The fourth shape from the same finding, kept passing rather than
  // flipped: an ordinary API 404 must still read exactly as it always did.
  it('still serves a clean JSON 404 for an ordinary unknown API path', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.headers['content-type']).toMatch(/application\/json/)
    expect(res.json()).toEqual({ error: 'not_found' })
  })
})
