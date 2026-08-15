import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

// A prefix no other suite uses, per the shared test harness.
const PREFIX = 'admin-routes'
const SLUG = `${PREFIX}-project`
const SERVER_KEY = `sk_${PREFIX}`
const EMAIL = `${PREFIX}-suite@example.test`
const PASSWORD = `${PREFIX}-suite-password`

let app: FastifyInstance
let cookie = ''

/** The cookie value only, from a Set-Cookie header -- same helper as auth/routes.test.ts. */
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

  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  await pg.query(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4)`,
    [SLUG, SLUG, `wk_${PREFIX}`, hashServerKey(SERVER_KEY)],
  )

  await pg.query('DELETE FROM admin_user')
  await ensureAdminUser(pg, { email: EMAIL, password: PASSWORD })

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

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-lyraflow-ui': '1' },
    payload: { email: EMAIL, password: PASSWORD },
  })
  const setCookie = login.headers['set-cookie']
  cookie = `lf_session=${cookieValue(Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? ''))}`
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
  await pg.query('DELETE FROM projects WHERE name = ANY($1)', [
    ['Admin Routes Created', 'Admin Routes Duplicate'],
  ])
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

describe('GET /v1/projects', () => {
  it('lists projects for a session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { projects: Array<Record<string, unknown>> }
    const mine = body.projects.find((p) => p.slug === SLUG)
    expect(mine).toBeDefined()
    expect(mine).toHaveProperty('id')
    expect(mine).toHaveProperty('name')
    expect(mine).toHaveProperty('created_at')
  })

  // The list is the one response that names every project at once. A key
  // leaking here leaks the whole install, not one project.
  it('never returns a key of either kind', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    const raw = res.body
    expect(raw).not.toContain('wk_')
    expect(raw).not.toContain('sk_')
    expect(raw).not.toContain('write_key')
    expect(raw).not.toContain('server_key')
  })

  // Beyond the brief's leak test: pins the EXACT set of fields returned per
  // project, not merely the absence of key-shaped strings. A field added
  // later that happens not to contain 'wk_'/'sk_' as a substring (e.g. a
  // nested `meta` object carrying `serverKeyHash`, which is hex and could
  // easily avoid both substrings) would still pass every assertion above.
  it('lists every field and no other, per project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    const body = res.json() as { projects: Array<Record<string, unknown>> }
    const mine = body.projects.find((p) => p.slug === SLUG)
    expect(mine).toBeDefined()
    expect(Object.keys(mine as Record<string, unknown>).sort()).toEqual(
      ['created_at', 'id', 'monthly_event_quota', 'name', 'retention_months', 'slug'].sort(),
    )
  })

  // Every project on a fresh install carries monthly_event_quota = NULL
  // (migration 011) -- unlimited. Number(null) is 0, and isOverQuota throws
  // on 0 rather than treating it as a limit, which would 503 every event of
  // that project. This project was inserted directly above with no quota
  // column, so it must list as `null`, not `0`.
  it('lists an unlimited project (the default) with monthly_event_quota: null, not 0', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    const body = res.json() as { projects: Array<Record<string, unknown>> }
    const mine = body.projects.find((p) => p.slug === SLUG)
    expect(mine?.monthly_event_quota).toBeNull()
  })

  it('refuses a server key: this route is session-only', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { 'x-lyraflow-server-key': SERVER_KEY, 'x-lyraflow-ui': '1' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses without a session', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { 'x-lyraflow-ui': '1' },
    })
    expect(res.statusCode).toBe(401)
  })

  // Distinct from the two tests above: this cookie IS present, in the
  // right shape (`lf_session=...`), but names no real session row --
  // every other test in this file authenticates with a session created
  // moments earlier, so nothing here would catch a `requireSession` that
  // checked only "is a cookie present" instead of actually calling
  // `sessions.verify()`.
  it('refuses a cookie that looks like a session but verifies to nothing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: 'lf_session=not-a-real-token', 'x-lyraflow-ui': '1' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses without the UI header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/projects', headers: { cookie } })
    expect(res.statusCode).toBe(403)
  })
})

describe('POST /v1/projects', () => {
  it('creates a project and returns both keys exactly once', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
      payload: { name: 'Admin Routes Created' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Record<string, string>
    expect(body.write_key).toMatch(/^wk_/)
    expect(body.server_key).toMatch(/^sk_/)
    expect(res.headers['cache-control']).toBe('no-store')

    // Never again, by construction: only the hash is stored.
    const again = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': body.server_key ?? '' },
    })
    expect(again.statusCode).toBe(200)
    expect(again.body).not.toContain(body.server_key)
  })

  it('refuses a duplicate name with 409, not a 503', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
      payload: { name: 'Admin Routes Duplicate' },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
      payload: { name: 'Admin Routes Duplicate' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'project_exists' })
  })

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['slug-empty', '!!!'],
  ])('refuses a name that yields no slug: %s', async (_n, name) => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
      payload: { name },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses a server key: this route is session-only', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { 'x-lyraflow-server-key': SERVER_KEY, 'x-lyraflow-ui': '1' },
      payload: { name: 'Admin Routes Should Not Be Created' },
    })
    expect(res.statusCode).toBe(401)
  })

  it('refuses without the UI header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie },
      payload: { name: 'Admin Routes Should Not Be Created Either' },
    })
    expect(res.statusCode).toBe(403)
  })
})

// MINOR A from the feat/admin-sessions whole-branch review: these two
// routes already gated correctly (the finding was about auth/routes.ts's
// session/logout and no gate at all), but they are the reference points
// the finding compares every other session-surface route against, so the
// suite pins them here too. A fresh app: Readiness.markDraining() has no
// way back, so this must not touch the file-level `app` every other test
// in this file depends on.
describe('the drain gate', () => {
  it('refuses GET /v1/projects with 503 draining', async () => {
    const config = loadConfig({
      LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
      LYRAFLOW_CLICKHOUSE_URL: CH.url,
      LYRAFLOW_CLICKHOUSE_USER: CH.username,
      LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
      LYRAFLOW_CLICKHOUSE_DB: CH.database,
    } as NodeJS.ProcessEnv)
    const readiness = new Readiness()
    readiness.markReady()
    const local = buildApp({ config, pg, ch, readiness })
    await local.ready()
    readiness.markDraining()
    const res = await local.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'draining' })
    await local.close()
  })

  it('refuses POST /v1/projects with 503 draining', async () => {
    const config = loadConfig({
      LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
      LYRAFLOW_CLICKHOUSE_URL: CH.url,
      LYRAFLOW_CLICKHOUSE_USER: CH.username,
      LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
      LYRAFLOW_CLICKHOUSE_DB: CH.database,
    } as NodeJS.ProcessEnv)
    const readiness = new Readiness()
    readiness.markReady()
    const local = buildApp({ config, pg, ch, readiness })
    await local.ready()
    readiness.markDraining()
    const res = await local.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
      payload: { name: 'Admin Routes Should Not Be Created While Draining' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'draining' })
    await local.close()
  })
})
