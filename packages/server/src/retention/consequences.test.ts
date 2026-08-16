// The consequence nobody asked for, pinned live: dropping `device_index`
// partitions removes a person from the segment BASE population, because
// `base.last_seen` (packages/core/src/segments/base.ts) is derived from it —
// not from `events` directly, and not from `person_traits` at all. That is
// correct (they are past retention), but it is a real semantic change, and
// this file is what stops a later change quietly reverting or forgetting it.
//
// The other half of the same scope decision, pinned in the same file: events
// age out, identity survives. `person_traits` (ClickHouse) and
// `identity_bindings` (Postgres) are never touched by RetentionStore —
// RETENTION_TABLES names exactly `['events', 'device_index']` — so a person
// past retention keeps their traits and their identity links, physically,
// even though every route that could hand them back is gone. Asserted
// through the real HTTP surface, not by reading tables directly, for the
// count and the person/events reads; storage is read directly ONLY to prove
// the traits and identity rows really do survive, which no route can show.
//
// GET /v1/persons/:id and GET /v1/persons/:id/export both 404 for a fully
// expired person — NOT a 200 with a traits-only body. `export.ts` and
// `person.ts` both decide existence from `personEventSummary`, which counts
// EVENTS only; retention drops every event a person has, so both routes 404
// identically to an id that was never recorded. That is filed as
// lyraflow#37 — this test pins it as today's real behaviour, it does not fix
// it. See retention/wiring.test.ts for the identical claim on a single
// fixture; this file adds the segment-population and event-feed halves
// alongside it, and its own independent fixtures.
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { IdentityBindings } from '../identity/bindings.js'
import { RETENTION_TABLES } from './store.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)
const bindings = new IdentityBindings(pg)

const SLUG = 'retention-consequences'
const SERVER_KEY = 'sk_ret_consequences'

const EXPIRED_USER = 'consequences-expired-user'
const EXPIRED_DEVICE = 'consequences-expired-device'
const RECENT_USER = 'consequences-recent-user'
const RECENT_DEVICE = 'consequences-recent-device'
const RETENTION_MONTHS = 13

let projectId: number
let app: FastifyInstance

// Captured once, from the real process clock, when this file loads —
// `dropExpired` refuses any `now` more than a day from it (see store.ts), so
// every fixture below is anchored relative to this value rather than a fixed
// literal that would eventually drift out of that window.
const NOW = new Date()

/** Mirrors store.test.ts's/wiring.test.ts's own `monthsAgo` — see either for the day-clamp reasoning. */
function monthsAgo(n: number): string {
  const day = Math.min(15, NOW.getUTCDate())
  return new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - n, day)).toISOString()
}

const chAt = (iso: string) => iso.replace('T', ' ').replace('Z', '')

let seedCounter = 0
const eventId = () => {
  seedCounter += 1
  // Distinct prefix from store.test.ts (re000000-/fe000000-) and
  // wiring.test.ts (fe200000-) — this file shares the same ClickHouse
  // database with the rest of the suite.
  return `fe300000-0000-4000-8000-${String(seedCounter).padStart(12, '0')}`
}

/**
 * A person whose entire history sits `monthsAgoN` months in the past — well
 * past `RETENTION_MONTHS` — one `track` event and one `$identify` carrying a
 * trait, both on `device`. Mirrors wiring.test.ts's
 * `seedFullyExpiredPersonWithTraits`, with its own fixtures.
 */
async function seedPerson(userId: string, device: string, monthsAgoN: number): Promise<void> {
  const ts = chAt(monthsAgo(monthsAgoN))
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: projectId,
        event_id: eventId(),
        anonymous_id: device,
        user_id: userId,
        event_name: 'page_viewed',
        timestamp: ts,
        received_at: ts,
        trusted: 1,
        properties: {},
        properties_num: {},
      },
      {
        project_id: projectId,
        event_id: eventId(),
        anonymous_id: device,
        user_id: userId,
        // Matches ingest/row.ts's own eventName() for an identify payload —
        // this insert bypasses ingest entirely, straight into ClickHouse, so
        // the literal has to be matched by hand.
        event_name: '$identify',
        timestamp: ts,
        received_at: ts,
        trusted: 1,
        properties: { plan: 'gold' },
        properties_num: {},
      },
    ],
  })
}

async function wipePartitions(pid: number): Promise<void> {
  for (const table of RETENTION_TABLES) {
    const rs = await ch.query({
      query: `SELECT DISTINCT partition FROM system.parts
              WHERE database = currentDatabase() AND table = {table:String} AND active`,
      query_params: { table },
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ partition: string }>()
    for (const row of rows) {
      const match = /^\((\d+),(\d+)\)$/.exec(row.partition)
      if (!match) continue
      const [, pidText, monthText] = match
      if (Number(pidText) !== pid) continue
      await ch.command({
        query: `ALTER TABLE ${table} DROP PARTITION tuple({p:UInt32}, {m:UInt32})`,
        query_params: { p: pid, m: Number(monthText) },
      })
    }
  }
}

/** `person_traits` is NOT in RETENTION_TABLES — that is the whole point of this file — so it needs its own wipe. */
async function wipeTraits(pid: number): Promise<void> {
  await ch.command({
    query: 'ALTER TABLE person_traits DELETE WHERE project_id = {p:UInt32}',
    query_params: { p: pid },
    clickhouse_settings: { mutations_sync: '1' },
  })
}

/**
 * Run at the TOP of beforeAll, not only in afterAll, per the branch's
 * live-database rule — a previous crashed run can never leave rows this run
 * trips over. `identity_bindings` needs no explicit wipe: it carries
 * `ON DELETE CASCADE` on `project_id` (003_identity.sql), so deleting the
 * project row below removes it automatically.
 */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [SLUG])
  for (const row of existing.rows) {
    const id = Number(row.id)
    await wipePartitions(id)
    await wipeTraits(id)
  }
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
}

const preview = (body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/segments/preview',
    headers: { 'content-type': 'application/json', 'x-lyraflow-server-key': SERVER_KEY },
    payload: body as never,
  })

/**
 * A "presence" filter in the sense the brief means it: true for anyone with
 * ANY recorded activity, real caller intent absent. `last_seen` is `base`'s
 * own column (segments/base.ts), itself derived entirely from
 * `device_index` — so this filter's count is a direct read of segment BASE
 * POPULATION membership, not of any trait or behaviour a person's data might
 * still satisfy after retention.
 */
const PRESENCE_FILTER = {
  ast_version: 1,
  filter: {
    kind: 'lifecycle',
    field: 'last_seen',
    operator: '>=',
    value: '1970-01-02T00:00:00.000Z',
  },
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await cleanup()

  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash, retention_months)
     VALUES ('Retention Consequences', $1, 'wk_ret_consequences', $2, $3) RETURNING id`,
    [SLUG, hashServerKey(SERVER_KEY), RETENTION_MONTHS],
  )
  projectId = Number(r.rows[0]?.id)

  // A real identity link for the expired person — proof that "identity
  // survives" is checked against a row that actually exists, not merely
  // against the absence of a table retention could have touched.
  await bindings.bind(projectId, EXPIRED_DEVICE, EXPIRED_USER, new Date(monthsAgo(14)))

  await seedPerson(EXPIRED_USER, EXPIRED_DEVICE, 14)
  await seedPerson(RECENT_USER, RECENT_DEVICE, 0)

  const config = loadConfig({
    LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
  } as NodeJS.ProcessEnv)

  const readiness = new Readiness()
  readiness.markReady()
  // buildApp never starts the retention worker's own timer (see app.ts) —
  // this file drives it itself, through `app.deps.retention.runOnce()`,
  // exactly like wiring.test.ts, never through a private `RetentionStore` of
  // its own (see the mutation site below for why that distinction matters
  // for lyraflow#38).
  app = buildApp({ config, pg, ch, readiness })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  await cleanup()
  await pg.end()
  await ch.close()
})

describe('retention consequences: base population, traits, identity', () => {
  it('pins the whole scope decision live', async () => {
    const headers = { 'x-lyraflow-server-key': SERVER_KEY }

    // --- Sanity, before retention runs: both people are ordinary, present,
    // retrievable profiles with real events. Without this, a bug that
    // dropped BOTH people (or neither) could still pass the after-only
    // assertions below by accident.
    const beforeExpired = await app.inject({
      method: 'GET',
      url: `/v1/persons/${EXPIRED_USER}`,
      headers,
    })
    expect(beforeExpired.statusCode).toBe(200)
    expect(beforeExpired.json().events).toBeGreaterThan(0)

    const beforePreview = await preview(PRESENCE_FILTER)
    expect(beforePreview.statusCode).toBe(200)
    expect(beforePreview.json().person_count).toBe(2)

    const beforeFeed = await app.inject({
      method: 'GET',
      url: `/v1/events?person=${EXPIRED_USER}&since=${encodeURIComponent(monthsAgo(20))}`,
      headers,
    })
    expect(beforeFeed.statusCode).toBe(200)
    expect(beforeFeed.json().events.length).toBeGreaterThan(0)

    // --- The mutation under test. Driven through `app.deps.retention` (the
    // real `RetentionWorker` `buildApp` wires in app.ts), NOT a private
    // `new RetentionStore(...)` — wiring.test.ts's own header comment
    // already flags exactly this: a test that constructs its own store
    // bypasses app.ts's wiring entirely and cannot see anything wired
    // there, including the segment-cache invalidation this file exists to
    // pin (lyraflow#38). `runOnce()` sweeps every project in the shared test
    // database — the same "whole-database sweep" wiring.test.ts's own
    // comment describes — so the drop is confirmed by filtering the real
    // "retention dropped partition" log line down to this project's id,
    // rather than by a per-call return value `runOnce()` does not expose.
    const infoSpy = vi.spyOn(app.log, 'info')
    await app.deps.retention.runOnce()
    const dropLinesForProject = infoSpy.mock.calls.filter(
      (call): call is [Record<string, unknown>, string] =>
        call[1] === 'retention dropped partition' &&
        (call[0] as Record<string, unknown>).projectId === projectId,
    )
    expect(dropLinesForProject.length).toBeGreaterThan(0)
    infoSpy.mockRestore()

    // No explicit `segmentCache.clearProject()` here (lyraflow#38 fixed
    // this): the `runOnce()` call above goes through the real, wired
    // `RetentionStore` (app.ts), whose `onDrop` hook now clears this
    // project's segment cache entries itself the instant a partition
    // actually drops — the same production path `DELETE /v1/persons/:id`
    // uses, not a test-only shortcut. The `beforePreview` call above cached
    // this exact filter's count under its 30s TTL; if retention's own
    // invalidation regressed, that entry would still be live here and every
    // assertion below would pass against a stale, pre-drop count instead of
    // exercising retention's real, immediate effect.
    //
    // --- Consequence 1: the expired person no longer counts in the segment
    // BASE population, and the recent person still does. This is the
    // assertion Step 3's mutation (skipping device_index in
    // RETENTION_TABLES) must break — see this file's own history/PR for the
    // recorded before/after run.
    const afterPreview = await preview(PRESENCE_FILTER)
    expect(afterPreview.statusCode).toBe(200)
    expect(afterPreview.json().person_count).toBe(1)

    const afterMembers = await preview({ ...PRESENCE_FILTER, include: ['members'] })
    expect(afterMembers.statusCode).toBe(200)
    const memberIds = afterMembers.json().members.map((m: { person_id: string }) => m.person_id)
    expect(memberIds).toContain(RECENT_USER)
    expect(memberIds).not.toContain(EXPIRED_USER)

    // --- Consequence 2: both the profile read and the export 404 for the
    // expired person — NOT a 200 with a traits-only body (the brief's own
    // claim here does not hold against the real routes; see this file's
    // header comment and lyraflow#37).
    const afterRead = await app.inject({
      method: 'GET',
      url: `/v1/persons/${EXPIRED_USER}`,
      headers,
    })
    expect(afterRead.statusCode).toBe(404)
    expect(afterRead.json()).toEqual({ error: 'person_not_found' })

    const afterExport = await app.inject({
      method: 'GET',
      url: `/v1/persons/${EXPIRED_USER}/export`,
      headers,
    })
    expect(afterExport.statusCode).toBe(404)
    expect(afterExport.json()).toEqual({ error: 'person_not_found' })

    // The recent person is untouched — proof this is a selective drop, not a
    // blanket one that happened to also clear the expired person.
    const afterRecentRead = await app.inject({
      method: 'GET',
      url: `/v1/persons/${RECENT_USER}`,
      headers,
    })
    expect(afterRecentRead.statusCode).toBe(200)

    // --- Consequence 3: the event feed returns nothing for the expired
    // person, over a window wide enough to have shown their real event if it
    // still existed.
    const afterFeed = await app.inject({
      method: 'GET',
      url: `/v1/events?person=${EXPIRED_USER}&since=${encodeURIComponent(monthsAgo(20))}`,
      headers,
    })
    expect(afterFeed.statusCode).toBe(200)
    expect(afterFeed.json().events).toEqual([])

    // --- Consequence 4: traits and identity links survive, physically, in
    // storage — read directly, since no route can show them once the
    // events are gone. This is the fact the 404s above are meaningless
    // without: retained-but-unretrievable, not deleted.
    const traitsRs = await ch.query({
      query: `SELECT trait_key, argMaxMerge(value_str) AS v FROM person_traits
              WHERE project_id = {p:UInt32} AND user_id = {u:String}
              GROUP BY trait_key`,
      query_params: { p: projectId, u: EXPIRED_USER },
      format: 'JSONEachRow',
    })
    const traits = await traitsRs.json<{ trait_key: string; v: string }>()
    expect(traits).toEqual([{ trait_key: 'plan', v: 'gold' }])

    const bindingRows = await pg.query<{ person_id: string }>(
      'SELECT person_id FROM identity_bindings WHERE project_id = $1 AND anonymous_id = $2',
      [projectId, EXPIRED_DEVICE],
    )
    expect(bindingRows.rows).toEqual([{ person_id: EXPIRED_USER }])
  })
})
