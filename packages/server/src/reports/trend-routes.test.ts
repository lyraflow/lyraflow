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

const WRITE_KEY = 'wk_trend_routes'
const SERVER_KEY = 'sk_trend_routes'
const OTHER_SERVER_KEY = 'sk_trend_routes_other'

const EMAIL = 'trend-routes-suite@example.test'
const PASSWORD = 'trend-routes-suite-password'

let app: FastifyInstance
let projectId: number
let otherProjectId: number

const trend = { event: 'signup', interval: '1d' as const, group_by: null as string | null }

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
  for (const slug of ['trend-routes', 'trend-routes-other']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  const mine = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Trend Routes', 'trend-routes', $1, $2) RETURNING id`,
    [WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(mine.rows[0]?.id)
  const other = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Trend Routes Other', 'trend-routes-other', $1, $2) RETURNING id`,
    ['wk_trend_routes_other', hashServerKey(OTHER_SERVER_KEY)],
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
  await pg.query('DELETE FROM trend_reports WHERE project_id = ANY($1)', [
    [projectId, otherProjectId],
  ])
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [
    ['trend-routes', 'trend-routes-other'],
  ])
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

describe('trend routes', () => {
  it('requires a server key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/trends' })
    expect(res.statusCode).toBe(401)
  })

  it('creates, lists, reads, patches and deletes', async () => {
    const created = await call('POST', '/v1/trends', { name: 'Signups by day', ...trend })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      name: 'Signups by day',
      event: 'signup',
      interval: '1d',
    })
    const id = created.json().id

    expect((await call('GET', '/v1/trends')).json().trends).toHaveLength(1)
    expect((await call('GET', `/v1/trends/${id}`)).json().name).toBe('Signups by day')

    const patched = await call('PATCH', `/v1/trends/${id}`, { name: 'Signups by day v2' })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().name).toBe('Signups by day v2')
    // Unpatched fields survive the PATCH.
    expect(patched.json().event).toBe('signup')

    expect((await call('DELETE', `/v1/trends/${id}`)).statusCode).toBe(204)
    expect((await call('GET', `/v1/trends/${id}`)).statusCode).toBe(404)
  })

  it('answers 409 on a duplicate name', async () => {
    await call('POST', '/v1/trends', { name: 'Signups', ...trend })
    const dup = await call('POST', '/v1/trends', { name: 'Signups', ...trend })
    expect(dup.statusCode).toBe(409)
  })

  it('answers 400 invalid_trend_id on a malformed id', async () => {
    const res = await call('GET', '/v1/trends/abc')
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_trend_id')
  })

  it("answers 404 trend_not_found for another project's id", async () => {
    const created = await call('POST', '/v1/trends', { name: 'Signups', ...trend })
    const id = created.json().id
    // A 403 would confirm the id exists.
    const res = await call('GET', `/v1/trends/${id}`, undefined, OTHER_SERVER_KEY)
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('trend_not_found')
  })

  // M1 from the whole-branch review: every cross-tenant test on this branch
  // was a GET. The scope in `TrendStore.update`'s own `WHERE project_id =
  // $1 AND id = $2` is what this pins -- a mutation that drops
  // `project_id` from that one statement makes this the only test that
  // fails.
  it("answers 404 trend_not_found on a PATCH to another project's id", async () => {
    const created = await call('POST', '/v1/trends', { name: 'Signups', ...trend })
    const id = created.json().id
    const res = await call('PATCH', `/v1/trends/${id}`, { name: 'Stolen' }, OTHER_SERVER_KEY)
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('trend_not_found')
    // The row itself is untouched -- the PATCH never reached it.
    expect((await call('GET', `/v1/trends/${id}`)).json().name).toBe('Signups')
  })

  // M1's DELETE half -- pins `TrendStore.remove`'s own `WHERE project_id =
  // $1 AND id = $2` the same way the PATCH test above pins `update`'s.
  it("answers 404 trend_not_found on a DELETE to another project's id", async () => {
    const created = await call('POST', '/v1/trends', { name: 'Signups', ...trend })
    const id = created.json().id
    const res = await call('DELETE', `/v1/trends/${id}`, undefined, OTHER_SERVER_KEY)
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('trend_not_found')
    // Still there -- the DELETE never reached it.
    expect((await call('GET', `/v1/trends/${id}`)).statusCode).toBe(200)
  })

  // M3 from the whole-branch review: the store's own test for this
  // (`trend-store.test.ts`) covers `DuplicateTrendNameError`, but nothing
  // exercised the ROUTE's 409 mapping on a rename -- only on create.
  it('answers 409 on a PATCH that renames into a taken name', async () => {
    await call('POST', '/v1/trends', { name: 'One', ...trend })
    const two = await call('POST', '/v1/trends', { name: 'Two', ...trend })
    const res = await call('PATCH', `/v1/trends/${two.json().id}`, { name: 'One' })
    expect(res.statusCode).toBe(409)
  })

  it('reaches the routes with a session as well as a server key', async () => {
    // Both surfaces go through makeServerOrSessionAuthenticator, like funnels.
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
      url: '/v1/trends',
      headers: { cookie, 'x-lyraflow-ui': '1', 'x-lyraflow-project': String(projectId) },
    })
    expect(res.statusCode).toBe(200)
  })
})

describe('/v1/trends where predicates', () => {
  const filtered = {
    event: '$page',
    interval: '1d' as const,
    group_by: null,
    where: [{ property: 'path', operator: '=', value: '/register' }],
  }

  it('creates and returns a filtered trend', async () => {
    const res = await call('POST', '/v1/trends', { ...filtered, name: 'registers' })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    expect(body.where).toEqual(filtered.where)
    expect(body.definition_version).toBe(1)
    expect(body.stale).toBe(false)
  })

  it('defaults an omitted where to no predicates', async () => {
    // Absent and `[]` mean one thing on CREATE -- there is no stored value to
    // leave alone yet -- so both are folded before the store sees them, the
    // same way `group_by` already folds absent into `null`.
    const res = await call('POST', '/v1/trends', { ...trend, name: 'unfiltered' })
    expect(res.statusCode).toBe(201)
    expect(res.json().where).toEqual([])
  })

  it('refuses a predicate the grammar does not accept', async () => {
    const res = await call('POST', '/v1/trends', {
      ...trend,
      name: 'bad',
      where: [{ property: 'path', operator: 'matches', value: 'x' }],
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses eleven predicates', async () => {
    const res = await call('POST', '/v1/trends', {
      ...trend,
      name: 'too-many',
      where: Array.from({ length: 11 }, () => ({ property: 'p', operator: '=', value: 'x' })),
    })
    expect(res.statusCode).toBe(400)
  })

  it('clears the filter on PATCH with an empty list', async () => {
    const made = await call('POST', '/v1/trends', { ...filtered, name: 'clearable' })
    const id = made.json().id
    const res = await call('PATCH', `/v1/trends/${id}`, { where: [] })
    expect(res.statusCode).toBe(200)
    expect(res.json().where).toEqual([])
  })

  it('leaves the filter alone on a PATCH that omits it', async () => {
    const made = await call('POST', '/v1/trends', { ...filtered, name: 'renameable' })
    const id = made.json().id
    const res = await call('PATCH', `/v1/trends/${id}`, { name: 'renamed-filtered' })
    expect(res.json().where).toEqual(filtered.where)
  })

  it('carries stale on the list, on every row', async () => {
    // `GET /v1/trends` answers `{ trends: [...] }` -- see the handler.
    const list = await call('GET', '/v1/trends')
    for (const row of list.json().trends) {
      expect(row).toHaveProperty('stale')
      expect(row).toHaveProperty('where')
    }
  })
})
