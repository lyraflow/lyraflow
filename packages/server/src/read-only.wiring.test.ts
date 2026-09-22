import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { Readiness } from './health.js'
import { READ_ONLY_ALLOW } from './read-only.js'

/**
 * read-only.test.ts proves the guard on a bare Fastify. This file proves it
 * is wired into the real `buildApp`, and that every allow-list pattern names
 * a route the real app registers -- the check that a param spelled `:id` in
 * the list and `:funnelId` in a route file would fail, rather than turning a
 * read into a 403 nobody notices until a visitor does.
 */
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
    LYRAFLOW_READ_ONLY: 'true',
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

describe('buildApp with LYRAFLOW_READ_ONLY=true', () => {
  it('refuses POST /v1/funnels', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/funnels', payload: { name: 'x' } })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'read_only_install' })
  })

  // Reaches the login handler, which answers for itself: a wrong password
  // is its own 401, not the guard's 403.
  it('lets POST /v1/auth/login through to its handler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-lyraflow-ui': '1' },
      payload: { email: 'nobody@example.test', password: 'not-the-password' },
    })
    expect(res.statusCode).not.toBe(403)
    expect(res.json()).not.toEqual({ error: 'read_only_install' })
  })

  it.each(READ_ONLY_ALLOW)('registers a route for $method $url', ({ method, url }) => {
    expect(app.hasRoute({ method, url })).toBe(true)
  })

  // hasRoute proves the pattern exists; this proves the real app resolves a
  // concrete request to it. The ingest routes are the case that needs both:
  // each is registered as `''` under its own plugin prefix.
  it.each(READ_ONLY_ALLOW)('lets $method $url reach its handler', async ({ method, url }) => {
    const res = await app.inject({
      // Every entry is a POST today; inject's method type is narrower than
      // Fastify's, which is all this cast bridges.
      method: method as 'POST',
      url: url.replace(/:[A-Za-z]+/g, '7'),
      payload: {},
    })
    expect(res.json()).not.toEqual({ error: 'read_only_install' })
  })
})
