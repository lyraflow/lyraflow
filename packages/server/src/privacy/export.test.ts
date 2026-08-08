import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  type ClickHouseClient,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'
import { MAX_PERSON_RANGE_CLAUSES } from '../identity/scope.js'
import { registerExportRoute } from './export.js'
import type { PrivacyDeps } from './routes.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)
// Resolved by the ClickHouse *server* itself, inside the test network — not
// this process's host-mapped localhost:5433. Same pattern as
// privacy/routes.test.ts, identity/person.test.ts, resolve.test.ts.
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

const SLUG_A = 'export-routes-a'
const SLUG_B = 'export-routes-b'
const WRITE_KEY_A = 'wk_export_routes_a'
const SERVER_KEY_A = 'sk_export_routes_a'
const WRITE_KEY_B = 'wk_export_routes_b'
const SERVER_KEY_B = 'sk_export_routes_b'

let app: FastifyInstance
let projectA: number
let projectB: number

/**
 * Fixtures are anchored to the current run, not to absolute dates — the
 * ingest path clamps a client timestamp older than 24h to now-24h, so a
 * hardcoded date silently expires on a wall-clock schedule (see
 * person.test.ts's BASE_MS docstring for the exact failure this bit
 * everyone once already).
 */
const BASE_MS = Date.now() - 6 * 60 * 60 * 1000

/** ClickHouse DateTime64(3) literal, for direct inserts (bypasses the clamp). */
const chAt = (minutes: number) =>
  new Date(BASE_MS + minutes * 60_000).toISOString().replace('T', ' ').replace('Z', '')

/** ISO-8601, for asserting against a wire response built from a chAt(...) offset. */
const isoAt = (minutes: number) => new Date(BASE_MS + minutes * 60_000).toISOString()

/** Same conversion, from an arbitrary Date rather than a BASE_MS offset. */
const chStamp = (d: Date) => d.toISOString().replace('T', ' ').replace('Z', '')

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
 * Cleans both stores for this file's two projects, looking the ids up by
 * slug first rather than trusting `projectA`/`projectB` — a run that died
 * mid-suite leaves ClickHouse `events`/`person_traits` rows behind with the
 * OLD project id, which nothing else cleans up (Postgres `projects` cascade
 * does not reach ClickHouse). Same pattern as privacy/routes.test.ts's own
 * `cleanup()`; run at the TOP of `beforeAll`, not only in `afterAll`, so the
 * file is safe to run standalone three times in a row.
 */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = ANY($1)', [
    [SLUG_A, SLUG_B],
  ])
  const ids = existing.rows.map((r) => Number(r.id))
  if (ids.length > 0) {
    await ch.command({ query: `ALTER TABLE events DELETE WHERE project_id IN (${ids.join(',')})` })
    await ch.command({
      query: `ALTER TABLE person_traits DELETE WHERE project_id IN (${ids.join(',')})`,
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

  projectA = await makeProject(SLUG_A, 'Export Routes A', WRITE_KEY_A, SERVER_KEY_A)
  projectB = await makeProject(SLUG_B, 'Export Routes B', WRITE_KEY_B, SERVER_KEY_B)

  await ensureIdentityDictionaries(ch, pgSource)

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

/**
 * Flushes the ingest buffer synchronously after every identify() — the 202
 * response can return before the row has actually landed in ClickHouse, and
 * every test below reads that data right back out through the export route.
 */
async function identify(writeKey: string, body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/identify',
    headers: { 'x-lyraflow-write-key': writeKey, 'user-agent': UA },
    payload: body,
  })
  await app.deps.buffer.flush()
  return res
}

/** Identifies `userId` with a device bound to it — the ordinary browser-SDK shape. */
async function identifyWithDevice(writeKey: string, userId: string) {
  return identify(writeKey, {
    message_id: randomUUID(),
    anonymous_id: `anon-${userId}`,
    user_id: userId,
  })
}

async function insertEvent(opts: {
  projectId: number
  eventId?: string
  anonymousId?: string
  userId?: string
  timestamp: string
  receivedAt?: string
  eventName: string
}): Promise<void> {
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      {
        project_id: opts.projectId,
        event_id: opts.eventId ?? randomUUID(),
        anonymous_id: opts.anonymousId ?? '',
        user_id: opts.userId ?? '',
        event_name: opts.eventName,
        timestamp: opts.timestamp,
        received_at: opts.receivedAt ?? opts.timestamp,
        trusted: 0,
        properties: {},
        properties_num: {},
      },
    ],
  })
}

function exportReq(id: string, headers: Record<string, string>) {
  return app.inject({
    method: 'GET',
    url: `/v1/persons/${encodeURIComponent(id)}/export`,
    headers,
  })
}

function exportAs(id: string, serverKey: string) {
  return exportReq(id, { 'x-lyraflow-server-key': serverKey })
}

/** NDJSON body -> parsed objects, one per line, skipping any trailing blank line. */
function parseLines(body: string): Array<Record<string, unknown>> {
  return body
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l))
}

describe('GET /v1/persons/:id/export', () => {
  // The write key ships in browser JavaScript. Sent under the SERVER-key
  // header (not the write-key header), same shape as every other server-key
  // route's own version of this test — proves the write key is rejected AS
  // a server key, not merely that no server key was sent.
  it('rejects the write key', async () => {
    const res = await exportAs('irrelevant-id', WRITE_KEY_A)
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('invalid_server_key')
  })

  it('rejects a request with no key at all', async () => {
    const res = await exportReq('irrelevant-id', {})
    expect(res.statusCode).toBe(401)
  })

  it('streams a person line, its events, and a terminating end line', async () => {
    const userId = `exp-basic-${randomUUID()}`
    // 1 event: the identify() call itself.
    const identifyRes = await identifyWithDevice(WRITE_KEY_A, userId)
    expect(identifyRes.statusCode).toBe(202)
    // 2 more events, directly against ClickHouse.
    await insertEvent({
      projectId: projectA,
      userId,
      timestamp: chAt(10),
      eventName: 'exp_event_a',
    })
    await insertEvent({
      projectId: projectA,
      userId,
      timestamp: chAt(20),
      eventName: 'exp_event_b',
    })

    const res = await exportAs(userId, SERVER_KEY_A)
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('application/x-ndjson')

    const lines = parseLines(res.body)
    expect(lines[0]?.type).toBe('person')
    expect(lines[0]?.person_id).toBe(userId)
    expect((lines[0]?.ids as string[])?.sort()).toEqual([`anon-${userId}`, userId].sort())

    const events = lines.filter((l) => l.type === 'event')
    const end = lines.at(-1)
    expect(end?.type).toBe('end')
    // The count in the terminator must equal the lines actually emitted — a
    // caller that trusts a count it cannot check has no way to detect a
    // truncated subject-access response, which is the failure that matters
    // here (see the dedicated mutation proof in the report).
    expect(end?.events).toBe(events.length)
    expect(end?.events).toBe(3)
  })

  // THE test for the boundary itself, discriminating a strict `>` from a
  // `>=` regression: four events, the third landing EXACTLY on the
  // boundary instant. With only three (none exactly on the boundary) both
  // comparisons would agree and this would not catch a `>=` regression.
  it('omits events at or before the deletion boundary', async () => {
    const userId = `exp-boundary-${randomUUID()}`
    const base = Date.now() - 4 * 3_600_000
    const at = (offsetMs: number) => chStamp(new Date(base + offsetMs))
    const boundaryOffsetMs = 2 * 3_600_000

    for (const offsetMs of [0, 3_600_000, boundaryOffsetMs, 3 * 3_600_000]) {
      await insertEvent({
        projectId: projectA,
        userId,
        timestamp: at(offsetMs),
        eventName: 'exp_boundary_event',
      })
    }

    const before = await exportAs(userId, SERVER_KEY_A)
    expect(before.statusCode).toBe(200)
    expect(parseLines(before.body).filter((l) => l.type === 'event')).toHaveLength(4)

    await pg.query(
      'INSERT INTO suppressed_persons (project_id, person_id, suppressed_at) VALUES ($1,$2,$3)',
      [projectA, userId, new Date(base + boundaryOffsetMs)],
    )

    const after = await exportAs(userId, SERVER_KEY_A)
    expect(after.statusCode).toBe(200)
    const lines = parseLines(after.body)
    const afterEvents = lines.filter((l) => l.type === 'event')
    // 1, not 2: the event stamped EXACTLY at the boundary instant is hidden
    // along with the two before it, strictly greater-than.
    expect(afterEvents).toHaveLength(1)
    expect(lines.at(-1)).toEqual({ type: 'end', events: 1 })
    expect(new Date(afterEvents[0]?.timestamp as string).getTime()).toBe(base + 3 * 3_600_000)
  })

  // Matches GET /v1/persons/:id: with nothing surviving the boundary there
  // is no subject left to describe, and a header plus an immediate `end`
  // line would claim the person exists with no data — a different
  // statement than 404. Also proves this is a genuine JSON 404, not an
  // ndjson stream that merely happens to lack an `end` line.
  it('404s a person whose entire history predates the boundary', async () => {
    const userId = `exp-404-${randomUUID()}`
    await insertEvent({
      projectId: projectA,
      userId,
      timestamp: chAt(-60),
      eventName: 'exp_fully_erased',
    })
    await pg.query(
      'INSERT INTO suppressed_persons (project_id, person_id, suppressed_at) VALUES ($1,$2,now())',
      [projectA, userId],
    )

    const res = await exportAs(userId, SERVER_KEY_A)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'person_not_found' })
    expect(res.headers['content-type']).not.toContain('application/x-ndjson')
  })

  // person_traits carries no event time (argMax states keyed by raw
  // identity), so a trait cannot be split at the boundary — returning it
  // would return data the deletion asked to remove. The person is kept
  // alive past the boundary with a fresh event so this exercises the
  // "traits omitted, events still present" case rather than degenerating
  // into the 404 test above.
  it('omits traits once a boundary exists', async () => {
    const userId = `exp-traits-${randomUUID()}`
    const identifyRes = await identify(WRITE_KEY_A, {
      message_id: randomUUID(),
      anonymous_id: `anon-${userId}`,
      user_id: userId,
      traits: { plan: 'pro' },
    })
    expect(identifyRes.statusCode).toBe(202)

    const before = await exportAs(userId, SERVER_KEY_A)
    expect(before.statusCode).toBe(200)
    expect(parseLines(before.body)[0]?.traits).toEqual({ plan: 'pro' })

    const boundaryAt = new Date()
    await pg.query(
      'INSERT INTO suppressed_persons (project_id, person_id, suppressed_at) VALUES ($1,$2,$3)',
      [projectA, userId, boundaryAt],
    )
    // Strictly after the boundary, so the person still has surviving
    // events and this does not degenerate into the 404 case above.
    await insertEvent({
      projectId: projectA,
      userId,
      timestamp: chStamp(new Date(boundaryAt.getTime() + 60_000)),
      eventName: 'exp_post_boundary',
    })

    const after = await exportAs(userId, SERVER_KEY_A)
    expect(after.statusCode).toBe(200)
    const afterLines = parseLines(after.body)
    expect(afterLines.filter((l) => l.type === 'event')).toHaveLength(1)
    expect(afterLines[0]?.traits).toEqual({})
  })

  // THE test for the anonymous-trait leak a review of this task caught: a
  // `user_id = ''` person_traits row is keyed only by anonymous_id, so it
  // cannot itself say which of a device's owners it belongs to. Correct
  // behaviour is compile.ts's own rule for the identical ambiguity — the
  // device's CURRENT owner only, never a past one — which is why this
  // fixture rebinds ONE device between TWO people and asserts both sides:
  // the current owner's export contains the anonymous trait, the previous
  // owner's does not. A version keyed on scope.devices instead of
  // scope.windows (unbounded by time) would leak it into BOTH.
  //
  // Inserted directly against ClickHouse rather than through POST
  // /v1/identify: IdentifyPayload requires a non-empty `id`, so the ingest
  // path itself can never produce a `user_id = ''` identify event today —
  // this is the shape only a future "identify anonymously with traits"
  // feature (or a direct write) could create, which is exactly why the
  // review flagged it as untested rather than merely theoretical.
  it("gives an anonymous trait to a device's current owner only, not a past one", async () => {
    const device = `exp-trait-device-${randomUUID()}`
    const prevOwner = `exp-trait-prev-${randomUUID()}`
    const currentOwner = `exp-trait-current-${randomUUID()}`
    const firstBindAt = new Date(Date.now() - 3 * 3_600_000)
    const rebindAt = new Date(Date.now() - 2 * 3_600_000)

    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at) VALUES
         ($1, $2, $3, $4),
         ($1, $2, $5, $6)`,
      [projectA, device, prevOwner, firstBindAt, currentOwner, rebindAt],
    )
    // Each owner needs an event of their own so their export is a real
    // profile, not the 404 case above.
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      timestamp: chStamp(new Date(firstBindAt.getTime() + 60_000)),
      eventName: 'exp_trait_prev_event',
    })
    await insertEvent({
      projectId: projectA,
      anonymousId: device,
      timestamp: chStamp(new Date(rebindAt.getTime() + 60_000)),
      eventName: 'exp_trait_current_event',
    })

    // The anonymous identify() this test is actually about.
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          project_id: projectA,
          event_id: randomUUID(),
          anonymous_id: device,
          user_id: '',
          event_name: '$identify',
          timestamp: chStamp(new Date(rebindAt.getTime() + 30_000)),
          received_at: chStamp(new Date(rebindAt.getTime() + 30_000)),
          trusted: 0,
          properties: { theme: 'dark' },
          properties_num: {},
        },
      ],
    })

    const currentRes = await exportAs(currentOwner, SERVER_KEY_A)
    expect(currentRes.statusCode).toBe(200)
    expect(parseLines(currentRes.body)[0]?.traits).toEqual({ theme: 'dark' })

    const prevRes = await exportAs(prevOwner, SERVER_KEY_A)
    expect(prevRes.statusCode).toBe(200)
    expect(parseLines(prevRes.body)[0]?.traits).toEqual({})
  })

  // events is a ReplacingMergeTree; a retried delivery that omitted
  // `timestamp` is stored as a permanent second row rather than a
  // self-deduplicating one. Same event_id inserted twice with the same
  // timestamp but different received_at — the shape an at-least-once
  // retry actually produces.
  it('deduplicates a retried delivery', async () => {
    const userId = `exp-dedup-${randomUUID()}`
    const identifyRes = await identifyWithDevice(WRITE_KEY_A, userId)
    expect(identifyRes.statusCode).toBe(202)

    const dupEventId = randomUUID()
    // Merges paused for this window only: `events` is
    // ReplacingMergeTree(received_at), and a background merge collapses
    // duplicate physical rows on its own schedule, keeping whichever has
    // the higher received_at — exactly the same outcome LIMIT 1 BY's own
    // `received_at DESC` is designed to converge on (see the route's own
    // comment). Left to chance, a merge landing before this test's query
    // runs would make the assertions below pass even with LIMIT 1 BY
    // deleted from the route entirely, silently defeating this test's own
    // purpose — this happened for real while proving the mutation (see the
    // report). Stopping merges removes that race rather than hoping to
    // out-run it; `fileParallelism: false` (root vitest.config.ts) is what
    // makes it safe to do from a single test file.
    await ch.command({ query: `SYSTEM STOP MERGES ${CH_DB}.events` })
    try {
      await insertEvent({
        projectId: projectA,
        eventId: dupEventId,
        userId,
        timestamp: chAt(30),
        receivedAt: chAt(30),
        eventName: 'exp_dup_original',
      })
      await insertEvent({
        projectId: projectA,
        eventId: dupEventId,
        userId,
        timestamp: chAt(30),
        receivedAt: chAt(35),
        eventName: 'exp_dup_original',
      })

      const res = await exportAs(userId, SERVER_KEY_A)
      expect(res.statusCode).toBe(200)
      const lines = parseLines(res.body)
      const events = lines.filter((l) => l.type === 'event')
      // 2: the identify() call's own event, plus the retried delivery
      // counted ONCE despite existing as two physical rows.
      expect(events).toHaveLength(2)
      const survivors = events.filter((e) => e.event_id === dupEventId)
      expect(survivors).toHaveLength(1)
      // WHICH physical row survives is not incidental:
      // `(timestamp, event_id)` ties on both duplicates here, so
      // `received_at DESC` is what makes the later-received row (offset
      // 35, the retry) the deterministic survivor — the same row
      // `events`' own ReplacingMergeTree(received_at) engine keeps once it
      // merges the two physical rows, so the answer this endpoint gives
      // cannot change out from under a caller depending on whether that
      // merge has run yet.
      expect(survivors[0]?.received_at).toBe(isoAt(35))
      expect(lines.at(-1)).toEqual({ type: 'end', events: 2 })
    } finally {
      await ch.command({ query: `SYSTEM START MERGES ${CH_DB}.events` })
    }
  })

  it("does not export another project's events for a colliding id", async () => {
    const sharedId = `exp-shared-${randomUUID()}`
    await insertEvent({
      projectId: projectA,
      userId: sharedId,
      timestamp: chAt(100),
      eventName: 'exp_scope_a',
    })
    await insertEvent({
      projectId: projectB,
      userId: sharedId,
      timestamp: chAt(100),
      eventName: 'exp_scope_b_1',
    })
    await insertEvent({
      projectId: projectB,
      userId: sharedId,
      timestamp: chAt(110),
      eventName: 'exp_scope_b_2',
    })

    const resA = await exportAs(sharedId, SERVER_KEY_A)
    expect(resA.statusCode).toBe(200)
    const eventsA = parseLines(resA.body).filter((l) => l.type === 'event')
    expect(eventsA).toHaveLength(1)
    expect(eventsA[0]?.event_name).toBe('exp_scope_a')

    const resB = await exportAs(sharedId, SERVER_KEY_B)
    expect(resB.statusCode).toBe(200)
    expect(parseLines(resB.body).filter((l) => l.type === 'event')).toHaveLength(2)
  })

  // Same cap, same 400 shape, as GET /v1/persons/:id — unlike the deletion
  // route (which chunks and must never refuse to erase), refusing to
  // RENDER an export for the most fragmented people is an acceptable
  // answer.
  it('refuses a person past the window cap with the same 400 as the person read', async () => {
    const deviceIds = Array.from(
      { length: MAX_PERSON_RANGE_CLAUSES + 5 },
      (_, i) => `exp-frag-device-${i}`,
    )
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
       SELECT $1, d, 'exp-fragmented-person', $3::timestamptz
       FROM unnest($2::text[]) AS d`,
      [projectA, deviceIds, new Date()],
    )

    try {
      const res = await exportAs('exp-fragmented-person', SERVER_KEY_A)
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({
        error: 'person_history_too_fragmented',
        detail: `this person spans ${deviceIds.length} device windows, above the limit of ${MAX_PERSON_RANGE_CLAUSES}`,
      })
    } finally {
      await pg.query(
        `DELETE FROM identity_bindings WHERE project_id = $1 AND person_id = 'exp-fragmented-person'`,
        [projectA],
      )
    }
  })
})

/**
 * Forces a genuine mid-stream ClickHouse failure, rather than assuming the
 * try/catch inside the generator behaves as intended. A fake ClickHouse
 * client answers the summary query normally (so the 404 decision passes)
 * and a non-null boundary (so the traits query is skipped entirely, which
 * keeps this fake to exactly the two calls the route actually makes), then
 * has the events query's `stream()` yield one row and throw on the next
 * pull — the shape a real connection drop or a ClickHouse-side timeout
 * mid-transfer produces.
 */
describe('GET /v1/persons/:id/export (mocked ClickHouse): mid-stream failure', () => {
  it('ends the stream without the end line, and without turning into an HTTP error, on a mid-stream failure', async () => {
    const fakeCh = {
      query: async (opts: { query: string }) => {
        // Routed on `ORDER BY timestamp ASC`, not `LIMIT 1 BY` — the dedup
        // mutation proof (see the report) deliberately removes that exact
        // clause from the real route, and keying this fake's dispatch on it
        // would make this test fail for that mutation too, for a reason
        // that has nothing to do with what this test actually checks. Both
        // the summary query and this one select `FROM events`, so that
        // alone cannot discriminate them either.
        if (opts.query.includes('ORDER BY timestamp ASC')) {
          return {
            stream: () => {
              async function* rows() {
                yield [
                  {
                    json: () => ({
                      event_id: 'evt-before-failure',
                      timestamp: '2026-08-07 00:00:00.000',
                      received_at: '2026-08-07 00:00:00.000',
                      event_name: 'exp_before_failure',
                      anonymous_id: '',
                      user_id: 'fail-user',
                      properties: {},
                      properties_num: {},
                      url: '',
                      path: '',
                      referrer: '',
                      utm_source: '',
                      utm_medium: '',
                      utm_campaign: '',
                      utm_term: '',
                      utm_content: '',
                      device_type: '',
                      os: '',
                      browser: '',
                      country: '',
                      region: '',
                      city: '',
                    }),
                  },
                ]
                throw new Error('deliberate mid-stream ClickHouse failure injected for this test')
              }
              return rows()
            },
          }
        }
        // The summary query personEventSummary issues.
        return {
          json: async () => [
            {
              first_seen: '2026-08-07 00:00:00.000',
              last_seen: '2026-08-07 00:00:00.000',
              events: '1',
            },
          ],
        }
      },
    } as unknown as ClickHouseClient

    const fakeProjects = {
      byServerKey: async (key: string) =>
        key === 'sk_fake_export'
          ? { id: 1, slug: 'fake', retentionMonths: 1, monthlyEventQuota: 1 }
          : null,
    } as unknown as PrivacyDeps['projects']
    const fakeBindings = {
      devicesForAny: async () => [],
      mostRecentPersonFor: async () => null,
      bindEventsForDevices: async () => new Map(),
    } as unknown as PrivacyDeps['bindings']
    const fakeAliases = {
      canonicalFor: async (_p: number, id: string) => id,
      mergedFrom: async () => [],
    } as unknown as PrivacyDeps['aliases']
    // Non-null: skips the traits query entirely, which is not this test's
    // concern (see the block docstring above).
    const fakeSuppression = {
      boundaryFor: async () => new Date('2026-01-01T00:00:00.000Z'),
    } as unknown as PrivacyDeps['suppression']

    const readiness = new Readiness()
    readiness.markReady()
    const mockedApp = Fastify()
    registerExportRoute(mockedApp, {
      projects: fakeProjects,
      readiness,
      ch: fakeCh,
      bindings: fakeBindings,
      aliases: fakeAliases,
      suppression: fakeSuppression,
    } as unknown as PrivacyDeps)

    const res = await mockedApp.inject({
      method: 'GET',
      url: '/v1/persons/fail-user/export',
      headers: { 'x-lyraflow-server-key': 'sk_fake_export' },
    })

    // The status line already committed 200 before the failure happened —
    // it cannot retroactively become an HTTP error.
    expect(res.statusCode).toBe(200)
    const lines = parseLines(res.body)
    expect(lines[0]?.type).toBe('person')
    expect(lines.filter((l) => l.type === 'event')).toHaveLength(1)
    // The terminator is the caller's signal that the export is complete —
    // its absence here is the entire point of this test.
    expect(lines.some((l) => l.type === 'end')).toBe(false)

    await mockedApp.close()
  })
})
