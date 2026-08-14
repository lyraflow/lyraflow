import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { ensureAdminUser } from './bootstrap.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const EMAIL = 'auth-routes-suite@example.test'
const PASSWORD = 'auth-routes-suite-password'

let app: FastifyInstance

function build(): FastifyInstance {
  const config = loadConfig({
    LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
  } as NodeJS.ProcessEnv)
  const readiness = new Readiness()
  readiness.markReady()
  return buildApp({ config, pg, ch, readiness })
}

/** The cookie value only, from a Set-Cookie header. */
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
  app = build()
  await app.ready()
})

beforeEach(async () => {
  await pg.query('DELETE FROM admin_user')
  await ensureAdminUser(pg, { email: EMAIL, password: PASSWORD })
  // One `app` (and so one AttemptLimiter) is shared across every test in
  // this file, and `app.inject` always reports the requester as
  // 127.0.0.1. The rate-limit tests below deliberately drive that IP's
  // count to the cap; without clearing it here, every later test's login
  // -- including a correct one -- would see `limiter.check` fail before
  // credentials are ever read, indistinguishable from a routing bug.
  // `app.deps.loginLimiter` is the exact shared instance (see app.ts).
  app.deps.loginLimiter.reset([
    'ip:127.0.0.1',
    `email:${EMAIL.toLowerCase()}`,
    'email:nobody@example.test',
  ])
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

async function login(password = PASSWORD) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-lyraflow-ui': '1' },
    payload: { email: EMAIL, password },
  })
}

describe('GET /v1/auth/state', () => {
  it('reports configured when an admin exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/state' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ configured: true })
  })

  it('reports unconfigured when none does', async () => {
    await pg.query('DELETE FROM admin_user')
    const res = await app.inject({ method: 'GET', url: '/v1/auth/state' })
    expect(res.json()).toEqual({ configured: false })
  })
})

describe('POST /v1/auth/login', () => {
  it('sets an HttpOnly, SameSite=Lax, Path=/ cookie on success', async () => {
    const res = await login()
    expect(res.statusCode).toBe(200)
    const setCookie = res.headers['set-cookie']
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')
    expect(header).toMatch(/^lf_session=/)
    expect(header).toMatch(/HttpOnly/i)
    expect(header).toMatch(/SameSite=Lax/i)
    expect(header).toMatch(/Path=\//i)
  })

  // The default install in the README is plain HTTP on localhost. An
  // unconditional Secure flag makes the browser discard this cookie and
  // login fails with no error anywhere -- the single worst failure mode
  // available here, because it looks like a wrong password.
  it('omits Secure over plain HTTP', async () => {
    const res = await login()
    const setCookie = res.headers['set-cookie']
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')
    expect(header).not.toMatch(/Secure/i)
  })

  it('sets Secure when the request arrived over HTTPS via the proxy', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-lyraflow-ui': '1', 'x-forwarded-proto': 'https' },
      payload: { email: EMAIL, password: PASSWORD },
    })
    const setCookie = res.headers['set-cookie']
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')
    expect(header).toMatch(/Secure/i)
  })

  // The installer writes LYRAFLOW_ADMIN_EMAIL verbatim, and an operator's
  // browser autofill or manual typing is not guaranteed to match its case.
  // The lookup must fold case so a mismatch here isn't indistinguishable
  // from a wrong password.
  it('logs in when the submitted email differs in case from what is stored', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-lyraflow-ui': '1' },
      payload: { email: EMAIL.toUpperCase(), password: PASSWORD },
    })
    expect(res.statusCode).toBe(200)
    const setCookie = res.headers['set-cookie']
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')
    expect(header).toMatch(/^lf_session=/)
  })

  it('refuses a wrong password with no cookie', async () => {
    const res = await login('wrong-password')
    expect(res.statusCode).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  // A different body for "no such email" than for "wrong password" turns
  // this endpoint into an account-enumeration oracle.
  it('answers an unknown email identically to a wrong password', async () => {
    const wrongPassword = await login('wrong-password')
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-lyraflow-ui': '1' },
      payload: { email: 'nobody@example.test', password: PASSWORD },
    })
    expect(unknownEmail.statusCode).toBe(wrongPassword.statusCode)
    expect(unknownEmail.json()).toEqual(wrongPassword.json())
  })

  it('refuses without the UI header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: EMAIL, password: PASSWORD },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'missing_ui_header' })
  })

  it('rate-limits repeated failures and stops answering', async () => {
    for (let i = 0; i < 10; i++) await login('wrong-password')
    const res = await login('wrong-password')
    expect(res.statusCode).toBe(429)
  })

  it('does not count a success against the limit', async () => {
    for (let i = 0; i < 5; i++) await login('wrong-password')
    expect((await login()).statusCode).toBe(200)
    for (let i = 0; i < 5; i++) await login('wrong-password')
    expect((await login()).statusCode).toBe(200)
  })
})

describe('GET /v1/auth/session and POST /v1/auth/logout', () => {
  it('reads the session back, then stops after logout', async () => {
    const res = await login()
    const cookie = `lf_session=${cookieValue(
      Array.isArray(res.headers['set-cookie'])
        ? (res.headers['set-cookie'][0] ?? '')
        : (res.headers['set-cookie'] ?? ''),
    )}`

    const me = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toEqual({ email: EMAIL })

    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    expect(out.statusCode).toBe(204)

    const after = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    expect(after.statusCode).toBe(401)
  })

  it('refuses with no cookie at all', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { 'x-lyraflow-ui': '1' },
    })
    expect(res.statusCode).toBe(401)
  })

  // Nothing else pins clearSessionCookie's attributes against
  // setSessionCookie's. A clear whose HttpOnly/SameSite/Path/Secure don't
  // match the original cookie's can leave the original in place in some
  // browsers -- logout would 204 while the browser keeps sending the old
  // session.
  it("logout's Set-Cookie carries the same HttpOnly/SameSite/Path as login, and omits Secure over plain HTTP", async () => {
    const res = await login()
    const cookie = `lf_session=${cookieValue(
      Array.isArray(res.headers['set-cookie'])
        ? (res.headers['set-cookie'][0] ?? '')
        : (res.headers['set-cookie'] ?? ''),
    )}`

    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    const setCookie = out.headers['set-cookie']
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')
    expect(header).toMatch(/^lf_session=/)
    expect(header).toMatch(/HttpOnly/i)
    expect(header).toMatch(/SameSite=Lax/i)
    expect(header).toMatch(/Path=\//i)
    expect(header).not.toMatch(/Secure/i)
  })

  it("logout's Set-Cookie carries Secure when the request arrived over HTTPS via the proxy", async () => {
    const res = await login()
    const cookie = `lf_session=${cookieValue(
      Array.isArray(res.headers['set-cookie'])
        ? (res.headers['set-cookie'][0] ?? '')
        : (res.headers['set-cookie'] ?? ''),
    )}`

    const out = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie, 'x-lyraflow-ui': '1', 'x-forwarded-proto': 'https' },
    })
    const setCookie = out.headers['set-cookie']
    const header = Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? '')
    expect(header).toMatch(/Secure/i)
  })
})
