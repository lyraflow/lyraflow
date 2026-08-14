import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { ensureAdminUser } from './bootstrap.js'
import { hashServerKey } from './project-cache.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

// A prefix no other suite uses, per the shared test harness -- this file
// touches `admin_user` (single-tenant, cleared in beforeAll/afterAll) as
// well as its own project row.
const PREFIX = 'auth-wiring'
const SLUG = `${PREFIX}-project`
const EMAIL = `${PREFIX}-suite@example.test`
const PASSWORD = `${PREFIX}-suite-password`

let app: FastifyInstance
let projectId = 0
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
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [SLUG, SLUG, `wk_${PREFIX}`, hashServerKey(`sk_${PREFIX}`)],
  )
  projectId = Number(r.rows[0]?.id)

  // Own admin account, own prefix -- admin_user is single-tenant (see
  // bridge.test.ts/routes.test.ts), so this suite clears it in both
  // beforeAll and afterAll rather than assuming it starts empty.
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

  // A real login, not a hand-minted session -- this is what actually
  // proves the browser path end to end, from POST /v1/auth/login through
  // to every project-scoped route below.
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
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

// Every project-scoped GET route with no path parameter, and a query string
// that is valid apart from the credential -- confirmed by reading each
// route module directly (project/routes.ts, events/routes.ts,
// segments/routes.ts, funnels/routes.ts, schema/routes.ts), not assumed
// from the plan. A 401/403/400-from-auth here means the route was missed
// when the bridge was threaded through.
const SESSION_ROUTES: ReadonlyArray<[string, string]> = [
  ['GET', '/v1/project'],
  ['GET', '/v1/events?limit=1'],
  ['GET', '/v1/events/stats'],
  ['GET', '/v1/segments'],
  ['GET', '/v1/funnels'],
  ['GET', '/v1/schema/events'],
  ['GET', '/v1/schema/properties?event=x'],
]

describe('every project-scoped route accepts a session', () => {
  it.each(SESSION_ROUTES)('%s %s', async (method, url) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      headers: { cookie, 'x-lyraflow-ui': '1', 'x-lyraflow-project': String(projectId) },
    })
    expect(res.statusCode).toBeLessThan(400)
  })
})

// identity/person.ts, privacy/routes.ts and privacy/export.ts each expose a
// route that needs an id naming a REAL person/deletion request to answer
// under 400 -- none of SESSION_ROUTES above exercises these three modules'
// closures at all, since their only routes are id-scoped. Rather than
// pulling in the ingest pipeline to manufacture a real person (heavy
// machinery to stand up just to prove an auth wire-up), each is called with
// an id that resolves to "nothing found" -- a DETERMINISTIC 404 reached
// only past authentication. A session that failed to authenticate here
// would see 401 (invalid_session), 403 (missing_ui_header) or 400
// (missing_project/invalid_project) instead, never 404 -- so a 404 is
// itself the proof the bridge ran and returned a project.
const SESSION_ROUTES_ID_SCOPED: ReadonlyArray<[string, string, string]> = [
  ['GET', `/v1/persons/${PREFIX}-no-such-person`, 'person_not_found'],
  ['GET', `/v1/persons/${PREFIX}-no-such-person/export`, 'person_not_found'],
  ['GET', '/v1/deletions/999999999', 'deletion_not_found'],
]

describe('every id-scoped project route also accepts a session (identity/person.ts, privacy/routes.ts, privacy/export.ts)', () => {
  it.each(SESSION_ROUTES_ID_SCOPED)(
    '%s %s -> 404 %s, not an auth failure',
    async (method, url, error) => {
      const res = await app.inject({
        method: method as 'GET',
        url,
        headers: { cookie, 'x-lyraflow-ui': '1', 'x-lyraflow-project': String(projectId) },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error })
    },
  )
})

// The write path is public-key authenticated and must stay structurally
// separate. A session reaching it would mean a browser cookie could write
// events. Paths and the minimal payload shape confirmed against
// registerIngestRoutes directly: authenticate() runs before body parsing
// on all four, so the exact payload content does not matter to this test,
// only that no write key is present.
describe('the write-key routes never accept a session', () => {
  it.each([['/v1/track'], ['/v1/batch'], ['/v1/identify'], ['/v1/page']])(
    'POST %s',
    async (url) => {
      const res = await app.inject({
        method: 'POST',
        url,
        headers: { cookie, 'x-lyraflow-ui': '1', 'x-lyraflow-project': String(projectId) },
        payload: { event: 'x', anonymous_id: 'a' },
      })
      expect(res.statusCode).toBe(401)
    },
  )
})
