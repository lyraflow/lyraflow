import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

// Slug prefix used by no other suite (schema/routes.test.ts uses
// 'schema-routes-test-*', privacy/routes.test.ts uses 'privacy-routes-*'),
// per this task's brief.
const SLUG_A = 'proj-route-a'
const SLUG_B = 'proj-route-b'
const PROJECT_NAME_A = 'ProjectRoutesA'
const PROJECT_NAME_B = 'ProjectRoutesB'
const WRITE_KEY_A = 'wk_proj_route_a'
const SERVER_KEY_A = 'sk_proj_route_a'
const WRITE_KEY_B = 'wk_proj_route_b'
const SERVER_KEY_B = 'sk_proj_route_b'

let app: FastifyInstance

async function makeProject(slug: string, name: string, writeKey: string, serverKey: string) {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, writeKey, hashServerKey(serverKey)],
  )
  return Number(r.rows[0]?.id)
}

async function cleanup(): Promise<void> {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
}

beforeAll(async () => {
  // Every live-database suite runs its own migrations: nothing orders the
  // suites, and a developer's database is always already migrated, so a
  // missing migration is invisible locally and fails only on a fresh CI
  // database.
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await cleanup()

  await makeProject(SLUG_A, PROJECT_NAME_A, WRITE_KEY_A, SERVER_KEY_A)
  await makeProject(SLUG_B, PROJECT_NAME_B, WRITE_KEY_B, SERVER_KEY_B)

  const config = loadConfig({
    LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
    LYRAFLOW_FLUSH_ROWS: '1',
  } as NodeJS.ProcessEnv)
  const readiness = new Readiness()
  readiness.markReady()
  app = buildApp({ config, pg, ch, readiness })
  await app.ready()
})

afterAll(async () => {
  await app.deps.buffer.flush()
  await app.close()
  await cleanup()
  await pg.end()
  await ch.close()
})

describe('GET /v1/project', () => {
  it('returns the project name, slug and write key for a valid server key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ name: PROJECT_NAME_A, slug: SLUG_A, write_key: WRITE_KEY_A })
  })

  it('never returns the server key hash, which signs segment cursors', async () => {
    // project-cache.ts's own docstring says nothing serialises a Project to a
    // response. This route is the first that serialises anything
    // project-shaped, and serverKeyHash is the HMAC key -- leaking it lets a
    // caller forge a segment cursor. Assert on the raw body, not the parsed
    // object: a nested or renamed field would still be a leak.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
    })
    expect(res.body).not.toContain(hashServerKey(SERVER_KEY_A))
    expect(Object.keys(res.json())).toEqual(['name', 'slug', 'write_key'])
  })

  it('rejects the write key, which must not reach a server-key route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': WRITE_KEY_A },
    })
    expect(res.statusCode).toBe(401)
  })

  it('rejects a missing key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/project' })
    expect(res.statusCode).toBe(401)
  })

  it('scopes to the authenticated key, never to a parameter', async () => {
    // Two projects exist; A's key must return A regardless of anything a
    // caller could put in the request.
    const res = await app.inject({
      method: 'GET',
      url: `/v1/project?slug=${SLUG_B}`,
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
    })
    expect(res.json().slug).toBe(SLUG_A)
  })

  // Beyond the brief's named leak test: the hash must not appear ANYWHERE in
  // the raw body, not merely absent from the parsed object's top-level keys
  // -- guards against a leak nested one level down (e.g. { name, slug,
  // write_key, meta: { serverKeyHash } }), which the "exact top-level keys"
  // assertion above cannot see since Object.keys only looks one level deep.
  it("never returns project B's data or hash when authenticated as A", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
    })
    expect(res.body).not.toContain(hashServerKey(SERVER_KEY_B))
    expect(res.body).not.toContain(SLUG_B)
    expect(res.body).not.toContain(PROJECT_NAME_B)
  })

  // Confirms the response is genuinely per-project, not a fixed/first-row
  // answer -- a route that (mistakenly) always queried project A's row would
  // otherwise pass every test above.
  it("returns B's own name, slug and write key for B's server key", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_B },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ name: PROJECT_NAME_B, slug: SLUG_B, write_key: WRITE_KEY_B })
  })
})
