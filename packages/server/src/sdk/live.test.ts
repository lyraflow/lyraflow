/** @vitest-environment happy-dom */
// packages/server's own tsconfig deliberately carries no DOM lib (it is a
// Node process) — this one file needs `document`/`window`/`localStorage`
// types because it drives the real browser SDK, so it opts in for itself
// alone rather than widening DOM types across the whole package.
/// <reference lib="dom" />
// The one place the SDK and the server are proven to agree. Every other SDK
// test (packages/sdk-browser) drives a fake transport; every other server
// ingest test (packages/server/src/ingest) drives raw JSON payloads typed by
// hand. This file is the only one where a mismatch between what
// @lyraflow/sdk-browser actually produces and what the real Fastify app
// actually stores has anywhere to show up — both sides are the real,
// imported packages, and the only seam is `fetchImpl`, wired to `app.inject`
// so requests reach the real routes without a socket.
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import * as lyraflow from '@lyraflow/sdk-browser'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { type Config, loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { parseChDateTime } from '../ingest/row.js'

const CH_DB = 'lyraflow_test'
const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

// Fixture ids scoped to this file alone, so they cannot collide with any
// other suite sharing the same live Postgres/ClickHouse.
const SLUG = 'sdk-live-e2e'
const WRITE_KEY = 'wk_sdk_live_e2e'
const ORIGIN = 'https://app.sdk-live-e2e.test'

/**
 * Kept even though it turns out not to be load-bearing for THIS harness:
 * `light-my-request` (what `app.inject` runs on) defaults to
 * `user-agent: lightMyRequest` whenever a caller supplies none, which
 * matches no token in `BOT_TOKENS` — deleting this header entirely was
 * tried, and all four tests in this file still passed. It stays anyway,
 * for two reasons that have nothing to do with that: it makes the
 * device_type/os/browser columns the server derives from a real UA
 * realistic instead of "unknown" for everything this file inserts, and
 * these tests should not depend on a test library's default happening to
 * dodge every bot token rather than on something this file controls.
 *
 * The genuinely load-bearing finding here is about the SERVER, not this
 * harness: `isBot(undefined)` (`packages/core/src/enrich/bots.ts`) returns
 * true, and `BOT_TOKENS` matches `curl/`, `python-requests`, `urllib`,
 * `okhttp`, `axios/`, `java/` and `node-fetch` — UA strings a real,
 * non-browser SDK sends by default unless it deliberately overrides them.
 * `accept()` in `ingest/routes.ts` classifies that as bot traffic, drops
 * the event silently, still answers 202, and writes no dead letter (the
 * bot branch returns before one would be written). Both of this plan's
 * planned server-side SDKs would be silently swallowed on their first
 * request with no way to diagnose it. Recorded, not fixed, here — see the
 * task report.
 */
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

let app: FastifyInstance
let projectId: number

type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>
interface Captured {
  body: string
  response: InjectResponse
}

/**
 * The only seam between the real SDK and the real app: adapts `app.inject`
 * to the `fetchImpl` shape `Transport` (packages/sdk-browser/src/transport.ts)
 * expects. Returns a REAL `Response` (not a hand-rolled lookalike) — a
 * plain object cast `as unknown as Response` would erase the type checker's
 * ability to catch a future `Transport` reading `.ok`, `.json()` or
 * `.text()` and getting `undefined` in silence, and it would throw away the
 * batch response body, which is exactly the evidence this file's replay
 * test needs to prove the SDK's own delivery — not just the test's
 * hand-written replay POST — actually reached the server. `origin` is
 * supplied only when a test asks for it, to simulate a cross-origin
 * `fetch()`; the SDK itself never sets that header (browsers forbid it).
 * `sink`, when given, records the exact request body and the raw injected
 * response (which still has light-my-request's own `.json()`) for a test
 * to inspect afterwards — the SDK's public surface hands back neither.
 */
function makeFetchImpl(
  target: FastifyInstance,
  opts: { origin?: string; sink?: Captured[] } = {},
): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input))
    const headers: Record<string, string> = { 'user-agent': BROWSER_UA }
    if (opts.origin) headers.origin = opts.origin
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v
      }
    }
    const body = init?.body as string | undefined
    const response = await target.inject({
      method: (init?.method as 'GET' | 'POST' | 'OPTIONS' | undefined) ?? 'GET',
      url: url.pathname + url.search,
      headers,
      payload: body,
    })
    if (opts.sink && body !== undefined) opts.sink.push({ body, response })
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    })
  }) as unknown as typeof fetch
}

/**
 * Run at the TOP of `beforeAll`, not only in `afterAll` — a previous crashed
 * run leaves rows behind. `device_index` and `person_traits` are populated
 * by materialised views that fire at INSERT time; deleting from `events`
 * alone never reaches them (same reasoning as segments/execute.test.ts and
 * privacy/end-to-end.test.ts). `mutations_sync: '1'` makes each delete
 * finish before this returns, so a standalone re-run's first insert can
 * never race a still-pending mutation from the previous run.
 */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [SLUG])
  const ids = existing.rows.map((r) => Number(r.id))
  if (ids.length > 0) {
    const list = ids.join(',')
    for (const table of ['events', 'device_index', 'person_traits']) {
      await ch.command({
        query: `ALTER TABLE ${table} DELETE WHERE project_id IN (${list})`,
        clickhouse_settings: { mutations_sync: '1' },
      })
    }
  }
  await pg.query('DELETE FROM projects WHERE slug = $1', [SLUG])
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
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('SDK Live E2E', $1, $2, 'h') RETURNING id`,
    [SLUG, WRITE_KEY],
  )
  projectId = Number(r.rows[0]?.id)

  const config: Config = loadConfig({
    LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
    // Left at its default (not forced to 1 row, unlike most other live
    // ingest tests): every assertion here already goes through an explicit
    // `app.deps.buffer.flush()`, which awaits in-flight batches regardless
    // of the row threshold, so forcing per-row auto-flush bought nothing —
    // and it meant this file, alone among the live tests, never exercised
    // the multi-row insert path production actually uses.
    LYRAFLOW_ALLOWED_ORIGINS: ORIGIN,
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
 * Every test's own clean SDK session — a fresh anonymous id and an empty
 * queue, so one test's identity or leftover storage can never leak into the
 * next. Same pattern as sdk-browser's own index.test.ts beforeEach.
 */
function resetBrowserState(): void {
  localStorage.clear()
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]?.trim()
    if (name) document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
  }
}

describe('the SDK against the real app and ClickHouse', () => {
  it('lands a tracked event with the ids and context the SDK produced', async () => {
    resetBrowserState()
    ;(window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(
      'https://shop.example.test/pricing?utm_source=newsletter&utm_campaign=q3',
    )
    const sink: Captured[] = []
    lyraflow.init({
      host: 'http://sdk-live.test',
      writeKey: WRITE_KEY,
      autoPageView: false,
      fetchImpl: makeFetchImpl(app, { sink }),
    })
    lyraflow.identify('user-live-1')
    lyraflow.track('signed_up', { plan: 'pro' })
    await lyraflow.flush()
    // The 202 the transport sees can return before the row has actually
    // landed in ClickHouse — every read below needs it to have landed.
    await app.deps.buffer.flush()

    const sent = JSON.parse(sink[sink.length - 1]?.body ?? '{}').batch as Array<{
      type: string
      message_id: string
      anonymous_id: string
      context: Record<string, string>
    }>
    const tracked = sent.find((e) => e.type === 'track')
    expect(tracked).toBeDefined()
    if (!tracked) throw new Error('unreachable')

    const rs = await ch.query({
      query: `SELECT event_id, anonymous_id, user_id, url, path, utm_source
              FROM events WHERE project_id = {p:UInt32} AND event_id = {id:String}`,
      query_params: { p: projectId, id: tracked.message_id },
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{
      event_id: string
      anonymous_id: string
      user_id: string
      url: string
      path: string
      utm_source: string
    }>()

    // event_id is the SDK's own message_id, unchanged.
    expect(row?.event_id).toBe(tracked.message_id)
    // anonymous_id survives from init, and user_id is present because
    // identify() ran first — both halves of "both present after identify".
    expect(row?.anonymous_id).toBe(tracked.anonymous_id)
    expect(row?.anonymous_id).not.toBe('')
    expect(row?.user_id).toBe('user-live-1')
    // url/path/utm_source came from the page context the SDK captured, not
    // from anything the test typed into the request by hand.
    expect(row?.url).toBe(tracked.context.url)
    expect(row?.path).toBe(tracked.context.path)
    expect(row?.path).toBe('/pricing')
    expect(row?.utm_source).toBe('newsletter')
  })

  it('preserves the enqueue time across a delayed flush', async () => {
    resetBrowserState()
    lyraflow.init({
      host: 'http://sdk-live.test',
      writeKey: WRITE_KEY,
      autoPageView: false,
      fetchImpl: makeFetchImpl(app),
    })

    const enqueuedAt = Date.now()
    lyraflow.track('delayed_flush_event', { n: 1 })

    // A real wait, not a fake-timer advance — nothing but time passes here.
    const DELAY_MS = 1500
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS))
    const beforeSendAt = Date.now()
    await lyraflow.flush()
    await app.deps.buffer.flush()

    const rs = await ch.query({
      query: `SELECT timestamp FROM events
              WHERE project_id = {p:UInt32} AND event_name = 'delayed_flush_event'
              ORDER BY timestamp DESC LIMIT 1`,
      query_params: { p: projectId },
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{ timestamp: string }>()
    expect(row).toBeDefined()
    const storedMs = parseChDateTime(row?.timestamp ?? '').getTime()

    // Close to the instant track() was called...
    expect(Math.abs(storedMs - enqueuedAt)).toBeLessThan(1000)
    // ...and measurably EARLIER than the instant the network call actually
    // went out. If the timestamp were stamped at send time instead of
    // enqueue time, this gap would be ~0, not ~DELAY_MS.
    expect(beforeSendAt - storedMs).toBeGreaterThanOrEqual(DELAY_MS - 200)
  })

  it('does not double-count a replayed batch', async () => {
    resetBrowserState()
    const sink: Captured[] = []
    lyraflow.init({
      host: 'http://sdk-live.test',
      writeKey: WRITE_KEY,
      autoPageView: false,
      fetchImpl: makeFetchImpl(app, { sink }),
    })

    lyraflow.track('replayed_event', { n: 1 })
    await lyraflow.flush()
    await app.deps.buffer.flush()

    // The exact body the SDK produced — same message_id, same timestamp —
    // AND proof the SDK's OWN delivery actually reached and was accepted by
    // the server. Without the second half, this test cannot tell "two
    // deliveries, deduplicated" from "one delivery, from the hand-written
    // POST below" — which is the entire property under test, and the one
    // the SDK's absent cross-tab lock relies on. /v1/batch's response body
    // is `{ accepted, rejected, throttled }` (ingest/routes.ts); asserting
    // it here is deterministic and needs no new machinery.
    const sdkSend = sink[sink.length - 1]
    expect(sdkSend?.body).toBeTruthy()
    const body = sdkSend?.body
    if (!body) throw new Error('unreachable')
    expect(sdkSend?.response.json()).toEqual({ accepted: 1, rejected: 0, throttled: 0 })

    // A retry or a two-tab race sends this unchanged, a second time. The
    // design relies on this being safe: the SDK has no cross-tab lock, no
    // leader election and no in-flight dedupe, precisely because a query
    // that aggregates by event_id makes a duplicate delivery cost disk, not
    // correctness. Asserted accepted too, for the same reason as the SDK's
    // own send above — this delivery must be real, not merely attempted.
    const replay = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: {
        'content-type': 'application/json',
        'x-lyraflow-write-key': WRITE_KEY,
        'user-agent': BROWSER_UA,
      },
      payload: body,
    })
    expect(replay.json()).toEqual({ accepted: 1, rejected: 0, throttled: 0 })
    await app.deps.buffer.flush()

    const rs = await ch.query({
      query: `SELECT count() AS rows, count(DISTINCT event_id) AS events
              FROM events
              WHERE project_id = {p:UInt32} AND event_name = 'replayed_event'`,
      query_params: { p: projectId },
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{ rows: string; events: string }>()
    expect(Number(row?.events)).toBe(1)
    expect(Number(row?.rows)).toBeGreaterThanOrEqual(1)
  })

  it('is reachable from a browser origin end to end', async () => {
    resetBrowserState()

    // A real browser sends this OPTIONS preflight itself, invisibly to the
    // page's own fetch() call, before the POST below is ever allowed onto
    // the wire — simulated directly here for that reason.
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/batch',
      headers: {
        origin: ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-lyraflow-write-key',
      },
    })
    expect(preflight.statusCode).toBeLessThan(300)
    expect(preflight.headers['access-control-allow-origin']).toBe(ORIGIN)
    expect(preflight.headers['access-control-allow-headers']).toContain('x-lyraflow-write-key')

    // The real POST: the SDK's own transport, through fetchImpl, with the
    // Origin header a cross-origin fetch() carries.
    const sink: Captured[] = []
    lyraflow.init({
      host: 'http://sdk-live.test',
      writeKey: WRITE_KEY,
      autoPageView: false,
      fetchImpl: makeFetchImpl(app, { origin: ORIGIN, sink }),
    })
    lyraflow.track('cors_event')
    await lyraflow.flush()
    await app.deps.buffer.flush()

    expect(sink).toHaveLength(1)
    expect(sink[0]?.response.statusCode).toBe(202)
    expect(sink[0]?.response.headers['access-control-allow-origin']).toBe(ORIGIN)

    const sent = JSON.parse(sink[0]?.body ?? '{}').batch as Array<{ message_id: string }>
    const rs = await ch.query({
      query: `SELECT count() AS c FROM events
              WHERE project_id = {p:UInt32} AND event_id = {id:String}`,
      query_params: { p: projectId, id: sent[0]?.message_id },
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{ c: string }>()
    expect(Number(row?.c)).toBe(1)
  })

  it('stores an event from a page whose URL is longer than the server accepts', async () => {
    // The composition the per-task reviews could not see: the SDK sent
    // `location.href` unbounded, the server's Zod caps `url` at 2048, and a
    // violation rejects the WHOLE event. An OAuth callback with a long
    // `redirect_uri` therefore answered 202, stored nothing, wrote one dead
    // letter, and said nothing on the console. Both halves are real here —
    // the real SDK builds the context, the real app validates it.
    resetBrowserState()
    const long = `https://shop.example.test/callback?redirect_uri=${'x'.repeat(2100)}`
    ;(window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(long)
    expect(location.href.length).toBeGreaterThan(2048)

    const sink: Captured[] = []
    lyraflow.init({
      host: 'http://sdk-live.test',
      writeKey: WRITE_KEY,
      autoPageView: false,
      fetchImpl: makeFetchImpl(app, { sink }),
    })
    lyraflow.track('oauth_return', { plan: 'pro' })
    await lyraflow.flush()
    await app.deps.buffer.flush()

    // The server counted it as accepted, not rejected — the number the
    // transport now reads back and warns about.
    const captured = sink[sink.length - 1]
    expect(captured?.response.json()).toMatchObject({ accepted: 1, rejected: 0 })

    const sent = JSON.parse(captured?.body ?? '{}').batch as Array<{
      message_id: string
      context: Record<string, string>
    }>
    const tracked = sent[0]
    expect(tracked?.context.url).toHaveLength(2048)

    const rs = await ch.query({
      query: `SELECT url, properties['plan'] AS plan FROM events
              WHERE project_id = {p:UInt32} AND event_id = {id:String}`,
      query_params: { p: projectId, id: tracked?.message_id },
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{ url: string; plan: string }>()
    // The row exists at all, which is the point — and it carries the
    // properties that used to be destroyed along with it.
    expect(row?.url).toBe(tracked?.context.url)
    expect(row?.plan).toBe('pro')
  })
})
