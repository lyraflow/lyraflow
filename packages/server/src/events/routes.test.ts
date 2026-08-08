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
import { EVENTS_MAX_LIMIT } from './routes.js'

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
