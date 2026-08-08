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

// Two genuinely contending projects, same shape as person.test.ts's fixture —
// needed below to make the tenancy test fail for the right reason (see the
// comment on that test) rather than passing vacuously because only one
// project exists.
const SLUG_A = 'schema-routes-test-a'
const SLUG_B = 'schema-routes-test-b'
const WRITE_KEY_A = 'wk_schema_routes_a'
const SERVER_KEY_A = 'sk_schema_routes_a'
const WRITE_KEY_B = 'wk_schema_routes_b'
const SERVER_KEY_B = 'sk_schema_routes_b'

let app: FastifyInstance
let projectA: number
let projectB: number

const get = (url: string, key = SERVER_KEY_A) =>
  app.inject({ method: 'GET', url, headers: { 'x-lyraflow-server-key': key } })

async function makeProject(slug: string, name: string, writeKey: string, serverKey: string) {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, writeKey, hashServerKey(serverKey)],
  )
  return Number(r.rows[0]?.id)
}

/**
 * Reads event_schema straight back for one (project, event) pair. Used only
 * to make the materialised-view timing in beforeAll an explicit, checked
 * fact rather than an assumption — see the comment there.
 */
async function schemaHasEvent(projectId: number, eventName: string): Promise<boolean> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM event_schema
             WHERE project_id = {projectId:UInt32} AND event_name = {eventName:String}`,
    query_params: { projectId, eventName },
    format: 'JSONEachRow',
  })
  const [row] = await rs.json<{ c: string }>()
  return Number(row?.c ?? 0) > 0
}

/**
 * Cleans BOTH ClickHouse tables this file writes — `events` and
 * `event_schema` — for its own two projects, looked up by slug rather than
 * trusting `projectA`/`projectB` (unset, or stale from a previous run in the
 * same process, the first time this runs at the top of `beforeAll`).
 * Run at the TOP of `beforeAll`, not only in `afterAll`, per the branch's
 * live-database rule: `makeProject` gives each run a FRESH Postgres id, so a
 * crashed prior run's own `events`/`event_schema` rows sitting under its OLD
 * id are otherwise invisible forever — right up until Postgres's `bigserial`
 * eventually reissues that exact number to some LATER, unrelated project,
 * at which point its stale rows reappear as that new project's own data.
 * That is precisely the leak this file's own "does not leak another
 * project's event taxonomy" test exists to catch, and precisely what caused
 * privacy/end-to-end.test.ts to see a one-off, unreproducible failure here
 * (Task 10's report) before this fix: `event_schema` had no cleanup at all,
 * only `events` did, in the OLD `afterAll`-only version of this cleanup.
 */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = ANY($1)', [
    [SLUG_A, SLUG_B],
  ])
  const ids = existing.rows.map((r) => Number(r.id))
  if (ids.length > 0) {
    await ch.command({ query: `ALTER TABLE events DELETE WHERE project_id IN (${ids.join(',')})` })
    await ch.command({
      query: `ALTER TABLE event_schema DELETE WHERE project_id IN (${ids.join(',')})`,
    })
  }
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await cleanup()

  projectA = await makeProject(SLUG_A, 'SchemaRoutesA', WRITE_KEY_A, SERVER_KEY_A)
  projectB = await makeProject(SLUG_B, 'SchemaRoutesB', WRITE_KEY_B, SERVER_KEY_B)

  // All rows in one insert: event_schema is fed by event_schema_str_mv /
  // event_schema_num_mv (002_events.sql), materialised views attached
  // directly to `events` with no async_insert setting anywhere in this
  // client or the test compose file. ClickHouse executes such views
  // synchronously as part of the INSERT itself — the same guarantee
  // packages/db/src/migrations/004.test.ts already relies on for
  // person_traits, inserting and reading straight back with no wait. That
  // makes this deterministic rather than merely usually-fast, but the
  // schemaHasEvent() checks below still verify it landed instead of taking
  // it on faith, so a violation of that guarantee fails loudly in beforeAll
  // with a clear cause, rather than as a confusing, order-dependent
  // assertion failure inside one of the `it` blocks further down.
  //
  // Project A gets a SECOND event, import_finished/duration, distinct from
  // import_started's source/rows — needed so the properties route's `event`
  // filter is actually observable (one event per project can't tell
  // "filtered to this event" apart from "not filtered at all"). Project B's
  // existing plan/string property already gives the properties route its
  // own tenancy fixture, reused rather than duplicated below.
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: projectA,
        event_id: '78000000-0000-4000-8000-000000000001',
        anonymous_id: 'dev',
        user_id: 'u',
        event_name: 'import_started',
        timestamp: '2026-08-01 00:00:00.000',
        received_at: '2026-08-01 00:00:00.000',
        trusted: 1,
        properties: { source: 'csv' },
        properties_num: { rows: 10 },
      },
      {
        project_id: projectA,
        event_id: '78000000-0000-4000-8000-000000000003',
        anonymous_id: 'dev',
        user_id: 'u',
        event_name: 'import_finished',
        timestamp: '2026-08-01 00:05:00.000',
        received_at: '2026-08-01 00:05:00.000',
        trusted: 1,
        properties: {},
        properties_num: { duration: 42 },
      },
      {
        project_id: projectB,
        event_id: '78000000-0000-4000-8000-000000000002',
        anonymous_id: 'dev-b',
        user_id: 'u-b',
        event_name: 'billing_plan_changed',
        timestamp: '2026-08-01 00:00:00.000',
        received_at: '2026-08-01 00:00:00.000',
        trusted: 1,
        properties: { plan: 'pro' },
        properties_num: {},
      },
    ],
  })

  if (!(await schemaHasEvent(projectA, 'import_started'))) {
    throw new Error(
      "event_schema has no row for project A's import_started event immediately " +
        'after insert — the materialised views are not synchronous in this environment; ' +
        'see the comment above this insert.',
    )
  }
  if (!(await schemaHasEvent(projectA, 'import_finished'))) {
    throw new Error(
      "event_schema has no row for project A's import_finished event immediately " +
        'after insert — the materialised views are not synchronous in this environment; ' +
        'see the comment above this insert.',
    )
  }
  if (!(await schemaHasEvent(projectB, 'billing_plan_changed'))) {
    throw new Error(
      "event_schema has no row for project B's billing_plan_changed event immediately " +
        'after insert — the materialised views are not synchronous in this environment; ' +
        'see the comment above this insert.',
    )
  }

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

describe('schema reads', () => {
  it('lists event names', async () => {
    const res = await get('/v1/schema/events')
    expect(res.statusCode).toBe(200)
    expect(res.json().events.map((e: { event_name: string }) => e.event_name)).toContain(
      'import_started',
    )
  })

  it('filters by prefix', async () => {
    expect((await get('/v1/schema/events?q=import')).json().events.length).toBeGreaterThan(0)
    expect((await get('/v1/schema/events?q=zzzz')).json().events).toEqual([])
  })

  it('lists property keys with their value kind', async () => {
    const res = await get('/v1/schema/properties?event=import_started')
    const keys = res.json().properties
    expect(keys).toContainEqual({ property_key: 'rows', value_kind: 'number' })
    expect(keys).toContainEqual({ property_key: 'source', value_kind: 'string' })
  })

  // The brief this suite was transcribed from asserted 200 + a capped
  // events.length here, on the theory that an over-cap `limit` gets silently
  // clamped. It does not: Query's `.max(SCHEMA_MAX_LIMIT)` is a Zod
  // validation bound on a coerced number, which REJECTS a value above it
  // rather than clamping it — confirmed by actually running that assertion
  // against the transcribed implementation, which answers 400, not 200 (see
  // task-12-report.md). A 400 still satisfies "a caller must not be able to
  // exceed [the cap]" — the request is refused outright — so this asserts
  // the real, and still bounded, behaviour instead. It is also independent
  // of how many rows the fixture happens to hold (a length-based assertion
  // is not: this fixture's single project-scoped event never gets near 100
  // rows regardless of what SCHEMA_MAX_LIMIT is, so a clamp-based version of
  // this test could not have told a real cap from none at all).
  it('rejects a limit above the cap', async () => {
    const res = await get('/v1/schema/events?limit=99999')
    expect(res.statusCode).toBe(400)
  })

  it('requires the server key', async () => {
    // A genuine, issued key — just the wrong one for this header. Sent as
    // `x-lyraflow-server-key`, it cannot match any project's
    // server_key_hash, so the correct implementation answers
    // invalid_server_key.
    const res = await get('/v1/schema/events', WRITE_KEY_A)
    expect(res.statusCode).toBe(401)
    // Not just the status. If the route's guard were mutated to check
    // WRITE_KEY_HEADER/byWriteKey instead of the server-key header, this
    // request (still sent under `x-lyraflow-server-key`, per the `get()`
    // helper above) would carry no header the mutated guard looks for at
    // all — so it would 401 for the *different* reason
    // `missing_server_key`, and the status stays 401 either way. Asserting
    // the exact code is what makes this test catch that mutation; a
    // status-only assertion would pass against a route that happily
    // accepted write keys.
    expect(res.json().error).toBe('invalid_server_key')
  })

  // THE test for project scoping. Was, in the brief this task started from,
  // a request that only checked the response was a 200 — which cannot fail
  // no matter what the query's WHERE clause does, since the fixture used to
  // have only one project. With project B's distinct 'billing_plan_changed'
  // event actually in ClickHouse, an unscoped query (project_id dropped from
  // the events route) returns it in project A's own list — a leak of
  // another tenant's product taxonomy, which is exactly what makes this
  // endpoint server-key gated in the first place.
  it("does not leak another project's event taxonomy", async () => {
    const res = await get('/v1/schema/events', SERVER_KEY_A)
    expect(res.statusCode).toBe(200)
    const names = res.json().events.map((e: { event_name: string }) => e.event_name)
    expect(names).toContain('import_started')
    expect(names).not.toContain('billing_plan_changed')
  })

  // THE test for project scoping on the PROPERTIES route specifically —
  // distinct from the events-route tenancy test above, and needed because
  // that one exercises a different query in routes.ts entirely. No `event`
  // or `q` filter, so this is scoped by project_id alone: an exact array
  // (not toContain) is what actually fails when project_id is dropped,
  // since a dropped filter doesn't just add 'plan' — with the full suite's
  // other fixtures sharing the same ClickHouse database (each under its own
  // project id), it pulls in whatever every other test file's project has
  // recorded too. Ordered by property_key ASC, matching the route's
  // ORDER BY.
  it("does not leak another project's property keys", async () => {
    const res = await get('/v1/schema/properties')
    expect(res.statusCode).toBe(200)
    expect(res.json().properties).toEqual([
      { property_key: 'duration', value_kind: 'number' },
      { property_key: 'rows', value_kind: 'number' },
      { property_key: 'source', value_kind: 'string' },
    ])
  })

  // THE test for the `event` filter clause. The existing "lists property
  // keys" test above only ever queries `event=import_started` and uses
  // toContainEqual, which is a subset check — it would still pass even if
  // the filter clause were deleted and 'duration' (import_finished's own
  // property, added to the fixture above for exactly this reason) leaked
  // in alongside 'rows'/'source'. This asserts the full, exact set for each
  // of project A's two events, so an extra or missing key fails it.
  it('filters properties by event', async () => {
    const started = await get('/v1/schema/properties?event=import_started')
    expect(started.json().properties).toEqual([
      { property_key: 'rows', value_kind: 'number' },
      { property_key: 'source', value_kind: 'string' },
    ])

    const finished = await get('/v1/schema/properties?event=import_finished')
    expect(finished.json().properties).toEqual([{ property_key: 'duration', value_kind: 'number' }])
  })

  // THE test for the `q` prefix filter clause. Unfiltered by event, so the
  // in-scope set is project A's full three keys (duration, rows, source);
  // 'sou' narrows to exactly 'source', and a prefix matching nothing must
  // come back empty rather than falling through to the unfiltered set —
  // mirrors the events route's own prefix test above.
  it('filters properties by q prefix', async () => {
    const matched = await get('/v1/schema/properties?q=sou')
    expect(matched.json().properties).toEqual([{ property_key: 'source', value_kind: 'string' }])

    const unmatched = await get('/v1/schema/properties?q=zzzz')
    expect(unmatched.json().properties).toEqual([])
  })
})
