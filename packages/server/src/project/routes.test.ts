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
// Used only by the cache-TTL / not-found-branch test below: that test
// deletes this project's row mid-suite, so it must never be a slug any
// other test in this file depends on still existing.
const SLUG_C = 'proj-route-c'
const PROJECT_NAME_A = 'ProjectRoutesA'
const PROJECT_NAME_B = 'ProjectRoutesB'
const PROJECT_NAME_C = 'ProjectRoutesC'
const WRITE_KEY_A = 'wk_proj_route_a'
const SERVER_KEY_A = 'sk_proj_route_a'
const WRITE_KEY_B = 'wk_proj_route_b'
const SERVER_KEY_B = 'sk_proj_route_b'
const WRITE_KEY_C = 'wk_proj_route_c'
const SERVER_KEY_C = 'sk_proj_route_c'

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
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B, SLUG_C]])
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
  await makeProject(SLUG_C, PROJECT_NAME_C, WRITE_KEY_C, SERVER_KEY_C)

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
    // Not just the status -- mirrors schema/routes.test.ts's "requires the
    // server key" test. A genuine, issued key just sent under the wrong
    // header cannot match any project's server_key_hash, so the correct
    // implementation answers invalid_server_key specifically. A status-only
    // assertion can't tell that apart from a route that (wrongly) looked for
    // a header that wasn't there and answered missing_server_key instead.
    expect(res.json().error).toBe('invalid_server_key')
  })

  // Distinct from the test above: that one sends the write key under the
  // SERVER key's own header. This sends it under the WRITE key's own
  // header, x-lyraflow-write-key -- so if this route ever grew a fallback
  // that also checked that header (the literal failure mode this route's
  // whole risk statement warns about: "a public key authenticating a secret
  // route"), the test above would still see no x-lyraflow-server-key header
  // at all and pass vacuously. This is the one that would actually catch it.
  it('rejects the write key sent under its own header, not just under x-lyraflow-server-key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-write-key': WRITE_KEY_A },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('missing_server_key')
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

  // This route is the first in the codebase whose 200 body is a credential
  // (the write key). Its response varies entirely on the
  // x-lyraflow-server-key header, which it carries no Vary for -- so a
  // shared cache keying on URL alone could serve one project's write key
  // back out to a different caller. See privacy/export.ts's identical
  // no-store, applied there for the same reason on a subject-access
  // response.
  it('sends cache-control: no-store, since the body is a credential', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
    })
    expect(res.headers['cache-control']).toBe('no-store')
  })

  // THE test for the not-found branch, which nothing above exercises: every
  // other test in this file requests a project whose row exists at request
  // time, so `if (!row) return reply.code(404).send({ error:
  // 'project_not_found' })` has never actually run before this. That matters
  // because ProjectCache holds a positive answer for 60 seconds
  // (app.ts's `new ProjectCache(pg, 60_000)`) -- so for up to a minute after
  // a project row is deleted, authenticateServer still succeeds off the
  // cache while the route's own direct Postgres read finds nothing, and this
  // branch is what actually executes. It is reachable on a real operational
  // path (a project deleted while its key is still in active use elsewhere),
  // not merely a defensive `if` for an impossible case. If this branch were
  // ever changed to spread the cached (stale) `Project` into the error body
  // -- e.g. `{ error: 'project_not_found', project }` -- every other test in
  // this file would still pass, since none of them can reach 404 at all.
  it('does not leak the cached project through the not-found branch after the row is deleted mid-TTL', async () => {
    // Warm ProjectCache's positive entry for C's server key.
    const warm = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_C },
    })
    expect(warm.statusCode).toBe(200)

    // The row is gone, but the cache entry just warmed above is still fresh
    // for another ~60 seconds, so authenticateServer still resolves C's key
    // to a project -- only the route's own direct read comes back empty.
    await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG_C])

    const res = await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_C },
    })
    expect(res.statusCode).toBe(404)
    expect(Object.keys(res.json())).toEqual(['error'])
    expect(res.body).not.toContain(hashServerKey(SERVER_KEY_C))
  })
})
