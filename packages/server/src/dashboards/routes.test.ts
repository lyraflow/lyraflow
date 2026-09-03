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

const WRITE_KEY = 'wk_dash_routes'
const SERVER_KEY = 'sk_dash_routes'
const OTHER_SERVER_KEY = 'sk_dash_routes_other'

const EMAIL = 'dash-routes-suite@example.test'
const PASSWORD = 'dash-routes-suite-password'

let app: FastifyInstance
let projectId: number
let otherProjectId: number

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
  for (const slug of ['dash-routes', 'dash-routes-other']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  const mine = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Dash Routes', 'dash-routes', $1, $2) RETURNING id`,
    [WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(mine.rows[0]?.id)
  const other = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Dash Routes Other', 'dash-routes-other', $1, $2) RETURNING id`,
    ['wk_dash_routes_other', hashServerKey(OTHER_SERVER_KEY)],
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
  await pg.query('DELETE FROM dashboards WHERE project_id = ANY($1)', [[projectId, otherProjectId]])
  await pg.query('DELETE FROM trend_reports WHERE project_id = ANY($1)', [
    [projectId, otherProjectId],
  ])
  await pg.query('DELETE FROM retention_reports WHERE project_id = ANY($1)', [
    [projectId, otherProjectId],
  ])
  await pg.query('DELETE FROM funnels WHERE project_id = ANY($1)', [[projectId, otherProjectId]])
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [
    ['dash-routes', 'dash-routes-other'],
  ])
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

async function makeTrend(key = SERVER_KEY): Promise<number> {
  const res = await call(
    'POST',
    '/v1/trends',
    { name: `t-${Math.random()}`, event: 'signup', interval: '1d' },
    key,
  )
  expect(res.statusCode).toBe(201)
  return res.json().id
}

describe('dashboard routes', () => {
  it('requires a server key or a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/dashboards' })
    expect(res.statusCode).toBe(401)
  })

  it('creates, lists, reads, patches and deletes', async () => {
    const t = await makeTrend()
    const created = await call('POST', '/v1/dashboards', {
      name: 'Overview',
      tiles: [{ kind: 'trend', report_id: t, width: 'half' }],
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      name: 'Overview',
      is_home: false,
      stale: false,
      tile_count: 1,
    })
    const id = created.json().id

    const list = await call('GET', '/v1/dashboards')
    expect(list.json().dashboards).toHaveLength(1)
    expect(list.json().dashboards[0]).toMatchObject({ id, tile_count: 1, is_home: false })
    expect(list.json().dashboards[0].tiles).toBeUndefined()

    const detail = await call('GET', `/v1/dashboards/${id}`)
    expect(detail.statusCode).toBe(200)
    expect(detail.json().tiles).toEqual([
      {
        kind: 'trend',
        report_id: t,
        width: 'half',
        report: expect.objectContaining({ id: t, event: 'signup' }),
      },
    ])

    const patched = await call('PATCH', `/v1/dashboards/${id}`, { name: 'Overview 2' })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().name).toBe('Overview 2')
    expect(patched.json().tiles).toHaveLength(1)

    expect((await call('DELETE', `/v1/dashboards/${id}`)).statusCode).toBe(204)
    expect((await call('GET', `/v1/dashboards/${id}`)).statusCode).toBe(404)
  })

  it('accepts a session cookie through the same handler', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'x-lyraflow-ui': '1' },
      payload: { email: EMAIL, password: PASSWORD },
    })
    const cookie = cookieValue(String(login.headers['set-cookie']))
    const res = await app.inject({
      method: 'GET',
      url: '/v1/dashboards',
      headers: {
        cookie: `lf_session=${cookie}`,
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(projectId),
      },
    })
    expect(res.statusCode).toBe(200)
  })

  it('409s a duplicate name on create and on rename', async () => {
    await call('POST', '/v1/dashboards', { name: 'Same' })
    expect((await call('POST', '/v1/dashboards', { name: 'Same' })).statusCode).toBe(409)
    const other = await call('POST', '/v1/dashboards', { name: 'Other' })
    expect(
      (await call('PATCH', `/v1/dashboards/${other.json().id}`, { name: 'Same' })).statusCode,
    ).toBe(409)
  })

  it('allows the same name in another project', async () => {
    await call('POST', '/v1/dashboards', { name: 'Same' })
    expect(
      (await call('POST', '/v1/dashboards', { name: 'Same' }, OTHER_SERVER_KEY)).statusCode,
    ).toBe(201)
  })

  it("400s a malformed id and 404s another project's id", async () => {
    expect((await call('GET', '/v1/dashboards/abc')).json()).toEqual({
      error: 'invalid_dashboard_id',
    })
    const mine = await call('POST', '/v1/dashboards', { name: 'Mine' })
    expect(
      (await call('GET', `/v1/dashboards/${mine.json().id}`, undefined, OTHER_SERVER_KEY))
        .statusCode,
    ).toBe(404)
  })

  // I2 from the Task 4 review: the GET guards above were pinned, PATCH and
  // DELETE were not. Each of the four tests below fails on exactly its own
  // guard when that guard is removed.
  it('400s a malformed id on PATCH and on DELETE', async () => {
    expect((await call('PATCH', '/v1/dashboards/abc', { name: 'X' })).json()).toEqual({
      error: 'invalid_dashboard_id',
    })
    expect((await call('DELETE', '/v1/dashboards/abc')).json()).toEqual({
      error: 'invalid_dashboard_id',
    })
  })

  it("404s a PATCH to another project's id, and the row is untouched", async () => {
    const mine = await call('POST', '/v1/dashboards', { name: 'Mine' })
    const id = mine.json().id
    const res = await call('PATCH', `/v1/dashboards/${id}`, { name: 'Stolen' }, OTHER_SERVER_KEY)
    expect(res.statusCode).toBe(404)
    expect((await call('GET', `/v1/dashboards/${id}`)).json().name).toBe('Mine')
  })

  it("404s a DELETE to another project's id, and the row still exists", async () => {
    const mine = await call('POST', '/v1/dashboards', { name: 'Mine' })
    const id = mine.json().id
    const res = await call('DELETE', `/v1/dashboards/${id}`, undefined, OTHER_SERVER_KEY)
    expect(res.statusCode).toBe(404)
    expect((await call('GET', `/v1/dashboards/${id}`)).statusCode).toBe(200)
  })

  // I1 from the Task 4 review: `PATCH { is_home: true }` on another
  // project's id must not silently clear the caller's current home before
  // answering 404 -- `DashboardStore.#setHome` clears first, since setting
  // the new home before clearing would collide with itself on
  // `dashboards_one_home_per_project`.
  it("404s a PATCH { is_home: true } to another project's id, and the caller's home survives", async () => {
    const home = await call('POST', '/v1/dashboards', { name: 'Home' })
    const homed = await call('PATCH', `/v1/dashboards/${home.json().id}`, { is_home: true })
    expect(homed.json().is_home).toBe(true)
    const theirs = await call('POST', '/v1/dashboards', { name: 'Theirs' }, OTHER_SERVER_KEY)

    // My server key, their id: the cross-project id that must not touch my
    // home before this 404s.
    const res = await call('PATCH', `/v1/dashboards/${theirs.json().id}`, { is_home: true })
    expect(res.statusCode).toBe(404)

    const list = (await call('GET', '/v1/dashboards')).json().dashboards
    expect(list.find((d: { id: number }) => d.id === home.json().id)?.is_home).toBe(true)
  })

  it('refuses a thirteenth tile with a field-level 400', async () => {
    const t = await makeTrend()
    const tiles = Array.from({ length: 13 }, () => ({ kind: 'trend', report_id: t, width: 'half' }))
    const res = await call('POST', '/v1/dashboards', { name: 'Big', tiles })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_dashboard')
    expect(res.json().detail[0].path).toBe('tiles')
  })

  it('refuses a tile naming a report that does not exist', async () => {
    const res = await call('POST', '/v1/dashboards', {
      name: 'Dangling',
      tiles: [{ kind: 'funnel', report_id: 424242, width: 'half' }],
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'report_not_found', kind: 'funnel', report_id: 424242 })
  })

  it('refuses a tile naming a report in ANOTHER project -- the project boundary', async () => {
    const theirs = await makeTrend(OTHER_SERVER_KEY)
    const res = await call(
      'PATCH',
      `/v1/dashboards/${(await call('POST', '/v1/dashboards', { name: 'B' })).json().id}`,
      {
        tiles: [{ kind: 'trend', report_id: theirs, width: 'half' }],
      },
    )
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({
      error: 'report_not_found',
      kind: 'trend',
      report_id: theirs,
    })
  })

  it('a report deleted after saving reads back as null, and the tile and count stay', async () => {
    const t = await makeTrend()
    const d = await call('POST', '/v1/dashboards', {
      name: 'D',
      tiles: [{ kind: 'trend', report_id: t, width: 'full' }],
    })
    expect((await call('DELETE', `/v1/trends/${t}`)).statusCode).toBe(204)
    const detail = await call('GET', `/v1/dashboards/${d.json().id}`)
    expect(detail.json().tiles).toEqual([
      { kind: 'trend', report_id: t, width: 'full', report: null },
    ])
    expect((await call('GET', '/v1/dashboards')).json().dashboards[0].tile_count).toBe(1)
  })

  // C1 from the final whole-branch review. The screen sends the WHOLE tile
  // array on every edit, so refusing a write because ANY tile dangles makes
  // one deleted report freeze the entire layout: every move, resize, add and
  // remove resends the dangling tile and comes back 400. What the check is
  // actually for is a caller naming a report it does not own, so it applies
  // to the tiles a write INTRODUCES -- the ones not already stored here.
  describe('a dangling tile does not freeze the layout', () => {
    let id: number
    let gone: number
    let live: number

    beforeEach(async () => {
      live = await makeTrend()
      gone = await makeTrend()
      const d = await call('POST', '/v1/dashboards', {
        name: 'Layout',
        tiles: [
          { kind: 'trend', report_id: live, width: 'half' },
          { kind: 'trend', report_id: gone, width: 'half' },
        ],
      })
      expect(d.statusCode).toBe(201)
      id = d.json().id
      expect((await call('DELETE', `/v1/trends/${gone}`)).statusCode).toBe(204)
    })

    it('reorders around it, and reads it back as null', async () => {
      const res = await call('PATCH', `/v1/dashboards/${id}`, {
        tiles: [
          { kind: 'trend', report_id: gone, width: 'half' },
          { kind: 'trend', report_id: live, width: 'half' },
        ],
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().tiles).toEqual([
        { kind: 'trend', report_id: gone, width: 'half', report: null },
        {
          kind: 'trend',
          report_id: live,
          width: 'half',
          report: expect.objectContaining({ id: live }),
        },
      ])
    })

    it("still refuses the same write when the missing id is another project's report", async () => {
      const theirs = await makeTrend(OTHER_SERVER_KEY)
      const res = await call('PATCH', `/v1/dashboards/${id}`, {
        tiles: [
          { kind: 'trend', report_id: theirs, width: 'half' },
          { kind: 'trend', report_id: live, width: 'half' },
        ],
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        error: 'report_not_found',
        kind: 'trend',
        report_id: theirs,
      })
    })

    it('removes the live tile and keeps only the dangling one', async () => {
      const res = await call('PATCH', `/v1/dashboards/${id}`, {
        tiles: [{ kind: 'trend', report_id: gone, width: 'full' }],
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().tiles).toEqual([
        { kind: 'trend', report_id: gone, width: 'full', report: null },
      ])
    })

    it('names the tile the write ADDS, not the one already dangling', async () => {
      const res = await call('PATCH', `/v1/dashboards/${id}`, {
        tiles: [
          { kind: 'trend', report_id: live, width: 'half' },
          { kind: 'trend', report_id: gone, width: 'half' },
          { kind: 'funnel', report_id: 424242, width: 'half' },
        ],
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'report_not_found', kind: 'funnel', report_id: 424242 })
    })
  })

  it('is_home: true moves home; is_home: false clears it', async () => {
    const a = (await call('POST', '/v1/dashboards', { name: 'A' })).json().id
    const b = (await call('POST', '/v1/dashboards', { name: 'B' })).json().id
    expect((await call('PATCH', `/v1/dashboards/${a}`, { is_home: true })).json().is_home).toBe(
      true,
    )
    expect((await call('PATCH', `/v1/dashboards/${b}`, { is_home: true })).json().is_home).toBe(
      true,
    )
    const list = (await call('GET', '/v1/dashboards')).json().dashboards
    expect(
      list.filter((d: { is_home: boolean }) => d.is_home).map((d: { name: string }) => d.name),
    ).toEqual(['B'])
    expect((await call('PATCH', `/v1/dashboards/${b}`, { is_home: false })).json().is_home).toBe(
      false,
    )
  })

  it('reads a stale row as stale with no tiles, on the list and the detail', async () => {
    await pg.query(
      `INSERT INTO dashboards (project_id, name, definition_version, tiles)
       VALUES ($1, 'Broken', 1, '[{"kind":"pie"}]'::jsonb)`,
      [projectId],
    )
    const list = (await call('GET', '/v1/dashboards')).json().dashboards
    expect(list[0]).toMatchObject({ name: 'Broken', stale: true, tile_count: 0 })
    const detail = await call('GET', `/v1/dashboards/${list[0].id}`)
    expect(detail.json()).toMatchObject({ stale: true, tiles: [] })
  })
})
