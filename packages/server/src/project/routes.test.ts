import { randomUUID } from 'node:crypto'
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
// A real browser UA, not a bare token -- isBot (ingest/routes.ts) would
// reject anything else before the event ever reaches the counters this
// suite's Step 6 test depends on.
const TRACK_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

let app: FastifyInstance
let PROJECT_ID_A = 0
let PROJECT_ID_B = 0

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

  PROJECT_ID_A = await makeProject(SLUG_A, PROJECT_NAME_A, WRITE_KEY_A, SERVER_KEY_A)
  PROJECT_ID_B = await makeProject(SLUG_B, PROJECT_NAME_B, WRITE_KEY_B, SERVER_KEY_B)
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

describe('PATCH /v1/project', () => {
  it('updates retention and quota', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { retention_months: 6, monthly_event_quota: 1000 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ retention_months: 6, monthly_event_quota: 1000 })
  })

  // null is "unlimited" and 0 is a value isOverQuota refuses to evaluate at
  // all -- it throws, which becomes a 503 on every event of the project.
  // The two must never collapse into each other.
  it('accepts null as unlimited and keeps it distinct from 0', async () => {
    const ok = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { monthly_event_quota: null },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ monthly_event_quota: null })

    const stored = await pg.query<{ monthly_event_quota: string | null }>(
      'SELECT monthly_event_quota FROM projects WHERE slug = $1',
      [SLUG_A],
    )
    expect(stored.rows[0]?.monthly_event_quota).toBeNull()

    const zero = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { monthly_event_quota: 0 },
    })
    expect(zero.statusCode).toBe(400)
  })

  // The schema's own CHECK is BETWEEN 1 AND 120. Letting an out-of-range
  // value through turns a validation error into a Postgres constraint
  // violation, which app.ts's catch-all renders as a 503 outage.
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['too large', 121],
    ['float', 1.5],
  ])('refuses retention_months: %s', async (_n, months) => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { retention_months: months },
    })
    expect(res.statusCode).toBe(400)
  })

  // IMPORTANT 2 from the whole-branch review, proved end to end against a
  // real Postgres before this fix: `1e20` passes `Number.isInteger` (it's
  // exactly representable as a float) but is far outside `bigint`'s range,
  // and Postgres answered "value ... is out of range for type bigint" --
  // rendered by app.ts's catch-all as a `503 unavailable`, indistinguishable
  // from an outage, for what should be an ordinary 400. `1e21` is worse:
  // it serialises as the literal string `"1e+21"`, and Postgres refuses
  // that for a different reason ("invalid input syntax for type bigint"),
  // but the outcome from the caller's side was identically a 503 either
  // way. `.max(Number.MAX_SAFE_INTEGER)` must turn both into a 400 that
  // never reaches Postgres at all.
  it.each([
    ['far outside bigint range but still an integer', 1e20],
    ['serialises as exponential notation', 1e21],
  ])('refuses an unrepresentable monthly_event_quota: %s', async (_name, quota) => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { monthly_event_quota: quota },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses an empty patch rather than silently doing nothing', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: {},
    })
    expect(res.statusCode).toBe(400)
  })

  it('cannot touch another project', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { retention_months: 9 },
    })
    const b = await pg.query<{ retention_months: number }>(
      'SELECT retention_months FROM projects WHERE slug = $1',
      [SLUG_B],
    )
    expect(b.rows[0]?.retention_months).not.toBe(9)
  })

  // ProjectCache holds retentionMonths and monthlyEventQuota for 60s. A
  // write that does not evict it leaves the retention worker and the quota
  // check acting on the old numbers for up to a minute after the API said
  // otherwise.
  it('invalidates the cache, so the new quota is in force immediately', async () => {
    await app.inject({
      method: 'GET',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
    })
    await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { monthly_event_quota: 7 },
    })
    const cached = await app.deps.projects.byServerKey(SERVER_KEY_A)
    expect(cached?.monthlyEventQuota).toBe(7)
  })

  // Invented, beyond the brief's mutation table: every mutation test above
  // proves a value OUTSIDE [1, 120] / OUTSIDE positive is refused, but none
  // proves the two ENDPOINTS of those ranges are actually admitted. A
  // schema mutated to `.min(2)` or `.max(119)` -- an off-by-one in either
  // direction -- would make every existing test in this file still pass,
  // because none of them sends exactly 1 or exactly 120.
  it('accepts retention_months at both boundaries of the CHECK range', async () => {
    const low = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { retention_months: 1 },
    })
    expect(low.statusCode).toBe(200)
    expect(low.json()).toMatchObject({ retention_months: 1 })

    const high = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { retention_months: 120 },
    })
    expect(high.statusCode).toBe(200)
    expect(high.json()).toMatchObject({ retention_months: 120 })
  })

  // Invented, and motivated by the mutation table itself: "bind the WHERE id
  // from a request field instead of project.id" turns out to be unobserved
  // by every test above, including "cannot touch another project" -- that
  // test's own payload never carries an id-shaped field, so a route that
  // read one from raw `req.body` (bypassing PatchBody's parsed output,
  // which strips unknown keys) and fell back to `project.id` only when
  // absent would pass every existing test unchanged. This sends exactly
  // such a field, authenticated as A, naming B -- the one shape that
  // distinguishes "scoped by the authenticated project" from "scoped by
  // whatever the request happened to carry."
  it('ignores an id-shaped field in the body and still scopes to the authenticated project', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { retention_months: 42, id: PROJECT_ID_B },
    })
    expect(res.statusCode).toBe(200)

    const a = await pg.query<{ retention_months: number }>(
      'SELECT retention_months FROM projects WHERE slug = $1',
      [SLUG_A],
    )
    expect(a.rows[0]?.retention_months).toBe(42)

    const b = await pg.query<{ retention_months: number }>(
      'SELECT retention_months FROM projects WHERE slug = $1',
      [SLUG_B],
    )
    expect(b.rows[0]?.retention_months).not.toBe(42)
  })

  // Invented, beyond the brief's mutation table: every quota test above uses
  // either null, 0, or a value far from the positive/zero boundary (7,
  // 1000). None proves that 1 -- the smallest value `isOverQuota` can
  // legally evaluate -- is actually accepted, so a schema mutated to
  // `.min(2)` (rejecting 1 as too small) would pass every other test here.
  // Also proves a PATCH touching only `monthly_event_quota` leaves
  // `retention_months` at its previously stored value, not COALESCE-d into
  // something else -- the two fields must not leak into each other.
  it('accepts a quota of 1, and leaves retention_months untouched by a quota-only patch', async () => {
    const before = await pg.query<{ retention_months: number }>(
      'SELECT retention_months FROM projects WHERE slug = $1',
      [SLUG_A],
    )
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { monthly_event_quota: 1 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      monthly_event_quota: 1,
      retention_months: before.rows[0]?.retention_months,
    })
  })
})

describe('GET /v1/project/usage', () => {
  it('reports this month against the quota', async () => {
    await pg.query(
      `INSERT INTO ingest_counters
         (project_id, month, events_accepted, events_rejected, events_throttled, events_bot)
       VALUES ($1, date_trunc('month', now())::date, 42, 3, 1, 7)
       ON CONFLICT (project_id, month) DO UPDATE
         SET events_accepted = 42, events_rejected = 3, events_throttled = 1, events_bot = 7`,
      [PROJECT_ID_A],
    )
    await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
      payload: { monthly_event_quota: 100 },
    })

    const res = await app.inject({
      method: 'GET',
      url: '/v1/project/usage',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      events_accepted: 42,
      events_rejected: 3,
      events_throttled: 1,
      // Distinct from every other seeded value, so a handler that reported
      // the wrong column would fail rather than coincide.
      events_bot: 7,
      monthly_event_quota: 100,
    })
  })

  // A project's first event of the month has no counter row at all, and
  // that is the ordinary state rather than an error. Number(undefined) is
  // NaN, which serialises to null and would render as a blank usage bar.
  it('reports zeroes when no counter row exists yet', async () => {
    await pg.query('DELETE FROM ingest_counters WHERE project_id = $1', [PROJECT_ID_B])
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project/usage',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_B },
    })
    expect(res.json()).toMatchObject({
      events_accepted: 0,
      events_rejected: 0,
      events_throttled: 0,
      events_bot: 0,
    })
  })

  it('reports an unlimited project as null, not 0', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/v1/project',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_B },
      payload: { monthly_event_quota: null },
    })
    const res = await app.inject({
      method: 'GET',
      url: '/v1/project/usage',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_B },
    })
    expect((res.json() as { monthly_event_quota: unknown }).monthly_event_quota).toBeNull()
  })

  // The brief's Step 6: proves the figure is a real, live count and not a
  // fixture this endpoint happens to return. Every test above only ever
  // reads a hand-inserted `ingest_counters` row, which cannot distinguish
  // this endpoint from one that returns its own constant -- posting a real
  // event through ingest, forcing a flush, and asserting the count moved by
  // exactly one is the only thing that can.
  it('reflects a real event posted through ingest, after a counter flush', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/v1/project/usage',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
    })
    const beforeAccepted = (before.json() as { events_accepted: number }).events_accepted

    const track = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': WRITE_KEY_A, 'user-agent': TRACK_UA },
      payload: { message_id: randomUUID(), anonymous_id: 'usage-real-event', event: 'usage_probe' },
    })
    expect(track.statusCode).toBe(202)

    await app.deps.counters.flush()

    const after = await app.inject({
      method: 'GET',
      url: '/v1/project/usage',
      headers: { 'x-lyraflow-server-key': SERVER_KEY_A },
    })
    expect((after.json() as { events_accepted: number }).events_accepted).toBe(beforeAccepted + 1)
  })
})
