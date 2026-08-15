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
})
