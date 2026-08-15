import { join } from 'node:path'
import cookie from '@fastify/cookie'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Readiness } from '../health.js'
import { makeServerOrSessionAuthenticator } from './bridge.js'
import { hashServerKey } from './project-cache.js'
import { ProjectCache } from './project-cache.js'
import { SessionStore } from './sessions.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const SLUG = 'bridge-suite-a'
const OTHER_SLUG = 'bridge-suite-b'
const SERVER_KEY = 'sk_bridge_suite_a'
const EMAIL = 'bridge-suite@example.test'

let app: FastifyInstance
let readiness: Readiness
let sessions: SessionStore
let projectId = 0
let otherProjectId = 0
let adminId = 0
let cookieHeader = ''

async function makeProject(slug: string, serverKey: string): Promise<number> {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [slug, slug, `wk_${slug}`, hashServerKey(serverKey)],
  )
  return Number(r.rows[0]?.id)
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  projectId = await makeProject(SLUG, SERVER_KEY)
  otherProjectId = await makeProject(OTHER_SLUG, 'sk_bridge_suite_b')

  await pg.query('DELETE FROM admin_user')
  const a = await pg.query<{ id: string }>(
    'INSERT INTO admin_user (email, password_hash) VALUES ($1, $2) RETURNING id',
    [EMAIL, 'scrypt$16384$8$1$aa$bb'],
  )
  adminId = Number(a.rows[0]?.id)

  readiness = new Readiness()
  readiness.markReady()
  sessions = new SessionStore(pg)
  const projects = new ProjectCache(pg, 60_000)
  const authenticate = makeServerOrSessionAuthenticator({ readiness, projects, sessions })

  app = Fastify()
  await app.register(cookie)
  app.get('/probe', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    return reply.code(200).send({ id: project.id, slug: project.slug })
  })
  await app.ready()

  const { token } = await sessions.issue(adminId)
  cookieHeader = `lf_session=${token}`
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG, OTHER_SLUG]])
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

describe('the server-key path is unchanged', () => {
  it('accepts a valid server key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: projectId, slug: SLUG })
  })

  it('refuses an invalid server key with the original code', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-lyraflow-server-key': 'sk_nope' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_server_key' })
  })

  // Existing API clients depend on this exact code. Changing it to a new
  // "no credentials" code would be a silent breaking change to a published
  // contract.
  it('refuses no credentials at all with the original code', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe' })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'missing_server_key' })
  })

  it('refuses while draining', async () => {
    const r = new Readiness()
    r.markReady()
    const projects = new ProjectCache(pg, 60_000)
    const authenticate = makeServerOrSessionAuthenticator({ readiness: r, projects, sessions })
    const local = Fastify()
    await local.register(cookie)
    local.get('/probe', async (req, reply) => {
      const p = await authenticate(req, reply)
      if (!p) return
      return reply.code(200).send({ ok: true })
    })
    await local.ready()
    r.markDraining()

    const viaKey = await local.inject({
      method: 'GET',
      url: '/probe',
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    const viaSession = await local.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        cookie: cookieHeader,
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(projectId),
      },
    })
    expect(viaKey.statusCode).toBe(503)
    // A session must not become a way past the drain gate.
    expect(viaSession.statusCode).toBe(503)
    await local.close()
  })

  // The drain check must run FIRST, before any other validation -- not just
  // whenever a fully-valid session happens to reach it. A request that is
  // invalid for an unrelated reason (here, a forged token) must still see
  // the drain gate's uniform 503, not leak whichever check runs first.
  it('refuses a forged session token while draining with the drain code, not invalid_session', async () => {
    const r = new Readiness()
    r.markReady()
    const projects = new ProjectCache(pg, 60_000)
    const authenticate = makeServerOrSessionAuthenticator({ readiness: r, projects, sessions })
    const local = Fastify()
    await local.register(cookie)
    local.get('/probe', async (req, reply) => {
      const p = await authenticate(req, reply)
      if (!p) return
      return reply.code(200).send({ ok: true })
    })
    await local.ready()
    r.markDraining()

    const res = await local.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        cookie: 'lf_session=not-a-real-token',
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(projectId),
      },
    })
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'draining' })
    await local.close()
  })

  // An invalid or rotated-out server key must fail outright, not fall back
  // to a session cookie that happens to be riding along. Otherwise a stolen
  // admin cookie plus any garbage server key value becomes a second way in.
  it('does not fall back to a session when the server key is present but invalid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        'x-lyraflow-server-key': 'sk_nope',
        cookie: cookieHeader,
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(projectId),
      },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_server_key' })
  })
})

describe('the session path', () => {
  it('resolves a session plus a project id to that project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        cookie: cookieHeader,
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(projectId),
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: projectId, slug: SLUG })
  })

  it('resolves a different project id to that other project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        cookie: cookieHeader,
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(otherProjectId),
      },
    })
    expect(res.json()).toEqual({ id: otherProjectId, slug: OTHER_SLUG })
  })

  it('refuses an expired session', async () => {
    const shortLived = new SessionStore(pg, -1000)
    const { token } = await shortLived.issue(adminId)
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        cookie: `lf_session=${token}`,
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(projectId),
      },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_session' })
  })

  it('refuses a forged session token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        cookie: 'lf_session=not-a-real-token',
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(projectId),
      },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_session' })
  })

  it('refuses without the UI header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader, 'x-lyraflow-project': String(projectId) },
    })
    expect(res.statusCode).toBe(403)
    expect(res.json()).toEqual({ error: 'missing_ui_header' })
  })

  it('refuses without the project header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader, 'x-lyraflow-ui': '1' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'missing_project' })
  })

  it.each([
    ['not a number', 'abc'],
    ['negative', '-1'],
    ['zero', '0'],
    ['float', '1.5'],
    // IMPORTANT 1: Number.isInteger(1e21) is true, and Number('1e21') is a
    // finite, in-range-looking float -- so a bare Number()+isInteger check
    // let this reach ProjectCache.byId, which stringifies it to '1e+21' and
    // binds THAT against projects.id bigserial. Postgres rejects it
    // (22P02/22003), #lookup rethrows, and app.ts's catch-all turns a
    // deterministic client error into a 503 with a retry-after header --
    // this whole table exists to prove none of these five ever reach that
    // path.
    ['exponential notation', '1e21'],
    ['past MAX_SAFE_INTEGER but all digits', '99999999999999999999'],
    ['hex notation', '0x10'],
    ['leading plus', '+5'],
    ['surrounding whitespace', ' 1 '],
  ])('refuses a malformed project header: %s', async (_name, value) => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader, 'x-lyraflow-ui': '1', 'x-lyraflow-project': value },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_project' })
  })

  it('refuses a project id that does not exist', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: { cookie: cookieHeader, 'x-lyraflow-ui': '1', 'x-lyraflow-project': '999999999' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'project_not_found' })
  })

  // The server key wins when both are present, so a stale cookie in a
  // scripted client cannot silently change which project an API call acts
  // on.
  it('prefers the server key when both credentials are present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/probe',
      headers: {
        'x-lyraflow-server-key': SERVER_KEY,
        cookie: cookieHeader,
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(otherProjectId),
      },
    })
    expect(res.json()).toEqual({ id: projectId, slug: SLUG })
  })
})
