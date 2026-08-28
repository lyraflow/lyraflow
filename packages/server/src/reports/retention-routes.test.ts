import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { ensureAdminUser } from '../auth/bootstrap.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const WRITE_KEY = 'wk_retention_routes'
const SERVER_KEY = 'sk_retention_routes'
const OTHER_SERVER_KEY = 'sk_retention_routes_other'

const EMAIL = 'retention-routes-suite@example.test'
const PASSWORD = 'retention-routes-suite-password'

let app: FastifyInstance
let projectId: number
let otherProjectId: number

const report = {
  start_event: 'signup',
  return_event: 'login',
  granularity: 'week' as const,
  periods: 8,
}

const call = (
  method: 'POST' | 'GET' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
  key = SERVER_KEY,
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      'x-lyraflow-server-key': key,
    },
    payload: payload as never,
  })

/** The cookie value only, from a Set-Cookie header -- same helper as auth/wiring.test.ts. */
function cookieValue(setCookie: string): string {
  return (setCookie.split(';')[0] ?? '').split('=')[1] ?? ''
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  for (const slug of ['retention-routes', 'retention-routes-other']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  const mine = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Retention Routes', 'retention-routes', $1, $2) RETURNING id`,
    [WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(mine.rows[0]?.id)
  const other = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Retention Routes Other', 'retention-routes-other', $1, $2) RETURNING id`,
    ['wk_retention_routes_other', hashServerKey(OTHER_SERVER_KEY)],
  )
  otherProjectId = Number(other.rows[0]?.id)

  // Single-tenant, same as auth/wiring.test.ts -- cleared in both
  // beforeAll and afterAll rather than assumed empty.
  await pg.query('DELETE FROM admin_user')
  await ensureAdminUser(pg, { email: EMAIL, password: PASSWORD })

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

beforeEach(async () => {
  await pg.query('DELETE FROM retention_reports WHERE project_id = ANY($1)', [
    [projectId, otherProjectId],
  ])
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [
    ['retention-routes', 'retention-routes-other'],
  ])
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

describe('retention report routes', () => {
  it('requires a server key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/retention-reports' })
    expect(res.statusCode).toBe(401)
  })

  it('creates, lists, reads, patches and deletes', async () => {
    const created = await call('POST', '/v1/retention-reports', {
      name: 'Signup to login',
      ...report,
      start_where: [{ property: 'plan', operator: '=', value: 'pro' }],
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      name: 'Signup to login',
      start_event: 'signup',
      return_event: 'login',
      granularity: 'week',
      periods: 8,
      start_where: [{ property: 'plan', operator: '=', value: 'pro' }],
      return_where: [],
      segment_id: null,
      stale: false,
    })
    const id = created.json().id

    expect((await call('GET', '/v1/retention-reports')).json().reports).toHaveLength(1)
    expect((await call('GET', `/v1/retention-reports/${id}`)).json().name).toBe('Signup to login')

    const patched = await call('PATCH', `/v1/retention-reports/${id}`, { name: 'v2' })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().name).toBe('v2')
    // Unpatched fields survive the PATCH.
    expect(patched.json().start_event).toBe('signup')

    expect((await call('DELETE', `/v1/retention-reports/${id}`)).statusCode).toBe(204)
    expect((await call('GET', `/v1/retention-reports/${id}`)).statusCode).toBe(404)
  })

  it('answers 409 on a duplicate name', async () => {
    await call('POST', '/v1/retention-reports', { name: 'Signups', ...report })
    const dup = await call('POST', '/v1/retention-reports', { name: 'Signups', ...report })
    expect(dup.statusCode).toBe(409)
  })

  it('answers 400 on a malformed where predicate rather than a 500', async () => {
    const res = await call('POST', '/v1/retention-reports', {
      name: 'Bad predicate',
      ...report,
      start_where: [{ nonsense: true }],
    })
    expect(res.statusCode).toBe(400)
  })

  it('answers 400 invalid_retention_report_id on a malformed id', async () => {
    const res = await call('GET', '/v1/retention-reports/abc')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_retention_report_id')
  })

  it("answers 404 retention_report_not_found for another project's id", async () => {
    const created = await call('POST', '/v1/retention-reports', { name: 'Signups', ...report })
    const id = created.json().id
    // A 403 would confirm the id exists.
    const res = await call('GET', `/v1/retention-reports/${id}`, undefined, OTHER_SERVER_KEY)
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('retention_report_not_found')
  })

  it('reaches the routes with a session as well as a server key', async () => {
    // Both surfaces go through makeServerOrSessionAuthenticator, like trends.
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-lyraflow-ui': '1' },
      payload: { email: EMAIL, password: PASSWORD },
    })
    const setCookie = login.headers['set-cookie']
    const cookie = `lf_session=${cookieValue(Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? ''))}`

    const res = await app.inject({
      method: 'GET',
      url: '/v1/retention-reports',
      headers: { cookie, 'x-lyraflow-ui': '1', 'x-lyraflow-project': String(projectId) },
    })
    expect(res.statusCode).toBe(200)
  })
})
