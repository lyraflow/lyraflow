import { join } from 'node:path'
import cookiePlugin from '@fastify/cookie'
import { type Pool, createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { ensureAdminUser } from '../auth/bootstrap.js'
import { ProjectCache, hashServerKey } from '../auth/project-cache.js'
import { SessionStore, hashSessionToken } from '../auth/sessions.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { registerAdminProjectRoutes } from './admin-routes.js'
import { ProjectDeletionStore } from './deletion-store.js'

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
// A distinct prefix for the DELETE-route tests below, so their cleanup
// (which wipes by prefix) can never touch the shared SLUG project every
// other describe block in this file depends on.
const DEL_PREFIX = `${PREFIX}-del`

let app: FastifyInstance
let cookie = ''
let sessionHeaders: Record<string, string>
// The SAME configured value app.ts wires ProjectPurgeWorker and
// registerAdminProjectRoutes with (the default, since this suite's
// loadConfig call sets no override) -- captured here rather than hardcoded
// so the `failed` branch test below can't silently drift from whatever the
// app under test actually enforces.
let maxAttempts: number
const uiHeaderOnly = { 'x-lyraflow-ui': '1' }

// Same store DELETE /v1/projects/:id and GET /v1/project-deletions/:id
// consume inside buildApp -- see app.ts's comment on why it is not exposed
// on AppDeps. A second instance pointed at the same pool is fine (it holds
// no state of its own), which is exactly the pattern deletion-store.test.ts
// and worker.test.ts already use.
const store = new ProjectDeletionStore(pg)

let delCounter = 0
/** Raw INSERT, one unique slug per call -- same reasoning as deletion-store.test.ts's helper. */
async function createProject(
  db: Pool,
  name: string,
): Promise<{ id: number; slug: string; name: string }> {
  const slug = `${DEL_PREFIX}-${Date.now()}-${delCounter++}`
  const r = await db.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, `wk_${slug}`, `sk_${slug}`],
  )
  return { id: Number(r.rows[0]?.id), slug, name }
}

function del(project: { id: number; slug: string }) {
  return app.inject({
    method: 'DELETE',
    url: `/v1/projects/${project.id}`,
    headers: sessionHeaders,
    payload: { slug: project.slug },
  })
}

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
  maxAttempts = config.projectPurgeMaxAttempts
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
  sessionHeaders = { cookie, 'x-lyraflow-ui': '1' }
})

afterAll(async () => {
  await app.close()
  // Both by prefix: DELETE-route tests mint one project per call and never
  // name them individually, unlike the fixed-name POST /v1/projects tests
  // below. No FK ties project_deletions to projects (deliberately -- see
  // ProjectDeletionStore.get's docstring), so nothing enforces an order here.
  await pg.query(`DELETE FROM project_deletions WHERE slug LIKE '${DEL_PREFIX}-%'`)
  await pg.query(`DELETE FROM projects WHERE slug LIKE '${DEL_PREFIX}-%'`)
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
      [
        'created_at',
        'deleting_at',
        'disabled_at',
        'id',
        'monthly_event_quota',
        'name',
        'retention_months',
        'slug',
      ].sort(),
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

  // #89: the UI adds the created project to its in-memory list straight
  // from this response, so it needs the id -- POST /v1/projects didn't
  // return one before this fix.
  it('returns the created project id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
      payload: { name: 'Admin Routes Id' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Record<string, unknown>
    expect(typeof body.id).toBe('number')
    expect(body.id).toBeGreaterThan(0)

    const list = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    const projects = (list.json() as { projects: Array<Record<string, unknown>> }).projects
    const mine = projects.find((p) => p.slug === 'admin-routes-id')
    expect(mine?.id).toBe(body.id)

    await pg.query('DELETE FROM projects WHERE slug = $1', ['admin-routes-id'])
  })

  // Every field GET /v1/projects lists for a project, matching exactly --
  // not merely present, so a field GET reports that this response silently
  // omitted (or a stale/defaulted value that disagrees with what GET would
  // say) is caught. This is what makes the UI's "add this row without a
  // second fetch" additive-insert safe: the created entry must be
  // indistinguishable from one that came from GET /v1/projects.
  it('returns every field GET /v1/projects reports for the same project, with matching values', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
      payload: { name: 'Admin Routes Full Shape' },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json() as Record<string, unknown>

    const list = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie, 'x-lyraflow-ui': '1' },
    })
    const projects = (list.json() as { projects: Array<Record<string, unknown>> }).projects
    const fromList = projects.find((p) => p.slug === 'admin-routes-full-shape')
    expect(fromList).toBeDefined()

    for (const field of [
      'id',
      'name',
      'slug',
      'created_at',
      'retention_months',
      'monthly_event_quota',
      'deleting_at',
    ]) {
      expect(body[field]).toEqual(fromList?.[field])
    }
    // Not merely equal to GET's (both undefined would pass that loop) --
    // present and explicitly null, the same way `disabled_at` already is
    // just above in the real response.
    expect(body.deleting_at).toBeNull()

    await pg.query('DELETE FROM projects WHERE slug = $1', ['admin-routes-full-shape'])
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

// Follow-up to Important 2 (feat/admin-sessions whole-branch review):
// requireSession had the SAME discarded-renewal pattern the bridge did,
// on GET /v1/projects -- the route a project switcher polls routinely.
// Fixed structurally, by flipping SessionStore.verify's own default to
// non-renewing (see sessions.ts's docstring), rather than as a second
// `{ renew: false }` call site here. This test pins that a session inside
// its renewal window, used through THIS route, still does not move
// expires_at -- built directly against registerAdminProjectRoutes (not
// buildApp, whose SessionStore uses fixed production TTLs) so the renewal
// window can actually be reached without a 7-day wait.
describe('a session inside its renewal window, used through GET /v1/projects', () => {
  it('does not move expires_at', async () => {
    const admin = await pg.query<{ id: string }>('SELECT id FROM admin_user WHERE email = $1', [
      EMAIL,
    ])
    const adminId = Number(admin.rows[0]?.id)

    // 10s TTL, 60s renew-within: issued already inside its own window --
    // same shape as bridge.test.ts's equivalent proof.
    const issuer = new SessionStore(pg, 10_000, 60_000)
    const { token } = await issuer.issue(adminId)
    const before = await pg.query<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE id = $1',
      [hashSessionToken(token)],
    )

    const routeSessions = new SessionStore(pg, 600_000, 60_000)
    const readiness = new Readiness()
    readiness.markReady()
    const projects = new ProjectCache(pg, 60_000)
    const local = Fastify()
    await local.register(cookiePlugin)
    registerAdminProjectRoutes(local, {
      pg,
      sessions: routeSessions,
      projects,
      readiness,
      deletions: store,
      maxAttempts: 5,
      leaseMs: 1_800_000,
    })
    await local.ready()

    const res = await local.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { cookie: `lf_session=${token}`, 'x-lyraflow-ui': '1' },
    })
    expect(res.statusCode).toBe(200)
    await local.close()

    const after = await pg.query<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE id = $1',
      [hashSessionToken(token)],
    )
    expect(after.rows[0]?.expires_at.getTime()).toBe(before.rows[0]?.expires_at.getTime())
  })
})

describe('PATCH /v1/projects/:id', () => {
  const patch = (id: number | string, payload: { name?: string; archived?: boolean }) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      headers: { 'x-lyraflow-ui': '1', cookie },
      payload,
    })

  const projectId = async (): Promise<number> => {
    const res = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [SLUG])
    return Number(res.rows[0]?.id)
  }

  it('refuses a request with no session', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/projects/${await projectId()}`,
      headers: { 'x-lyraflow-ui': '1' },
      payload: { name: 'nope' },
    })
    expect(res.statusCode).toBe(401)
  })

  // The slug is what a project is addressed by outside this API --
  // `lyraflow seed-demo demo-data` and anything an operator scripted around
  // it. Deriving a new slug from a new name would break those silently, at
  // the moment somebody fixed a typo in a display name.
  it('renames without touching the slug', async () => {
    const id = await projectId()
    const res = await patch(id, { name: 'Renamed By Test' })
    expect(res.statusCode).toBe(200)
    expect(res.json().name).toBe('Renamed By Test')
    expect(res.json().slug).toBe(SLUG)

    const row = await pg.query<{ name: string; slug: string }>(
      'SELECT name, slug FROM projects WHERE id = $1',
      [id],
    )
    expect(row.rows[0]).toEqual({ name: 'Renamed By Test', slug: SLUG })
  })

  it('archives, then restores, and says when it was archived', async () => {
    const id = await projectId()
    const archived = await patch(id, { archived: true })
    expect(archived.statusCode).toBe(200)
    expect(archived.json().disabled_at).not.toBeNull()

    const restored = await patch(id, { archived: false })
    expect(restored.statusCode).toBe(200)
    expect(restored.json().disabled_at).toBeNull()
  })

  // Archiving twice must not move the timestamp: "when was this stopped" is
  // the question the column exists to answer, and a second click on a
  // control that is already in that state would otherwise rewrite history.
  it('keeps the original instant when archived twice', async () => {
    const id = await projectId()
    const first = await patch(id, { archived: true })
    const again = await patch(id, { archived: true })
    expect(again.json().disabled_at).toBe(first.json().disabled_at)
    await patch(id, { archived: false })
  })

  // Absent means "leave alone", independently per field -- so a rename does
  // not restore an archived project and archiving does not blank a name.
  it('leaves the other field alone when only one is sent', async () => {
    const id = await projectId()
    await patch(id, { archived: true })
    const renamed = await patch(id, { name: 'Still Archived' })
    expect(renamed.json().name).toBe('Still Archived')
    expect(renamed.json().disabled_at).not.toBeNull()
    await patch(id, { archived: false })
  })

  it('refuses an empty name and a non-numeric id', async () => {
    const id = await projectId()
    expect((await patch(id, { name: '   ' })).statusCode).toBe(400)
    expect((await patch('abc', { name: 'x' })).statusCode).toBe(400)
  })

  it('answers 404 for a project that does not exist', async () => {
    expect((await patch(2_147_483_000, { name: 'x' })).statusCode).toBe(404)
  })

  it('lists the archive state alongside every other project field', async () => {
    const id = await projectId()
    await patch(id, { archived: true })
    const list = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { 'x-lyraflow-ui': '1', cookie },
    })
    const listed = list.json().projects.find((p: { id: number }) => p.id === id)
    expect(listed.disabled_at).not.toBeNull()
    await patch(id, { archived: false })
  })
})

describe('an archived project and ingest', () => {
  const projectId = async (): Promise<number> => {
    const res = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [SLUG])
    return Number(res.rows[0]?.id)
  }
  const setArchived = (id: number, archived: boolean) =>
    app.inject({
      method: 'PATCH',
      url: `/v1/projects/${id}`,
      headers: { 'x-lyraflow-ui': '1', cookie },
      payload: { archived },
    })

  const track = () =>
    app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': `wk_${PREFIX}` },
      payload: {
        type: 'track',
        message_id: '11111111-2222-3333-4444-555555555555',
        anonymous_id: 'archive-test',
        event: 'ping',
      },
    })

  /**
   * 401 AND NOT 403, which is forced rather than chosen: the browser SDK
   * treats 401 alone as terminal and retries every other status forever.
   * Self-hosters have older bundles already on their pages, so a 403 here
   * would have every deployed snippet hammer the server indefinitely for a
   * project that will never accept again.
   *
   * The distinct code in the body is what keeps this legible as something
   * other than a bad key.
   */
  it('refuses ingest with 401 and a distinguishable code', async () => {
    const id = await projectId()
    expect((await track()).statusCode).toBe(202)

    await setArchived(id, true)
    const refused = await track()
    expect(refused.statusCode).toBe(401)
    expect(refused.json().error).toBe('project_archived')
    // Not the code a bad key gets -- an operator reading a log has to be
    // able to tell "I stopped this" from "somebody has the wrong key".
    expect(refused.json().error).not.toBe('invalid_write_key')

    await setArchived(id, false)
    expect((await track()).statusCode).toBe(202)
  })

  /**
   * The refusal is read off `ProjectCache`, so archiving MUST invalidate it.
   * Without that the project keeps accepting events until the TTL lapses --
   * and this test would still pass if the cache were merely cold, so it
   * warms the cache first with a successful call above and again here.
   */
  it('takes effect immediately rather than at the next cache expiry', async () => {
    const id = await projectId()
    expect((await track()).statusCode).toBe(202) // warms the write-key entry
    await setArchived(id, true)
    expect((await track()).statusCode).toBe(401)
    await setArchived(id, false)
    // And the restore is immediate too, for the same reason.
    expect((await track()).statusCode).toBe(202)
  })

  // Archiving stops collection and nothing else. The data is intact and the
  // state is reversible, so refusing reads would make archive into delete
  // with extra steps -- and would take away the screen an operator uses to
  // check what they stopped.
  it('keeps server-key reads working', async () => {
    const id = await projectId()
    await setArchived(id, true)
    const read = await app.inject({
      method: 'GET',
      url: '/v1/events?limit=1',
      headers: { 'x-lyraflow-server-key': SERVER_KEY },
    })
    expect(read.statusCode).toBe(200)
    await setArchived(id, false)
  })
})

describe('DELETE /v1/projects/:id', () => {
  it('202s a delete whose body carries the right slug', async () => {
    const project = await createProject(pg, 'Acme')
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${project.id}`,
      headers: sessionHeaders,
      payload: { slug: project.slug },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ project_id: project.id, status: 'pending' })
    // A poll target: caching this would let a client miss every state
    // change until the entry expired.
    expect(res.headers['cache-control']).toBe('no-store')
  })

  it('409s a slug that does not match, stamping nothing and queueing nothing', async () => {
    const project = await createProject(pg, 'Acme')
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${project.id}`,
      headers: sessionHeaders,
      payload: { slug: 'not-acme' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'slug_mismatch' })
    const row = await pg.query('SELECT deleting_at FROM projects WHERE id = $1', [project.id])
    expect(row.rows[0].deleting_at).toBeNull()
    expect(
      (await pg.query('SELECT count(*) FROM project_deletions WHERE project_id = $1', [project.id]))
        .rows[0].count,
    ).toBe('0')
  })

  it('409s a second delete and names the request already in flight', async () => {
    const project = await createProject(pg, 'Acme')
    const first = await del(project)
    const second = await del(project)
    expect(second.statusCode).toBe(409)
    expect(second.json()).toEqual({ error: 'already_deleting', id: first.json().id })
  })

  it('404s an unknown project', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/projects/999999',
      headers: sessionHeaders,
      payload: { slug: 'anything' },
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'project_not_found' })
  })

  it('400s a non-numeric id', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/projects/abc',
      headers: sessionHeaders,
      payload: { slug: 'acme' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_id' })
  })

  // `Number('0')` and `Number('-1')` are both valid, in-range numbers --
  // `!Number.isInteger(id)` alone would never catch either, and only the
  // separate `id <= 0` half of the guard does. Without it these reach the
  // database as a bind parameter that matches no row rather than a 400.
  it.each([
    ['zero', '0'],
    ['negative', '-1'],
  ])('400s an out-of-range id: %s', async (_name, raw) => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${raw}`,
      headers: sessionHeaders,
      payload: { slug: 'acme' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_id' })
  })

  it('400s a body with no slug', async () => {
    const project = await createProject(pg, 'Acme')
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${project.id}`,
      headers: sessionHeaders,
      payload: {},
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_body' })
  })

  it('401s without a session', async () => {
    const project = await createProject(pg, 'Acme')
    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/projects/${project.id}`,
      headers: uiHeaderOnly,
      payload: { slug: project.slug },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_session' })
  })

  it('still lists a deleting project, with deleting_at set', async () => {
    const project = await createProject(pg, 'Acme')
    await del(project)
    const res = await app.inject({ method: 'GET', url: '/v1/projects', headers: sessionHeaders })
    const listed = res.json().projects.find((p: { id: number }) => p.id === project.id)
    expect(listed.deleting_at).toEqual(expect.any(String))
  })
})

describe('GET /v1/project-deletions/:id', () => {
  it('reports a deletion status by id', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await del(project)).json()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/project-deletions/${id}`,
      headers: sessionHeaders,
    })
    expect(res.json()).toMatchObject({ status: 'pending', completed_at: null })
    // The route a UI polls -- a cached response is the failure that matters
    // here, more than on most others.
    expect(res.headers['cache-control']).toBe('no-store')
  })

  // The pin that proves the missing foreign key on project_deletions is
  // deliberate: with ON DELETE CASCADE the status row would vanish along
  // with the project and this would 404 instead of reporting `completed`.
  it('reports completed after the row is gone', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await del(project)).json()
    await store.complete(id)
    await pg.query('DELETE FROM projects WHERE id = $1', [project.id])
    const res = await app.inject({
      method: 'GET',
      url: `/v1/project-deletions/${id}`,
      headers: sessionHeaders,
    })
    expect(res.json().status).toBe('completed')
  })

  // This route is instance-scoped and reports `last_error`, raw failure
  // text from the purge worker -- an ungated regression here exposes every
  // deletion request on the install, not just the caller's own. Mirrors the
  // DELETE route's equivalent test.
  it('401s without a session', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await del(project)).json()
    const res = await app.inject({
      method: 'GET',
      url: `/v1/project-deletions/${id}`,
      headers: uiHeaderOnly,
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'invalid_session' })
  })

  it('400s a non-numeric id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project-deletions/abc',
      headers: sessionHeaders,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_id' })
  })

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
  ])('400s an out-of-range id: %s', async (_name, raw) => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/project-deletions/${raw}`,
      headers: sessionHeaders,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid_id' })
  })

  it('404s an id naming no deletion request', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project-deletions/999999',
      headers: sessionHeaders,
    })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'deletion_not_found' })
  })

  // The order pin: `last_error` must be read as `pending` (with the error
  // surfaced) BEFORE the lease check below, or a request that failed its
  // last attempt but is not yet dead reports the wrong state. `store.fail`
  // alone does not exercise this -- it never touches `claimed_at`, so the
  // lease check would evaluate false either way and the ordering would not
  // matter. The real state this guards against is a worker's claim() (sets
  // `claimed_at` to now, within the lease) followed by its fail() (sets
  // `last_error`, leaves `claimed_at` alone -- see fail()'s own docstring),
  // stamped directly here rather than through claim() for the reason the
  // in_progress test below explains.
  it('reports pending with the error after a failed attempt, ahead of the lease check', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await del(project)).json()
    await pg.query('UPDATE project_deletions SET claimed_at = now() WHERE id = $1', [id])
    await store.fail(id, 'boom')
    const res = await app.inject({
      method: 'GET',
      url: `/v1/project-deletions/${id}`,
      headers: sessionHeaders,
    })
    expect(res.json()).toMatchObject({ status: 'pending', error: 'boom' })
  })

  it('reports failed once attempts reach the configured max', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await del(project)).json()
    await pg.query('UPDATE project_deletions SET attempts = $2 WHERE id = $1', [id, maxAttempts])
    const res = await app.inject({
      method: 'GET',
      url: `/v1/project-deletions/${id}`,
      headers: sessionHeaders,
    })
    expect(res.json()).toMatchObject({ status: 'failed', completed_at: null })
  })

  // NOT `store.claim(...)`: `claim` is deliberately global (not scoped to
  // one request -- see its own docstring), and by this point in the suite
  // several earlier tests' requests are still sitting in the queue,
  // unclaimed and unfailed. `claim` would hand back whichever of THOSE is
  // oldest, leaving THIS test's own row untouched and its assertion
  // asserting the wrong id's state. Stamping `claimed_at` directly is the
  // same technique deletion-store.test.ts's own claim tests use for the
  // opposite case (an expired lease).
  it('reports in_progress for a request a worker has currently claimed', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await del(project)).json()
    await pg.query('UPDATE project_deletions SET claimed_at = now() WHERE id = $1', [id])
    const res = await app.inject({
      method: 'GET',
      url: `/v1/project-deletions/${id}`,
      headers: sessionHeaders,
    })
    expect(res.json()).toMatchObject({ status: 'in_progress', completed_at: null })
  })
})
