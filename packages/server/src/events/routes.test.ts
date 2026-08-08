import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'
import { MAX_PERSON_RANGE_CLAUSES } from '../identity/scope.js'
import { encodeFeedCursor } from './cursor.js'
import { EVENTS_MAX_LIMIT, STATS_MAX_BUCKETS } from './routes.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

// Resolved by the ClickHouse *server* itself, inside the compose network —
// same pattern as person.test.ts/resolve.test.ts/dictionaries.test.ts.
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

const SLUG_A = 'events-routes-test-a'
const SLUG_B = 'events-routes-test-b'
const WRITE_KEY_A = 'wk_events_routes_a'
const SERVER_KEY_A = 'sk_events_routes_a'
const WRITE_KEY_B = 'wk_events_routes_b'
const SERVER_KEY_B = 'sk_events_routes_b'

// Own prefix, distinct from every other suite's event_id prefix in this
// package (77000000 is execute.test.ts's, 78000000 is schema/routes.test.ts's)
// — picked so a standalone run of this file can never collide with rows a
// different suite left behind on a shared database.
const uuid = (n: number) => `79000000-0000-4000-8000-${String(n).padStart(12, '0')}`

let app: FastifyInstance
let projectA: number
let projectB: number

/**
 * Fixtures are anchored to the current run, not to an absolute date — the
 * ingest path clamps a client timestamp older than 24h to now-24h
 * (`clampTimestamp`), so a hardcoded date silently drifts out of range on a
 * wall-clock schedule. Two hours back leaves comfortable room for every
 * offset used below.
 */
const BASE_MS = Date.now() - 2 * 60 * 60 * 1000

/** ClickHouse DateTime64(3) literal, for direct inserts (bypasses the clamp). */
const chAt = (seconds: number) =>
  new Date(BASE_MS + seconds * 1000).toISOString().replace('T', ' ').replace('Z', '')

/** ISO-8601, for payloads sent through the HTTP ingest path (subject to the clamp). */
const isoAt = (seconds: number) => new Date(BASE_MS + seconds * 1000).toISOString()

/**
 * ClickHouse DateTime64(3) literal anchored to the ACTUAL current instant,
 * not `BASE_MS` — needed only by the default-`since` test below, which has
 * to place one fixture row genuinely more than 24h in the past (`chAt`'s
 * two-hour anchor can never reach that far back).
 */
const chAtRealMsAgo = (msAgo: number) =>
  new Date(Date.now() - msAgo).toISOString().replace('T', ' ').replace('Z', '')

interface EvOpts {
  projectId: number
  eventId: string
  anonymousId?: string
  userId?: string
  eventName: string
  atSeconds: number
  receivedAtSeconds?: number
}

function evRow(opts: EvOpts) {
  return {
    project_id: opts.projectId,
    event_id: opts.eventId,
    anonymous_id: opts.anonymousId ?? '',
    user_id: opts.userId ?? '',
    event_name: opts.eventName,
    timestamp: chAt(opts.atSeconds),
    received_at: chAt(opts.receivedAtSeconds ?? opts.atSeconds),
    trusted: 1,
    properties: {},
    properties_num: {},
  }
}

async function insertEvents(rows: ReturnType<typeof evRow>[]): Promise<void> {
  await ch.insert({ table: 'events', format: 'JSONEachRow', values: rows })
}

/**
 * Like `evRow`, but anchored to an arbitrary real instant (epoch ms) rather
 * than this file's `BASE_MS`. The stats tests below pick their OWN
 * real-clock-anchored bucket boundaries (via `bucketStart`) so the exact
 * bucket a fixture row lands in can be computed and asserted precisely,
 * independent of `BASE_MS`'s fixed two-hour offset — and, since
 * `/v1/events/stats` has no `event` filter to isolate a fixture the way the
 * feed tests do, each stats test also picks its own few-minutes-wide real
 * time slot, distinct from every other fixture in this file (BASE_MS's
 * ~110-120-minutes-ago window, and the default-since/cursor-gap tests'
 * exact 1h/25h/27h/30h-ago marks), so a `since`/`until` window scoped
 * tightly around one test's own bucket(s) can never pick up another test's
 * rows.
 */
function evRowAtMs(opts: {
  projectId: number
  eventId: string
  userId?: string
  eventName: string
  atMs: number
  receivedAtMs?: number
}) {
  const fmt = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
  return {
    project_id: opts.projectId,
    event_id: opts.eventId,
    anonymous_id: '',
    user_id: opts.userId ?? '',
    event_name: opts.eventName,
    timestamp: fmt(opts.atMs),
    received_at: fmt(opts.receivedAtMs ?? opts.atMs),
    trusted: 1,
    properties: {},
    properties_num: {},
  }
}

/**
 * Matches ClickHouse's `toStartOfInterval(timestamp, INTERVAL n UNIT)` for
 * the three single-unit intervals this route supports (`1m`/`1h`/`1d`):
 * plain UTC epoch-floor division. `events.timestamp` is
 * `DateTime64(3, 'UTC')` and UTC days carry no DST, so epoch flooring and
 * UTC calendar flooring land on the identical instant.
 */
const bucketStart = (ms: number, intervalMs: number) => Math.floor(ms / intervalMs) * intervalMs

async function makeProject(slug: string, name: string, writeKey: string, serverKey: string) {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, writeKey, hashServerKey(serverKey)],
  )
  return Number(r.rows[0]?.id)
}

/**
 * Run at the TOP of beforeAll, not only in afterAll — per the branch's
 * live-database rule, so a previous run's crash (or a concurrent run of a
 * different file) can never leave rows this run trips over. Postgres
 * project deletion cascades to identity_bindings/person_aliases/
 * suppressed_persons (ON DELETE CASCADE, 003_identity.sql/005_suppression.sql);
 * ClickHouse has no such cascade, so `events` is cleared explicitly, by
 * project id looked up from whatever slug-matching row(s) exist right now
 * (not from this run's own not-yet-created `projectA`/`projectB`).
 */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = ANY($1)', [
    [SLUG_A, SLUG_B],
  ])
  const ids = existing.rows.map((r) => Number(r.id))
  if (ids.length > 0) {
    await ch.command({
      query: `ALTER TABLE events DELETE WHERE project_id IN (${ids.join(',')})`,
      clickhouse_settings: { mutations_sync: '1' },
    })
  }
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG_A, SLUG_B]])
}

const get = (url: string, key = SERVER_KEY_A) =>
  app.inject({ method: 'GET', url, headers: { 'x-lyraflow-server-key': key } })

async function identify(writeKey: string, body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/identify',
    headers: { 'x-lyraflow-write-key': writeKey },
    payload: body,
  })
  await app.deps.buffer.flush()
  return res
}

const suppress = async (projectId: number, personId: string, at: Date) => {
  await pg.query(
    'INSERT INTO suppressed_persons (project_id, person_id, suppressed_at) VALUES ($1, $2, $3)',
    [projectId, personId, at],
  )
  // The dictionary, not the table, is what the compiled query reads.
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })

  await cleanup()

  projectA = await makeProject(SLUG_A, 'EventsRoutesA', WRITE_KEY_A, SERVER_KEY_A)
  projectB = await makeProject(SLUG_B, 'EventsRoutesB', WRITE_KEY_B, SERVER_KEY_B)

  await ensureIdentityDictionaries(ch, pgSource)
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.person_aliases` })
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })

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

  // ---- Fixture: 5 events for the "oldest-first, no cursor" test ----
  await insertEvents([
    evRow({
      projectId: projectA,
      eventId: uuid(1),
      userId: 'log-user',
      eventName: 'feed_log_event',
      atSeconds: 0,
    }),
    evRow({
      projectId: projectA,
      eventId: uuid(2),
      userId: 'log-user',
      eventName: 'feed_log_event',
      atSeconds: 10,
    }),
    evRow({
      projectId: projectA,
      eventId: uuid(3),
      userId: 'log-user',
      eventName: 'feed_log_event',
      atSeconds: 20,
    }),
    evRow({
      projectId: projectA,
      eventId: uuid(4),
      userId: 'log-user',
      eventName: 'feed_log_event',
      atSeconds: 30,
    }),
    evRow({
      projectId: projectA,
      eventId: uuid(5),
      userId: 'log-user',
      eventName: 'feed_log_event',
      atSeconds: 40,
    }),
  ])

  // ---- Fixture: 3 events for the "pages forward" test, page one only.
  // Page two's events (a same-timestamp tie plus one later) are inserted
  // inside the test itself, after page one has already been fetched — the
  // shape a real `--follow` poll produces. ----
  await insertEvents([
    evRow({
      projectId: projectA,
      eventId: uuid(10),
      userId: 'page-user',
      eventName: 'feed_page_event',
      atSeconds: 100,
    }),
    evRow({
      projectId: projectA,
      eventId: uuid(11),
      userId: 'page-user',
      eventName: 'feed_page_event',
      atSeconds: 110,
    }),
    evRow({
      projectId: projectA,
      eventId: uuid(12),
      userId: 'page-user',
      eventName: 'feed_page_event',
      atSeconds: 120,
    }),
  ])

  // The dedup fixture (same event_id, two physical rows) is built inside its
  // own `it` below, not here — it needs `SYSTEM STOP MERGES` bracketing it
  // tightly; see that test's own comment.

  // ---- Fixture: two distinct event names, for the `event` filter. ----
  await insertEvents([
    evRow({
      projectId: projectA,
      eventId: uuid(30),
      userId: 'filter-user',
      eventName: 'feed_filter_a',
      atSeconds: 300,
    }),
    evRow({
      projectId: projectA,
      eventId: uuid(31),
      userId: 'filter-user',
      eventName: 'feed_filter_a',
      atSeconds: 310,
    }),
    evRow({
      projectId: projectA,
      eventId: uuid(32),
      userId: 'filter-user',
      eventName: 'feed_filter_b',
      atSeconds: 320,
    }),
  ])

  // ---- Fixture: a colliding id across two tenants. ----
  await insertEvents([
    evRow({
      projectId: projectA,
      eventId: uuid(40),
      userId: 'shared-id',
      eventName: 'feed_cross_event',
      atSeconds: 400,
    }),
    evRow({
      projectId: projectB,
      eventId: uuid(41),
      userId: 'shared-id',
      eventName: 'feed_cross_event',
      atSeconds: 400,
    }),
  ])

  // ---- Fixture: a deletion boundary. Two events for the same person, one
  // strictly before the boundary and one strictly after; the boundary itself
  // sits between them. ----
  await insertEvents([
    evRow({
      projectId: projectA,
      eventId: uuid(50),
      userId: 'boundary-user',
      eventName: 'feed_boundary_event',
      atSeconds: 500,
    }),
    evRow({
      projectId: projectA,
      eventId: uuid(51),
      userId: 'boundary-user',
      eventName: 'feed_boundary_event',
      atSeconds: 520,
    }),
  ])
  await suppress(projectA, 'boundary-user', new Date(BASE_MS + 510 * 1000))

  // ---- Fixture: the person filter, resolved through a device id (pre-
  // identify) and its later-bound canonical person. ----
  await insertEvents([
    // Recorded before identify(), under the device id alone.
    evRow({
      projectId: projectA,
      eventId: uuid(60),
      anonymousId: 'person-dev',
      eventName: 'feed_person_event',
      atSeconds: 600,
    }),
    // A different person entirely, same event name — must never surface in
    // a person-scoped query for the id above.
    evRow({
      projectId: projectA,
      eventId: uuid(62),
      userId: 'person-other',
      eventName: 'feed_person_event',
      atSeconds: 620,
    }),
  ])
  const identifyRes = await identify(WRITE_KEY_A, {
    message_id: randomUUID(),
    anonymous_id: 'person-dev',
    user_id: 'person-user',
    timestamp: isoAt(610),
    traits: {},
  })
  if (identifyRes.statusCode !== 202) {
    throw new Error(`fixture identify() failed: ${identifyRes.statusCode} ${identifyRes.body}`)
  }
  // Recorded after identify(), under the resolved user id.
  await insertEvents([
    evRow({
      projectId: projectA,
      eventId: uuid(61),
      userId: 'person-user',
      eventName: 'feed_person_event',
      atSeconds: 615,
    }),
  ])
})

afterAll(async () => {
  await app.deps.buffer.flush()
  await app.close()
  await cleanup()
  await pg.end()
  await ch.close()
})

describe('GET /v1/events', () => {
  it('rejects the write key', async () => {
    // A genuine, issued key — just the wrong one for this header. Sent as
    // `x-lyraflow-server-key`, it cannot match any project's
    // server_key_hash, so the correct implementation answers
    // invalid_server_key, not missing_server_key.
    const res = await get('/v1/events', WRITE_KEY_A)
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('invalid_server_key')
  })

  it('returns the most recent events oldest-first when given no cursor', async () => {
    const res = await get('/v1/events?event=feed_log_event&limit=3')
    expect(res.statusCode).toBe(200)
    const ids = res.json().events.map((e: { event_id: string }) => e.event_id)
    // Five events exist (uuid(1)..uuid(5)); the 3 most recent are 3,4,5, and
    // the response must read like a log: oldest of the page first.
    expect(ids).toEqual([uuid(3), uuid(4), uuid(5)])
  })

  it('pages forward from a cursor without missing or repeating', async () => {
    const page1 = await get('/v1/events?event=feed_page_event&limit=10')
    expect(page1.statusCode).toBe(200)
    const page1Ids = page1.json().events.map((e: { event_id: string }) => e.event_id)
    expect(page1Ids).toEqual([uuid(10), uuid(11), uuid(12)])
    const cursor = page1.json().next_cursor
    expect(cursor).toBeTruthy()

    // Page two: one event sharing the EXACT timestamp of the cursor's own
    // event (uuid(12), t=120) but a lexicographically/numerically GREATER
    // event_id, plus one genuinely later event. A bare `timestamp > at`
    // would drop the tied event; the tuple comparison must not.
    await insertEvents([
      evRow({
        projectId: projectA,
        eventId: uuid(13),
        userId: 'page-user',
        eventName: 'feed_page_event',
        atSeconds: 120,
      }),
      evRow({
        projectId: projectA,
        eventId: uuid(14),
        userId: 'page-user',
        eventName: 'feed_page_event',
        atSeconds: 130,
      }),
    ])

    const page2 = await get(
      `/v1/events?event=feed_page_event&limit=10&after=${encodeURIComponent(cursor)}`,
    )
    expect(page2.statusCode).toBe(200)
    const page2Ids = page2.json().events.map((e: { event_id: string }) => e.event_id)
    // No overlap with page one, no gap: the tied event (uuid(13)) and the
    // later one (uuid(14)), in that order — nothing from page one repeated.
    expect(page2Ids).toEqual([uuid(13), uuid(14)])
  })

  // `events` is a ReplacingMergeTree, and a background merge collapses
  // duplicate physical rows on its own schedule — left to chance, a merge
  // landing before this test's query runs would make the assertion below
  // pass even with `LIMIT 1 BY` deleted from the route entirely, silently
  // defeating this test's own purpose (the same race export.test.ts's
  // identical test documents hitting for real). Stopping merges for this
  // window removes the race rather than hoping to outrun it;
  // `fileParallelism: false` (root vitest.config.ts) is what makes it safe
  // for a single test file to do this to a table every other suite shares.
  it('deduplicates a retried delivery', async () => {
    await ch.command({ query: `SYSTEM STOP MERGES ${CH_DB}.events` })
    try {
      // Two SEPARATE insert calls, deliberately: ClickHouse collapses exact
      // sort-key duplicates that land in the SAME inserted block before it
      // ever reaches disk (confirmed by hand against this environment's live
      // ClickHouse) — a single `ch.insert` carrying both rows would already
      // arrive as one physical row, proving nothing about the route's own
      // `LIMIT 1 BY`.
      await insertEvents([
        evRow({
          projectId: projectA,
          eventId: uuid(20),
          userId: 'dedup-user',
          eventName: 'feed_dedup_event',
          atSeconds: 200,
          receivedAtSeconds: 200,
        }),
      ])
      await insertEvents([
        evRow({
          projectId: projectA,
          eventId: uuid(20),
          userId: 'dedup-user',
          eventName: 'feed_dedup_event',
          atSeconds: 200,
          receivedAtSeconds: 210,
        }),
      ])

      const res = await get('/v1/events?event=feed_dedup_event')
      expect(res.statusCode).toBe(200)
      const ids = res.json().events.map((e: { event_id: string }) => e.event_id)
      expect(ids).toEqual([uuid(20)])
    } finally {
      await ch.command({ query: `SYSTEM START MERGES ${CH_DB}.events` })
    }
  })

  it('filters by event name', async () => {
    const res = await get('/v1/events?event=feed_filter_a')
    expect(res.statusCode).toBe(200)
    const ids = res.json().events.map((e: { event_id: string }) => e.event_id)
    expect(ids.sort()).toEqual([uuid(30), uuid(31)].sort())
    expect(ids).not.toContain(uuid(32))
  })

  it('filters to one person, resolved through aliases and devices', async () => {
    // Queried by the DEVICE id, never bound to a person_id column directly
    // — resolvePersonScope must resolve it to the canonical person and pull
    // in every id (and window) that belongs to it.
    const res = await get('/v1/events?event=feed_person_event&person=person-dev')
    expect(res.statusCode).toBe(200)
    const ids = res.json().events.map((e: { event_id: string }) => e.event_id)
    expect(ids.sort()).toEqual([uuid(60), uuid(61)].sort())
    expect(ids).not.toContain(uuid(62))
  })

  it("never returns another project's events for a colliding id", async () => {
    const res = await get('/v1/events?event=feed_cross_event', SERVER_KEY_A)
    expect(res.statusCode).toBe(200)
    const ids = res.json().events.map((e: { event_id: string }) => e.event_id)
    expect(ids).toEqual([uuid(40)])
    expect(ids).not.toContain(uuid(41))
  })

  // The brief this test was transcribed from asserted 200 + a capped
  // events.length, on the theory that an over-cap `limit` gets silently
  // clamped. It does not: `Query`'s `.max(EVENTS_MAX_LIMIT)` is a Zod
  // validation bound on a coerced number, which REJECTS a value above it
  // rather than clamping it — the same choice `/v1/schema/*` makes (see
  // schema/routes.test.ts's identical note). A 400 still satisfies "a
  // caller must not be able to exceed [the cap]": the request is refused
  // outright. It is also independent of how many rows the fixture happens
  // to hold, unlike a clamp-based assertion, which this fixture (nowhere
  // near EVENTS_MAX_LIMIT rows) could never distinguish from an unenforced
  // cap.
  it('caps limit at EVENTS_MAX_LIMIT', async () => {
    const res = await get(`/v1/events?limit=${EVENTS_MAX_LIMIT * 10}`)
    expect(res.statusCode).toBe(400)
  })

  it("hides events at or before a deleted person's boundary", async () => {
    const res = await get('/v1/events?event=feed_boundary_event')
    expect(res.statusCode).toBe(200)
    const ids = res.json().events.map((e: { event_id: string }) => e.event_id)
    // uuid(50) sits AT t=500, before the t=510 boundary — hidden. uuid(51)
    // sits at t=520, after it — survives.
    expect(ids).toEqual([uuid(51)])
  })

  // THE test for the default `since` window. Both rows share one event
  // name, unique to this test, so a leaky default (no bound at all) would
  // return both; the correct default returns only the recent one. Anchored
  // to the REAL current instant (`chAtRealMsAgo`), not this file's `BASE_MS`
  // (only two hours back) — the old row has to be genuinely more than 24h
  // in the past, inserted directly via `ch.insert` to bypass the ingest
  // path's own 24h clamp (`clampTimestamp`), which would otherwise silently
  // rewrite it to exactly `now - 24h` and make this test unable to tell a
  // working default from a missing one.
  it('defaults since to the last 24 hours when omitted', async () => {
    await insertEvents([
      evRow({
        projectId: projectA,
        eventId: uuid(70),
        userId: 'since-default-user',
        eventName: 'feed_default_since_event',
        atSeconds: 0,
      }),
    ])
    // Overwrite the "recent" row's timestamp to 1h ago (genuinely within the
    // default window) and add one genuinely stale row, both bypassing the
    // `BASE_MS`-anchored `evRow`/`chAt` helpers.
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          project_id: projectA,
          event_id: uuid(70),
          anonymous_id: '',
          user_id: 'since-default-user',
          event_name: 'feed_default_since_event',
          timestamp: chAtRealMsAgo(60 * 60 * 1000),
          received_at: chAtRealMsAgo(60 * 60 * 1000),
          trusted: 1,
          properties: {},
          properties_num: {},
        },
        {
          project_id: projectA,
          event_id: uuid(71),
          anonymous_id: '',
          user_id: 'since-default-user',
          event_name: 'feed_default_since_event',
          timestamp: chAtRealMsAgo(25 * 60 * 60 * 1000),
          received_at: chAtRealMsAgo(25 * 60 * 60 * 1000),
          trusted: 1,
          properties: {},
          properties_num: {},
        },
      ],
    })

    const res = await get('/v1/events?event=feed_default_since_event')
    expect(res.statusCode).toBe(200)
    const ids = res.json().events.map((e: { event_id: string }) => e.event_id)
    expect(ids).toEqual([uuid(70)])
    expect(ids).not.toContain(uuid(71))
  })

  // THE test for the default-`since`/cursor interaction. A cursor is
  // ITSELF a lower bound (`(timestamp, event_id) > (at, aid)`), so the
  // default `since` must never also apply once a cursor is present — two
  // lower bounds where the tighter one silently wins is exactly how a
  // follower who fell more than 24h behind loses events with no error and
  // no gap marker, since `next_cursor` only ever advances past whatever a
  // call actually returned.
  //
  // Fixture: a stale cursor position at -30h (older than the 24h default
  // window), a GAP event at -27h that keyset semantics say comes next, and
  // a recent event at -1h. Paging from the -30h cursor with no `since`
  // must return BOTH the gap event and the recent one — dropping the gap
  // event is the exact silent hole this test exists to catch. All three
  // timestamps are real-`Date.now()`-anchored (`chAtRealMsAgo`), inserted
  // directly via `ch.insert` to bypass the ingest path's 24h clamp, for
  // the same reason the default-`since` test above needs it.
  it('does not apply the default since window when a cursor is present', async () => {
    const cursorEventId = uuid(90)
    const gapEventId = uuid(91)
    const recentEventId = uuid(92)
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          project_id: projectA,
          event_id: cursorEventId,
          anonymous_id: '',
          user_id: 'cursor-gap-user',
          event_name: 'feed_cursor_gap_event',
          timestamp: chAtRealMsAgo(30 * 60 * 60 * 1000),
          received_at: chAtRealMsAgo(30 * 60 * 60 * 1000),
          trusted: 1,
          properties: {},
          properties_num: {},
        },
        {
          project_id: projectA,
          event_id: gapEventId,
          anonymous_id: '',
          user_id: 'cursor-gap-user',
          event_name: 'feed_cursor_gap_event',
          timestamp: chAtRealMsAgo(27 * 60 * 60 * 1000),
          received_at: chAtRealMsAgo(27 * 60 * 60 * 1000),
          trusted: 1,
          properties: {},
          properties_num: {},
        },
        {
          project_id: projectA,
          event_id: recentEventId,
          anonymous_id: '',
          user_id: 'cursor-gap-user',
          event_name: 'feed_cursor_gap_event',
          timestamp: chAtRealMsAgo(1 * 60 * 60 * 1000),
          received_at: chAtRealMsAgo(1 * 60 * 60 * 1000),
          trusted: 1,
          properties: {},
          properties_num: {},
        },
      ],
    })

    // A cursor exactly at the stale (-30h) event's own position — the
    // shape a real `--follow` client would hold after its previous page
    // ended there.
    const staleCursor = encodeFeedCursor({
      timestamp: chAtRealMsAgo(30 * 60 * 60 * 1000),
      eventId: cursorEventId,
    })

    const res = await get(
      `/v1/events?event=feed_cursor_gap_event&after=${encodeURIComponent(staleCursor)}`,
    )
    expect(res.statusCode).toBe(200)
    const ids = res.json().events.map((e: { event_id: string }) => e.event_id)
    // Both the gap event and the recent one — not just the recent one, and
    // not the cursor's own (already-seen) event.
    expect(ids).toEqual([gapEventId, recentEventId])
  })

  // The cap exists because a person's windows are devices multiplied by
  // rebinds, which has no fixed bound — reachable by anyone holding the
  // server key. Would catch: `MAX_PERSON_RANGE_CLAUSES` or the 400 it
  // guards being deleted or bypassed on THIS route specifically — the same
  // guard already covers GET /v1/persons/:id (person.test.ts) and the
  // export (export.test.ts), and this route's `person` filter goes through
  // the exact same `resolvePersonScope` call. A guardrail holding on those
  // two routes and not on this one is exactly the "fifth read path" failure
  // shape this module's own docstring warns about, just for a different
  // guard than suppression.
  //
  // Fixture transplanted from person.test.ts's/export.test.ts's identical
  // test: MAX_PERSON_RANGE_CLAUSES + 5 DISTINCT devices, each bound exactly
  // once, in a single `INSERT ... SELECT ... FROM unnest()` rather than one
  // row per query — see that test's own comment for why this shape keeps
  // the window count exact and independent of tiling internals. Cleaned up
  // immediately in a `finally` rather than left for `afterAll`, since
  // nothing else in this file touches 'events-frag-person' or its devices.
  it('refuses a person filter whose history is too fragmented to bound', async () => {
    const deviceIds = Array.from(
      { length: MAX_PERSON_RANGE_CLAUSES + 5 },
      (_, i) => `events-frag-device-${i}`,
    )
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
       SELECT $1, d, 'events-frag-person', $3::timestamptz
       FROM unnest($2::text[]) AS d`,
      [projectA, deviceIds, isoAt(2000)],
    )
    try {
      const res = await get('/v1/events?person=events-frag-person')
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        error: 'person_history_too_fragmented',
        detail: `this person spans ${deviceIds.length} device windows, above the limit of ${MAX_PERSON_RANGE_CLAUSES}`,
      })
    } finally {
      await pg.query(
        `DELETE FROM identity_bindings WHERE project_id = $1 AND person_id = 'events-frag-person'`,
        [projectA],
      )
    }
  })
})

// FIXTURE-ISOLATION INVARIANT FOR EVERY TEST BELOW THAT ANCHORS ON
// `Date.now() - N * 60_000` (this route has no `event` filter, so a
// tightly-scoped `since`/`until` window is the ONLY isolation a stats
// fixture gets). Every such anchor, plus half its window's width, MUST
// stay strictly under 60 minutes. The feed's own tests above
// (`chAtRealMsAgo(60 * 60 * 1000)` at line ~617, `chAtRealMsAgo(1 *
// 60 * 60 * 1000)` at line ~699) insert real fixtures pinned at exactly
// "-60 minutes ago AT THE INSTANT THOSE EARLIER TESTS RAN" — by the time
// this describe block executes, real wall-clock time has moved on, so
// those fixtures' TRUE age is `60 minutes + however long the file took to
// reach here`, always AT LEAST 60 minutes and never less. An anchor here
// held strictly below 60 minutes can therefore never drift into them,
// however much wall-clock time the suite takes: elapsed time only pushes
// the 60-minute fixtures further away, never closer. An anchor AT OR ABOVE
// 60 minutes is gambling against exactly how much time elapsed between
// that earlier test running and this one — proven for real by inserting
// one unrelated project-A event into an over-60-minute stats window: the
// failure read `expected 2 to be 1`, byte-identical to a genuine `LIMIT 1
// BY` regression, misdiagnosable as a real dedup defect by whoever hits it
// next. The ladder below is 40/43/46/49/52/55 for exactly this reason —
// keep extending it in 3-minute steps rather than picking a fresh number.
describe('GET /v1/events/stats', () => {
  const statsGet = (query: string, key = SERVER_KEY_A) => get(`/v1/events/stats${query}`, key)

  it('buckets counts by interval, oldest bucket first', async () => {
    const intervalMs = 60_000
    // 40 minutes ago: distinct from BASE_MS's ~110-120-minutes-ago window
    // and from the other tests' exact 1h/25h/27h/30h/43m/46m/49m/52m/55m
    // marks. See the fixture-isolation invariant comment above this
    // describe block for why every anchor here stays under 60 minutes.
    const bucket1 = bucketStart(Date.now() - 40 * 60_000, intervalMs)
    const bucket2 = bucket1 + intervalMs

    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(100),
          userId: 'stats-bucket-user',
          eventName: 'stats_bucket_event',
          atMs: bucket1 + 5_000,
        }),
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(101),
          userId: 'stats-bucket-user',
          eventName: 'stats_bucket_event',
          atMs: bucket1 + 15_000,
        }),
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(102),
          userId: 'stats-bucket-user',
          eventName: 'stats_bucket_event',
          atMs: bucket2 + 5_000,
        }),
      ],
    })

    const since = new Date(bucket1 - 1_000).toISOString()
    const until = new Date(bucket2 + intervalMs - 1_000).toISOString()
    const res = await statsGet(
      `?interval=1m&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().buckets).toEqual([
      { bucket: new Date(bucket1).toISOString(), events: 2 },
      { bucket: new Date(bucket2).toISOString(), events: 1 },
    ])
  })

  it('groups by event name when asked, one row per bucket and name', async () => {
    // Flat rows, not a nested object per bucket — it is what keeps the
    // NDJSON pipeable into jq and sort without restructuring.
    const intervalMs = 60_000
    const bucket1 = bucketStart(Date.now() - 43 * 60_000, intervalMs)

    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(110),
          userId: 'stats-group-user',
          eventName: 'stats_group_a',
          atMs: bucket1 + 5_000,
        }),
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(111),
          userId: 'stats-group-user',
          eventName: 'stats_group_a',
          atMs: bucket1 + 10_000,
        }),
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(112),
          userId: 'stats-group-user',
          eventName: 'stats_group_b',
          atMs: bucket1 + 15_000,
        }),
      ],
    })

    const since = new Date(bucket1 - 1_000).toISOString()
    const until = new Date(bucket1 + intervalMs - 1_000).toISOString()
    const res = await statsGet(
      `?interval=1m&group_by=event_name&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().buckets).toEqual([
      { bucket: new Date(bucket1).toISOString(), event_name: 'stats_group_a', events: 2 },
      { bucket: new Date(bucket1).toISOString(), event_name: 'stats_group_b', events: 1 },
    ])
  })

  // events is a ReplacingMergeTree; see the identical dedup test on
  // GET /v1/events above for why merges are stopped and the two duplicate
  // rows are two SEPARATE ch.insert() calls rather than one — a single
  // insert carrying both would already be pre-merged into one physical row
  // before reaching disk.
  //
  // This fixture alone does NOT independently pin `LIMIT 1 BY`, and does
  // NOT make `count(DISTINCT event_id)` distinguishable from plain
  // `count()` either: both duplicate rows share one `timestamp` and land
  // in the SAME bucket, so removing just `LIMIT 1 BY` (DISTINCT still
  // collapses them) or just DISTINCT (LIMIT 1 BY already removed the
  // duplicate upstream) still passes this test — only removing BOTH at
  // once fails it. The test below ("counts a retried delivery once even
  // when its retry lands in a different bucket") is the one that pins
  // `LIMIT 1 BY` on its own, with a fixture DISTINCT structurally cannot
  // rescue: two physical rows in DIFFERENT buckets, which no per-bucket
  // GROUP BY aggregate can collapse across groups.
  it('counts distinct event ids, so a retried delivery is one event', async () => {
    const intervalMs = 60_000
    const bucket1 = bucketStart(Date.now() - 46 * 60_000, intervalMs)
    const atMs = bucket1 + 5_000

    await ch.command({ query: `SYSTEM STOP MERGES ${CH_DB}.events` })
    try {
      await ch.insert({
        table: 'events',
        format: 'JSONEachRow',
        values: [
          evRowAtMs({
            projectId: projectA,
            eventId: uuid(120),
            userId: 'stats-dedup-user',
            eventName: 'stats_dedup_event',
            atMs,
            receivedAtMs: atMs,
          }),
        ],
      })
      await ch.insert({
        table: 'events',
        format: 'JSONEachRow',
        values: [
          evRowAtMs({
            projectId: projectA,
            eventId: uuid(120),
            userId: 'stats-dedup-user',
            eventName: 'stats_dedup_event',
            atMs,
            receivedAtMs: atMs + 10_000,
          }),
        ],
      })

      const since = new Date(bucket1 - 1_000).toISOString()
      const until = new Date(bucket1 + intervalMs - 1_000).toISOString()
      const res = await statsGet(
        `?interval=1m&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      )
      expect(res.statusCode).toBe(200)
      expect(res.json().buckets).toEqual([{ bucket: new Date(bucket1).toISOString(), events: 1 }])
    } finally {
      await ch.command({ query: `SYSTEM START MERGES ${CH_DB}.events` })
    }
  })

  // THE test that independently pins `LIMIT 1 BY project_id, event_id` in
  // the stats query, as opposed to the outer `count(DISTINCT event_id)`.
  // The module's own docstring (routes.ts) identifies the PERMANENT
  // duplicate shape as a retry that omitted `timestamp`: it is assigned a
  // fresh server timestamp on redelivery, so its two physical rows can
  // straddle a bucket boundary entirely — one lands in bucket1, the retry
  // in bucket2. `count(DISTINCT event_id)` is evaluated PER GROUP (per
  // bucket): if both physical rows survived `LIMIT 1 BY` to reach the
  // outer query, the one logical event would be counted once IN EACH
  // bucket, since DISTINCT cannot collapse duplicates across separate
  // GROUP BY groups — only `LIMIT 1 BY`, which runs before grouping, can.
  //
  // Asserted as the SUM across buckets, not a specific per-bucket shape:
  // `LIMIT 1 BY` has no tie-break (see the route's own docstring), so
  // which of the two physical rows survives — and therefore which single
  // bucket the surviving row lands in — is arbitrary. The total is the
  // one invariant that must hold regardless of which row wins.
  it('counts a retried delivery once even when its retry lands in a different bucket', async () => {
    const intervalMs = 60_000
    // 52 minutes ago — extends the 40/43/46/49 ladder, still under the
    // 60-minute invariant (see the comment above this describe block).
    const bucket1 = bucketStart(Date.now() - 52 * 60_000, intervalMs)
    const bucket2 = bucket1 + intervalMs
    const eventId = uuid(150)

    await ch.command({ query: `SYSTEM STOP MERGES ${CH_DB}.events` })
    try {
      await ch.insert({
        table: 'events',
        format: 'JSONEachRow',
        values: [
          evRowAtMs({
            projectId: projectA,
            eventId,
            userId: 'stats-boundary-retry-user',
            eventName: 'stats_boundary_retry_event',
            atMs: bucket1 + 5_000,
            receivedAtMs: bucket1 + 5_000,
          }),
        ],
      })
      await ch.insert({
        table: 'events',
        format: 'JSONEachRow',
        values: [
          evRowAtMs({
            projectId: projectA,
            eventId,
            userId: 'stats-boundary-retry-user',
            eventName: 'stats_boundary_retry_event',
            atMs: bucket2 + 5_000,
            receivedAtMs: bucket2 + 15_000,
          }),
        ],
      })

      const since = new Date(bucket1 - 1_000).toISOString()
      const until = new Date(bucket2 + intervalMs - 1_000).toISOString()
      const res = await statsGet(
        `?interval=1m&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      )
      expect(res.statusCode).toBe(200)
      const total = res
        .json()
        .buckets.reduce((sum: number, b: { events: number }) => sum + b.events, 0)
      expect(total).toBe(1)
    } finally {
      await ch.command({ query: `SYSTEM START MERGES ${CH_DB}.events` })
    }
  })

  // THE test that independently pins the `project_id` tenancy filter in
  // the stats inner select. Every other stats fixture in this file lives
  // under project A alone, so a deleted `project_id = {p0}` clause would
  // change nothing any of them could observe. This inserts a project-B row
  // inside a project-A stats window and confirms it is absent: sharper
  // than the feed's equivalent cross-project test (routes.test.ts, "never
  // returns another project's events for a colliding id") because the
  // suppression clause binds project A's OWN dictionary key — a leaked
  // project-B row would be both counted and unsuppressed, not merely
  // counted.
  it("never counts another project's events", async () => {
    const intervalMs = 60_000
    // 55 minutes ago — extends the 40/43/46/49/52 ladder, still under the
    // 60-minute invariant (see the comment above this describe block).
    const bucket1 = bucketStart(Date.now() - 55 * 60_000, intervalMs)

    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(160),
          userId: 'stats-tenant-a',
          eventName: 'stats_tenant_event',
          atMs: bucket1 + 5_000,
        }),
        evRowAtMs({
          projectId: projectB,
          eventId: uuid(161),
          userId: 'stats-tenant-b',
          eventName: 'stats_tenant_event',
          atMs: bucket1 + 6_000,
        }),
      ],
    })

    const since = new Date(bucket1 - 1_000).toISOString()
    const until = new Date(bucket1 + intervalMs - 1_000).toISOString()
    const res = await statsGet(
      `?interval=1m&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
      SERVER_KEY_A,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().buckets).toEqual([{ bucket: new Date(bucket1).toISOString(), events: 1 }])
  })

  // A single event 5s into the bucket cannot distinguish a correct 1h
  // width from a halved (30m) one — every finer aligned interval floors to
  // the identical boundary, so the test would pass either way. The second
  // event, 40 minutes into the SAME 1-hour bucket, is what a halved
  // interval would put in the FOLLOWING bucket instead: this fixture is a
  // single row with `events: 2` only if the bucket is genuinely 1h wide.
  it('aligns buckets correctly at 1h resolution', async () => {
    const intervalMs = 60 * 60_000
    const bucket1 = bucketStart(Date.now() - 6 * 60 * 60_000, intervalMs)

    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(170),
          userId: 'stats-1h-user',
          eventName: 'stats_1h_event',
          atMs: bucket1 + 5_000,
        }),
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(172),
          userId: 'stats-1h-user',
          eventName: 'stats_1h_event',
          atMs: bucket1 + 40 * 60_000,
        }),
      ],
    })

    const since = new Date(bucket1 - 1_000).toISOString()
    const until = new Date(bucket1 + intervalMs - 1_000).toISOString()
    const res = await statsGet(
      `?interval=1h&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().buckets).toEqual([{ bucket: new Date(bucket1).toISOString(), events: 2 }])
  })

  // Same reasoning as the 1h test above: the second event, 18 hours into
  // the SAME 1-day bucket, is what a halved (12h) interval would split
  // into a following bucket instead.
  it('aligns buckets correctly at 1d resolution', async () => {
    const intervalMs = 24 * 60 * 60_000
    const bucket1 = bucketStart(Date.now() - 5 * 24 * 60 * 60_000, intervalMs)

    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(171),
          userId: 'stats-1d-user',
          eventName: 'stats_1d_event',
          atMs: bucket1 + 5_000,
        }),
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(173),
          userId: 'stats-1d-user',
          eventName: 'stats_1d_event',
          atMs: bucket1 + 18 * 60 * 60_000,
        }),
      ],
    })

    const since = new Date(bucket1 - 1_000).toISOString()
    const until = new Date(bucket1 + intervalMs - 1_000).toISOString()
    const res = await statsGet(
      `?interval=1d&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    )
    expect(res.statusCode).toBe(200)
    expect(res.json().buckets).toEqual([{ bucket: new Date(bucket1).toISOString(), events: 2 }])
  })

  // Important 3's fix: the default `since` window is scaled to `interval`
  // (STATS_DEFAULT_WINDOW_MS) specifically so this bare call — no `since`,
  // no `until` — never collides with STATS_MAX_BUCKETS. Before that fix,
  // `1m`'s default window was the fixed 24h default (1440 buckets against
  // a cap of 1000): the single most obvious invocation of this endpoint
  // was an unconditional 400.
  it('returns 200 for a bare ?interval=1m with no since/until', async () => {
    const res = await statsGet('?interval=1m')
    expect(res.statusCode).toBe(200)
  })

  // THE tests that independently pin `STATS_DEFAULT_WINDOW_MS`'s actual
  // per-interval values, not just that a bare call succeeds (the previous
  // test above). Without these, collapsing all three entries to the same
  // tiny value — or reverting to a single flat default — left the suite
  // fully green.
  //
  // Each probe event carries a UNIQUE `event_name` and is queried back with
  // `group_by=event_name`, checking for that name's PRESENCE in the
  // response rather than an exact bucket count — this sidesteps every
  // other stats fixture that might also land inside a 24h/7d default
  // window (which, unlike the tightly-scoped tests above, these bare
  // calls make no attempt to exclude) without needing a real-time offset
  // under the 60-minute fixture-isolation invariant either, since a
  // uniquely-named row is unambiguous regardless of what else is present.
  //
  // `now - 90m` sits OUTSIDE `1m`'s default (1h) but INSIDE `1h`'s (24h) —
  // note this is NOT `now - 50m` as an earlier version of this review
  // round suggested: 50 minutes is still inside `1m`'s own 1-hour default
  // window, so it cannot discriminate the two at all. 90 minutes is the
  // smallest round number clear of that boundary with a comfortable
  // margin either side.
  it("the default since window is scaled to interval: 1h's default reaches further back than 1m's", async () => {
    const probeEventName = 'stats_default_window_probe_1h_vs_1m'
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(180),
          userId: 'stats-default-window-probe-user',
          eventName: probeEventName,
          atMs: Date.now() - 90 * 60_000,
        }),
      ],
    })
    const hasProbe = (buckets: { event_name?: string }[]) =>
      buckets.some((b) => b.event_name === probeEventName)

    const hourRes = await statsGet('?interval=1h&group_by=event_name')
    expect(hourRes.statusCode).toBe(200)
    expect(hasProbe(hourRes.json().buckets)).toBe(true)

    const minuteRes = await statsGet('?interval=1m&group_by=event_name')
    expect(minuteRes.statusCode).toBe(200)
    expect(hasProbe(minuteRes.json().buckets)).toBe(false)
  })

  // Same technique, one window pair further out: `now - 3 days` sits
  // OUTSIDE `1h`'s default (24h) but INSIDE `1d`'s (7d after Important 1's
  // fix). No real-time wait is needed to test this — the probe's
  // `timestamp` is a fabricated ClickHouse column value, not a value tied
  // to how long the test actually takes to run, so there is no "slow
  // fixture" tradeoff here to accept or decline.
  it("the default since window is scaled to interval: 1d's default reaches further back than 1h's", async () => {
    const probeEventName = 'stats_default_window_probe_1d_vs_1h'
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(181),
          userId: 'stats-default-window-probe-user',
          eventName: probeEventName,
          atMs: Date.now() - 3 * 24 * 60 * 60_000,
        }),
      ],
    })
    const hasProbe = (buckets: { event_name?: string }[]) =>
      buckets.some((b) => b.event_name === probeEventName)

    const dayRes = await statsGet('?interval=1d&group_by=event_name')
    expect(dayRes.statusCode).toBe(200)
    expect(hasProbe(dayRes.json().buckets)).toBe(true)

    const hourRes = await statsGet('?interval=1h&group_by=event_name')
    expect(hourRes.statusCode).toBe(200)
    expect(hasProbe(hourRes.json().buckets)).toBe(false)
  })

  // THE test that independently pins Minor 2's fix: `untilClause` emitted
  // unconditionally from the resolved `untilDate`, not only when the
  // caller passed `until` explicitly. `clampTimestamp` (@lyraflow/core,
  // MAX_CLOCK_SKEW_MS = 24h) is an INGEST-time clamp only — a row inserted
  // directly, as every fixture in this file is, carries whatever
  // `timestamp` it's given, so a future-dated row is a legal, reachable
  // shape for this route to see regardless of the ingest path's own rules.
  // Uses the same unique-`event_name` presence check as the tests above,
  // so it needs no real-time-offset ladder slot at all: `since` is
  // explicit here, so `STATS_DEFAULT_WINDOW_MS` never enters into it.
  it('bounds a since-only query at now, even though a directly-inserted row can be future-dated', async () => {
    const probeEventName = 'stats_future_dated_probe_event'
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(190),
          userId: 'stats-future-probe-user',
          eventName: probeEventName,
          // 12h ahead of now — legal under MAX_CLOCK_SKEW_MS (24h), and
          // this route's own inner select has no clamp of its own.
          atMs: Date.now() + 12 * 60 * 60_000,
        }),
      ],
    })

    const since = new Date(Date.now() - 5 * 60_000).toISOString()
    const res = await statsGet(
      `?interval=1m&since=${encodeURIComponent(since)}&group_by=event_name`,
    )
    expect(res.statusCode).toBe(200)
    expect(
      res.json().buckets.some((b: { event_name?: string }) => b.event_name === probeEventName),
    ).toBe(false)
  })

  // Stats cannot join the four-path matrix — it returns counts, not
  // people, so it has no personIds to assert on. This is its equivalent: a
  // person whose events are all before their boundary contributes nothing
  // to any bucket. A third, non-suppressed person's event in the same
  // window is the positive control — it survives, proving the absence of
  // the erased user's two events is suppression, not an empty result set.
  it("excludes an erased person's events from the counts", async () => {
    const intervalMs = 60_000
    const bucket1 = bucketStart(Date.now() - 49 * 60_000, intervalMs)

    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(130),
          userId: 'stats-erased-user',
          eventName: 'stats_suppressed_event',
          atMs: bucket1 + 2_000,
        }),
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(131),
          userId: 'stats-erased-user',
          eventName: 'stats_suppressed_event',
          atMs: bucket1 + 3_000,
        }),
        evRowAtMs({
          projectId: projectA,
          eventId: uuid(132),
          userId: 'stats-control-user',
          eventName: 'stats_suppressed_event',
          atMs: bucket1 + 4_000,
        }),
      ],
    })
    // Strictly after both of the erased user's events — "all events before
    // their boundary" is the shape this test exists to catch.
    await suppress(projectA, 'stats-erased-user', new Date(bucket1 + 20_000))

    const since = new Date(bucket1 - 1_000).toISOString()
    const until = new Date(bucket1 + intervalMs - 1_000).toISOString()
    const res = await statsGet(
      `?interval=1m&since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`,
    )
    expect(res.statusCode).toBe(200)
    // Only the control user's single event survives.
    expect(res.json().buckets).toEqual([{ bucket: new Date(bucket1).toISOString(), events: 1 }])
  })

  it('rejects an interval outside the allowlist', async () => {
    // The interval becomes a SQL literal and can never come from request
    // data.
    const res = await statsGet(`?interval=${encodeURIComponent('1 HOUR); DROP TABLE events--')}`)
    expect(res.statusCode).toBe(400)
  })

  it('refuses a window that would exceed STATS_MAX_BUCKETS', async () => {
    // Reachable from an authenticated route: a 1m interval over a year is
    // half a million buckets. 1-minute buckets over
    // (STATS_MAX_BUCKETS + 500) minutes is comfortably past the cap no
    // matter where `now` falls at the instant this runs.
    const since = new Date(Date.now() - (STATS_MAX_BUCKETS + 500) * 60_000).toISOString()
    const res = await statsGet(`?interval=1m&since=${encodeURIComponent(since)}`)
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('window_too_large')
  })
})
