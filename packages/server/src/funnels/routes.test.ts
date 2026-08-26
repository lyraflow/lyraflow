import { createHmac, randomUUID } from 'node:crypto'
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

/**
 * Hand-builds a validly SIGNED wire cursor under an arbitrary label, without
 * reaching into the route module at all -- it recomputes exactly what
 * `makeWalkCursorCodec` (walk-cursor.ts) would produce from public inputs
 * (the label) and one value the server already keeps
 * (`hashServerKey(SERVER_KEY)`, the same `project.serverKeyHash` the route
 * resolves via `authenticate`). Same technique as `segments/routes.test.ts`'s
 * `signedWireCursor`, parameterised over the label so this file can mint a
 * cursor under EITHER route's label and prove the other route refuses it --
 * not because it is malformed, but because the label does not match.
 */
function signedWireCursor(
  label: string,
  lastSeen: string,
  personId: string,
  asOf: string,
  pagesServed: number,
): string {
  const key = createHmac('sha256', hashServerKey(SERVER_KEY)).update(label).digest()
  const payload = JSON.stringify([lastSeen, personId, asOf, pagesServed])
  const signature = createHmac('sha256', key).update(payload).digest('base64url')
  return Buffer.from(JSON.stringify([lastSeen, personId, asOf, pagesServed, signature])).toString(
    'base64url',
  )
}

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

  it('accepts the 90-day maximum asked for as a relative range', async () => {
    // Reported from the UI: picking "Last 90 days" and pressing Run answered
    // `the range may span at most 90 days`, for every user, every time.
    //
    // The cap is not the bug -- `validateRange` uses `>`, so a span of
    // exactly 90 days is legal. The bug was that the two ends of the range
    // came from two different clocks. A client expressing "the last 90 days"
    // could only say `since: <its own now> - 90d` and let `until` default,
    // and the default is the SERVER's now, which is strictly later by at
    // least the request's own flight time. The span was therefore always
    // 90 days plus a few milliseconds, and a few milliseconds over a hard
    // maximum is over it.
    //
    // `days` states the relative range as a relative range, so both ends
    // are derived from one reading of one clock.
    const created = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    const res = await call('POST', `/v1/funnels/${created.json().id}/run`, { days: 90 })
    expect(res.statusCode).toBe(200)
    const { since, until } = res.json().range
    expect(new Date(until).getTime() - new Date(since).getTime()).toBe(90 * 86_400_000)
  })

  it('still rejects a range that genuinely exceeds the maximum', async () => {
    // The fix must not become a way around the cap. 91 is refused whichever
    // way it is spelled.
    const created = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    const id = created.json().id
    const relative = await call('POST', `/v1/funnels/${id}/run`, { days: 91 })
    expect(relative.statusCode).toBe(400)
    expect(relative.json().error).toMatch(/at most 90 days/)

    const absolute = await call('POST', `/v1/funnels/${id}/run`, {
      since: '2026-01-01T00:00:00.000Z',
      until: '2026-06-01T00:00:00.000Z',
    })
    expect(absolute.statusCode).toBe(400)
  })

  it('refuses a relative range mixed with an absolute one rather than picking a winner', async () => {
    // Either could reasonably be meant. A silent precedence rule is how a
    // caller ends up reading a window it did not ask for and cannot see it
    // did not ask for.
    const created = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    const res = await call('POST', `/v1/funnels/${created.json().id}/run`, {
      days: 30,
      since: '2026-08-07T00:00:00.000Z',
    })
    expect(res.statusCode).toBe(400)
  })

  it('reads the clock once, so the two ends of a relative range cannot disagree', async () => {
    // The whole defect in one property. Two ends derived from two readings
    // differ by however long passed between them; the assertion below is
    // exact rather than approximate precisely because one reading cannot
    // drift from itself.
    //
    // 13, not 7: 7 is the default this route falls back to when it does not
    // understand the body at all, so a test using it passes just as well
    // against a build that ignores `days` entirely -- which is exactly what
    // it did before the fix.
    const created = await call('POST', '/v1/funnels', { name: 'signup', ...signup })
    const res = await call('POST', `/v1/funnels/${created.json().id}/run`, { days: 13 })
    const { since, until } = res.json().range
    expect(new Date(until).getTime() - new Date(since).getTime()).toBe(13 * 86_400_000)
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

describe('funnel people route', () => {
  it('returns 200 with members, next_cursor, window_exhausted and person_count', async () => {
    const created = await call('POST', '/v1/funnels', { name: `people-${randomUUID()}`, ...signup })
    const res = await call('POST', `/v1/funnels/${created.json().id}/people`, {
      step: 1,
      mode: 'reached',
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(Array.isArray(body.members)).toBe(true)
    expect(body).toHaveProperty('next_cursor')
    expect(body).toHaveProperty('window_exhausted')
    expect(typeof body.person_count).toBe('number')
  })

  it('requires mode -- a missing mode is a 400, not a default population', async () => {
    // The two populations differ by a factor of three on a real funnel;
    // whichever way a default fell, the other reading is what a caller who
    // forgot `mode` would get by accident.
    const created = await call('POST', '/v1/funnels', {
      name: `people-no-mode-${randomUUID()}`,
      ...signup,
    })
    const res = await call('POST', `/v1/funnels/${created.json().id}/people`, { step: 1 })
    expect(res.statusCode).toBe(400)
  })

  it('rejects an unrecognised mode', async () => {
    const created = await call('POST', '/v1/funnels', {
      name: `people-bad-mode-${randomUUID()}`,
      ...signup,
    })
    const res = await call('POST', `/v1/funnels/${created.json().id}/people`, {
      step: 1,
      mode: 'sideways',
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a step outside the funnel, naming the valid range', async () => {
    // `signup` has 2 steps. Step 0 fails Zod's `positive()` before the route
    // ever sees it (same as `/dropoff`'s own `step`), so it 400s generically;
    // step 3 reaches the route's own range check, which must name the range
    // the same way `/dropoff`'s does -- a 0-indexed caller would otherwise
    // silently read step 3's people as step 2's.
    const created = await call('POST', '/v1/funnels', {
      name: `people-range-${randomUUID()}`,
      ...signup,
    })
    const id = created.json().id
    const zero = await call('POST', `/v1/funnels/${id}/people`, { step: 0, mode: 'reached' })
    expect(zero.statusCode).toBe(400)
    const tooHigh = await call('POST', `/v1/funnels/${id}/people`, { step: 3, mode: 'reached' })
    expect(tooHigh.statusCode).toBe(400)
    expect(tooHigh.json().error).toBe('step must be between 1 and 2')
  })

  it('rejects a cursor minted by the other route, in both directions, and accepts its own', async () => {
    const created = await call('POST', '/v1/funnels', {
      name: `people-cursor-${randomUUID()}`,
      ...signup,
    })
    const id = created.json().id
    const asOf = new Date().toISOString()
    const peopleCursor = signedWireCursor(
      'lyraflow.funnel-people-cursor.v1',
      '2026-08-01 00:00:00.000',
      'p1',
      asOf,
      0,
    )
    const dropoffCursor = signedWireCursor(
      'lyraflow.funnel-dropoff-cursor.v1',
      '2026-08-01 00:00:00.000',
      'p1',
      asOf,
      0,
    )

    // A /people cursor replayed against /dropoff...
    const peopleOnDropoff = await call('POST', `/v1/funnels/${id}/dropoff`, {
      step: 1,
      cursor: peopleCursor,
    })
    expect(peopleOnDropoff.statusCode).toBe(400)

    // ...and a /dropoff cursor replayed against /people. Both directions,
    // because a codec shared by accident in either direction would only
    // fail one of these two assertions.
    const dropoffOnPeople = await call('POST', `/v1/funnels/${id}/people`, {
      step: 1,
      mode: 'reached',
      cursor: dropoffCursor,
    })
    expect(dropoffOnPeople.statusCode).toBe(400)

    // Each cursor IS valid on its own route -- proving the 400s above are
    // about the label, not about the cursor being malformed in general (if
    // the codecs were shared, all four of these calls would return 200).
    const ownDropoff = await call('POST', `/v1/funnels/${id}/dropoff`, {
      step: 1,
      cursor: dropoffCursor,
    })
    expect(ownDropoff.statusCode).toBe(200)
    const ownPeople = await call('POST', `/v1/funnels/${id}/people`, {
      step: 1,
      mode: 'reached',
      cursor: peopleCursor,
    })
    expect(ownPeople.statusCode).toBe(200)
  })

  it("leaves /dropoff's response body exactly as it was", async () => {
    const created = await call('POST', '/v1/funnels', {
      name: `dropoff-shape-${randomUUID()}`,
      ...signup,
    })
    const res = await call('POST', `/v1/funnels/${created.json().id}/dropoff`, { step: 1 })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    // The exact key set, not merely a 200 -- a shared query path (`/people`
    // now compiles through the same `compileFor`) is exactly the thing that
    // grows a response an extra key by accident.
    expect(Object.keys(body).sort()).toEqual(
      ['as_of', 'next_cursor', 'people', 'range', 'step', 'window_exhausted'].sort(),
    )
    expect(Array.isArray(body.people)).toBe(true)
    // No seeded ClickHouse rows in this file (see semantics.test.ts for
    // that) -- a row's own shape, with real data, is pinned there.
  })
})

/** A stored funnel with the given steps, returning its id. */
const created = async (steps: object[]): Promise<number> => {
  const res = await call('POST', '/v1/funnels', {
    name: `opt-${randomUUID()}`,
    steps,
    window_seconds: 3600,
  })
  expect(res.statusCode).toBe(201)
  return res.json().id
}
const OPT = [{ event: 'a' }, { event: 'b', optional: true }, { event: 'c' }]

describe('people at an optional step', () => {
  it('accepts mode `skipped` on an optional step', async () => {
    const id = await created(OPT)
    const res = await call('POST', `/v1/funnels/${id}/people`, {
      step: 2,
      mode: 'skipped',
      days: 7,
    })
    expect(res.statusCode).toBe(200)
  })

  it('refuses mode `dropped` on an optional step', async () => {
    // "stopped exactly at a step that is not on the chain" is not a
    // population, and a caller shown one would read it as `skipped`.
    const id = await created(OPT)
    const res = await call('POST', `/v1/funnels/${id}/people`, {
      step: 2,
      mode: 'dropped',
      days: 7,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('mode')
  })

  it('refuses mode `skipped` on a required step', async () => {
    const id = await created(OPT)
    const res = await call('POST', `/v1/funnels/${id}/people`, {
      step: 3,
      mode: 'skipped',
      days: 7,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('mode')
  })

  it('refuses /dropoff on an optional step', async () => {
    // The route hard-codes `mode: 'dropped'`, so without this it would
    // answer a different question rather than refuse.
    const id = await created(OPT)
    const res = await call('POST', `/v1/funnels/${id}/dropoff`, { step: 2, days: 7 })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('mode')
  })

  it('still serves /dropoff on a required step of the same funnel', async () => {
    const id = await created(OPT)
    const res = await call('POST', `/v1/funnels/${id}/dropoff`, { step: 3, days: 7 })
    expect(res.statusCode).toBe(200)
  })

  it('rejects an optional first step at create', async () => {
    const res = await call('POST', '/v1/funnels', {
      name: 'bad-optional-first',
      steps: [{ event: 'a', optional: true }, { event: 'b' }],
      window_seconds: 3600,
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().code).toBe('steps')
  })

  it('marks the optional step in a run response', async () => {
    const id = await created(OPT)
    const res = await call('POST', `/v1/funnels/${id}/run`, { days: 7 })
    expect(res.statusCode).toBe(200)
    const steps = res.json().steps
    expect(steps[1].optional).toBe(true)
    expect(typeof steps[1].skipped).toBe('number')
    expect(steps[0].optional).toBeUndefined()
    expect(steps[2].optional).toBeUndefined()
  })
})
