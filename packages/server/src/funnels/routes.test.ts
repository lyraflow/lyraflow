import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { FUNNEL_DEFINITION_VERSION } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
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

const WRITE_KEY = 'wk_funnels_routes'
const SERVER_KEY = 'sk_funnels_routes'
const OTHER_SERVER_KEY = 'sk_funnels_routes_other'

let app: FastifyInstance
let projectId: number
let otherProjectId: number

const signup = {
  steps: [
    { event: '$page', where: [{ property: 'path', operator: '=', value: '/' }] },
    { event: 'signed_up' },
  ],
  window_seconds: 604800,
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
    // content-type only when there is a body: Fastify rejects an empty body
    // sent as application/json, which is what a bodyless DELETE is.
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      'x-lyraflow-server-key': key,
    },
    payload: payload as never,
  })

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  for (const slug of ['funnels-routes', 'funnels-routes-other']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  const mine = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Funnels Routes', 'funnels-routes', $1, $2) RETURNING id`,
    [WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  projectId = Number(mine.rows[0]?.id)
  const other = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Funnels Other', 'funnels-routes-other', $1, $2) RETURNING id`,
    ['wk_funnels_other', hashServerKey(OTHER_SERVER_KEY)],
  )
  otherProjectId = Number(other.rows[0]?.id)

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
  await pg.query('DELETE FROM funnels WHERE project_id = ANY($1)', [[projectId, otherProjectId]])
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [
    ['funnels-routes', 'funnels-routes-other'],
  ])
  await pg.end()
  await ch.close()
})

describe('funnel routes', () => {
  it('requires a server key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/funnels' })
    expect(res.statusCode).toBe(401)
  })

  it('creates, lists, reads, patches and deletes', async () => {
    const created = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    expect(created.statusCode).toBe(201)
    const id = created.json().id
    expect(created.json().definition_version).toBe(FUNNEL_DEFINITION_VERSION)
    expect(created.json().stale).toBe(false)

    expect((await call('GET', '/v1/funnels')).json().funnels).toHaveLength(1)
    expect((await call('GET', `/v1/funnels/${id}`)).json().name).toBe('signup')

    const patched = await call('PATCH', `/v1/funnels/${id}`, { name: 'signup-v2' })
    expect(patched.json().name).toBe('signup-v2')

    expect((await call('DELETE', `/v1/funnels/${id}`)).statusCode).toBe(204)
    expect((await call('GET', `/v1/funnels/${id}`)).statusCode).toBe(404)
  })

  it('rejects a duplicate name with 409', async () => {
    await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    const dup = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    expect(dup.statusCode).toBe(409)
  })

  it('rejects a 9-step funnel at CREATE time, not at first run', async () => {
    const res = await call('POST', '/v1/funnels', {
      name: 'too-many',
      steps: Array.from({ length: 9 }, (_, i) => ({ event: `e${i}` })),
      window_seconds: 60,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('steps')
  })

  it('rejects a PATCH that would raise the window past the cap', async () => {
    const created = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    const res = await call('PATCH', `/v1/funnels/${created.json().id}`, {
      window_seconds: 2592001,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('window')
  })

  it('rejects a range spanning more than 90 days', async () => {
    const res = await call('POST', '/v1/funnels/preview', {
      ...signup,
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-08-14T00:00:00.000Z',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('range')
  })

  it('defaults the range to the last 7 days and echoes what it used', async () => {
    const res = await call('POST', '/v1/funnels/preview', signup)
    expect(res.statusCode).toBe(200)
    const { since, until } = res.json().range
    const span = new Date(until).getTime() - new Date(since).getTime()
    expect(span).toBe(7 * 86_400_000)
    expect(res.json().as_of).toBeTypeOf('string')
  })

  it('echoes an explicitly supplied range', async () => {
    const range = { since: '2026-08-07T00:00:00.000Z', until: '2026-08-14T00:00:00.000Z' }
    const res = await call('POST', '/v1/funnels/preview', { ...signup, ...range })
    expect(res.json().range).toEqual(range)
  })

  it('returns identical warnings from preview and run for the same definition', async () => {
    // #21 is open because the saved-segment run omits warnings the ad-hoc
    // preview returns. Both paths must end in one derivation.
    const range = { since: '2026-08-07T00:00:00.000Z', until: '2026-08-14T00:00:00.000Z' }
    const created = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    const preview = await call('POST', '/v1/funnels/preview', { ...signup, ...range })
    const run = await call('POST', `/v1/funnels/${created.json().id}/run`, range)
    expect(run.statusCode).toBe(200)
    expect(run.json().warnings).toEqual(preview.json().warnings)
  })

  it('warns that a $page step is expensive, naming the step', async () => {
    const res = await call('POST', '/v1/funnels/preview', signup)
    expect(res.json().warnings.some((w: { path: string }) => w.path === 'steps.0')).toBe(true)
  })

  it('ignores a project_id in the body', async () => {
    const res = await call('POST', '/v1/funnels', {
      name: 'signup',
      project_id: otherProjectId,
      ...signup,
    })
    expect(res.statusCode).toBe(201)
    // By id, not by name: this database is shared with the other funnel
    // suites, and matching on a name as ordinary as `signup` picks up theirs.
    const owned = await pg.query('SELECT project_id FROM funnels WHERE id = $1', [res.json().id])
    expect(Number(owned.rows[0].project_id)).toBe(projectId)
  })

  it('404s a funnel belonging to another project rather than 403ing it', async () => {
    const created = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    const id = created.json().id
    // A 403 would confirm the id exists.
    expect((await call('GET', `/v1/funnels/${id}`, undefined, OTHER_SERVER_KEY)).statusCode).toBe(
      404,
    )
    expect((await call('POST', `/v1/funnels/${id}/run`, {}, OTHER_SERVER_KEY)).statusCode).toBe(404)
  })

  it('rejects a non-numeric id without touching the database', async () => {
    expect((await call('GET', '/v1/funnels/not-a-number')).statusCode).toBe(400)
  })

  // A bare `Number()` + `Number.isInteger()` check accepts all of these —
  // hex (`0x10`), a leading `+`, surrounding whitespace, and exponent
  // notation all coerce to a normal-looking finite integer. Each must be
  // rejected the same way `'not-a-number'` is above, matching the
  // `/^\d+$/`-first convention every `:id` route shares via
  // `numeric-id.ts`'s `parseNumericId`. Zero passes that shape check —
  // it is `id > 0` that rejects it — and is pinned here so a local
  // parser reintroduced without that boundary would be caught.
  it.each([
    ['0x10', 'hex notation'],
    ['+5', 'a leading plus sign'],
    [' 1 ', 'surrounding whitespace'],
    ['1e3', 'exponent notation'],
    ['', 'an empty string'],
    ['-1', 'a negative number'],
    ['0', 'zero'],
    ['1.0', 'a decimal point'],
    ['99999999999999999999', 'a value beyond MAX_SAFE_INTEGER'],
  ])('rejects a funnel id with %s (%s)', async (raw) => {
    const res = await call('GET', `/v1/funnels/${encodeURIComponent(raw)}`)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('invalid_funnel_id')
  })

  it('records the run snapshot, and clears it when the definition changes', async () => {
    const created = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    const id = created.json().id
    await call('POST', `/v1/funnels/${id}/run`, {})
    const afterRun = await call('GET', `/v1/funnels/${id}`)
    expect(afterRun.json().last_evaluated_at).not.toBeNull()
    expect(afterRun.json().last_entered).not.toBeNull()

    await call('PATCH', `/v1/funnels/${id}`, { window_seconds: 3600 })
    const afterPatch = await call('GET', `/v1/funnels/${id}`)
    expect(afterPatch.json().last_evaluated_at).toBeNull()
    expect(afterPatch.json().last_entered).toBeNull()
  })

  it('runs over everyone AND warns when the funnel’s segment is gone', async () => {
    const seg = await pg.query<{ id: string }>(
      `INSERT INTO segments (project_id, name, filter, ast_version)
       VALUES ($1, 'doomed', '{"kind":"trait","key":"plan","operator":"=","value":"x"}'::jsonb, 1)
       RETURNING id`,
      [projectId],
    )
    const segmentId = Number(seg.rows[0]?.id)
    const created = await call('POST', '/v1/funnels', {
      name: 'restricted',
      ...signup,
      segment_id: segmentId,
    })
    await pg.query('DELETE FROM segments WHERE id = $1', [segmentId])

    const res = await call('POST', `/v1/funnels/${created.json().id}/run`, {})
    expect(res.statusCode).toBe(200)
    // The warning is the assertion. The count alone would pass against a
    // silent widening of the population, which is the failure being guarded.
    const warning = res.json().warnings.find((w: { path: string }) => w.path === 'segment_id')
    expect(warning).toBeDefined()
    expect(warning.reason).toContain(String(segmentId))
  })

  it('restricts the population when the segment still exists', async () => {
    const seg = await pg.query<{ id: string }>(
      `INSERT INTO segments (project_id, name, filter, ast_version)
       VALUES ($1, 'live', '{"kind":"trait","key":"plan","operator":"=","value":"x"}'::jsonb, 1)
       RETURNING id`,
      [projectId],
    )
    const created = await call('POST', '/v1/funnels', {
      name: 'restricted-live',
      ...signup,
      segment_id: Number(seg.rows[0]?.id),
    })
    const res = await call('POST', `/v1/funnels/${created.json().id}/run`, {})
    expect(res.statusCode).toBe(200)
    expect(res.json().warnings.some((w: { path: string }) => w.path === 'segment_id')).toBe(false)
    await pg.query('DELETE FROM segments WHERE id = $1', [Number(seg.rows[0]?.id)])
  })

  it('surfaces a stored definition that no longer parses as a named 400', async () => {
    const created = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    await pg.query(`UPDATE funnels SET steps = '[{"evt":"a"},{"evt":"b"}]'::jsonb WHERE id = $1`, [
      created.json().id,
    ])
    const res = await call('GET', `/v1/funnels/${created.json().id}`)
    expect(res.statusCode).toBe(400)
    expect(res.json().definition_version).toBe(FUNNEL_DEFINITION_VERSION)
    // The list still renders, marking the bad row rather than 400ing wholesale.
    const listed = await call('GET', '/v1/funnels')
    expect(listed.statusCode).toBe(200)
    expect(listed.json().funnels[0].stale).toBe(true)
  })

  it('rejects a definition with one step', async () => {
    const res = await call('POST', '/v1/funnels', {
      name: 'one',
      steps: [{ event: 'a' }],
      window_seconds: 60,
    })
    expect(res.statusCode).toBe(400)
  })

  it('reports both rates per step, and step 1 at 100%', async () => {
    // Seeded traffic lives in semantics.test.ts; here the shape is what
    // matters — a caller must never have to multiply a chain of floats.
    const res = await call('POST', '/v1/funnels/preview', {
      steps: [{ event: `never-${randomUUID()}` }, { event: 'nope' }],
      window_seconds: 60,
    })
    const body = res.json()
    expect(body.steps).toHaveLength(2)
    expect(body.steps[0]).toHaveProperty('from_previous')
    expect(body.steps[0]).toHaveProperty('from_start')
    expect(body.conversion_rate).toBe(0)
  })

  // Regression for issue #92's fix: the store now opens a transaction around
  // the read-compare-write in update() (SELECT ... FOR UPDATE, plain BEGIN —
  // see store.ts for why not SERIALIZABLE). A first attempt at that fix used
  // SERIALIZABLE, which measurably turned concurrent PATCHes to one funnel
  // into a wave of 40001 serialization failures surfacing as 503s. This
  // fires 8 concurrent PATCHes at a single funnel through the real route and
  // requires every one of them to succeed — with plain BEGIN + row lock, the
  // second writer onward simply blocks until the first commits rather than
  // aborting, so this is deterministic, not a race the test hopes to win.
  it('serialises, rather than fails, concurrent PATCHes to the same funnel', async () => {
    const created = await call('POST', '/v1/funnels', {
      name: `concurrent-${randomUUID()}`,
      ...signup,
    })
    const id = created.json().id
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call('PATCH', `/v1/funnels/${id}`, { name: `concurrent-renamed-${i}-${randomUUID()}` }),
      ),
    )
    for (const r of results) expect(r.statusCode).toBe(200)
  })
})
