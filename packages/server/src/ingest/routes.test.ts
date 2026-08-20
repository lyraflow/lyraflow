import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  type ClickHouseClient,
  type Pool,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../app.js'
import { ensureAdminUser } from '../auth/bootstrap.js'
import { type Project, ProjectCache } from '../auth/project-cache.js'
import { type Config, loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { IngestBuffer } from './buffer.js'
import { monthStart, readCounterRow, seedCounterRow } from './counter-fixtures.js'
import { IngestCounters } from './counters.js'
import { NullGeoResolver } from './geo.js'
import { CardinalityTracker, MAX_PROPERTIES_PER_EVENT } from './limits.js'
import { type IngestDeps, registerIngestRoutes } from './routes.js'
import type { EventRow } from './row.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)
let app: FastifyInstance
let config: Config
let routesTestProjectId = 0
// A real admin session cookie -- see the "POST /v1/alias never accepts a
// session" describe block below, which is the only test in this file that
// needs one.
let adminCookie = ''
const ADMIN_EMAIL = 'ingest-routes-suite-admin@example.test'
const ADMIN_PASSWORD = 'ingest-routes-suite-admin-password'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

/** The cookie value only, from a Set-Cookie header -- same helper as auth/routes.test.ts. */
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
  await pg.query('DELETE FROM projects WHERE slug = $1', ['routes-test'])
  const routesTestProject = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Routes', 'routes-test', 'wk_routes', 'h') RETURNING id`,
  )
  routesTestProjectId = Number(routesTestProject.rows[0]?.id)

  // admin_user is single-tenant (see auth/routes.test.ts, auth/bridge.test.ts)
  // and this file did not previously need one -- cleared here and in
  // afterAll per the shared harness rule, not left for a stray row from a
  // prior run to make the login below ambiguous.
  await pg.query('DELETE FROM admin_user')
  await ensureAdminUser(pg, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD })

  config = loadConfig({
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

  // A real login, not a hand-minted session -- see wiring.test.ts's identical
  // reasoning for why this is what actually proves the boundary rather than
  // a forged cookie a regression could satisfy for the wrong reason.
  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    headers: { 'x-lyraflow-ui': '1' },
    payload: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  })
  const setCookie = login.headers['set-cookie']
  adminCookie = `lf_session=${cookieValue(Array.isArray(setCookie) ? (setCookie[0] ?? '') : (setCookie ?? ''))}`
})

afterAll(async () => {
  // Several tests above (e.g. the batch test) trigger an auto-flush via
  // flushRows without waiting on it. Draining before ch.close() keeps that
  // fire-and-forget insert from being severed mid-flight by the client
  // shutdown, which otherwise logs a spurious ECONNRESET through onError.
  await app.deps.buffer.flush()
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = $1', ['routes-test'])
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

function track(body: Record<string, unknown>, key = 'wk_routes') {
  return app.inject({
    method: 'POST',
    url: '/v1/track',
    headers: { 'x-lyraflow-write-key': key, 'user-agent': UA },
    payload: body,
  })
}

async function countEvents(where: string): Promise<number> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM events WHERE project_id = ${routesTestProjectId} AND ${where}`,
    format: 'JSONEachRow',
  })
  return Number((await rs.json<{ c: string }>())[0]?.c ?? 0)
}

async function countDeadLetters(): Promise<number> {
  const rs = await ch.query({
    query: `SELECT count() AS c FROM events_dead_letter
             WHERE project_id = ${routesTestProjectId} AND reason = 'validation_failed'`,
    format: 'JSONEachRow',
  })
  return Number((await rs.json<{ c: string }>())[0]?.c ?? 0)
}

// This is deliberate, not an oversight: Task 9 wired the admin-session
// bridge (auth/bridge.ts) into every OTHER project-scoped route, but
// /v1/alias stayed on its own server-key-only authenticator
// (`authenticateServer`, built inside registerIngestRoutes) on purpose.
// Aliasing is destructive and project-wide -- it rewrites who a person IS
// for the whole project, irreversibly in v0.1 -- and it is reachable only
// with the secret server key BY DESIGN, never by the write key OR a browser
// session. Pinned here, next to where that authenticator is built, with a
// REAL admin session (not a forged cookie) so a future change that
// accidentally threads the bridge into this one route would show up as a
// newly-passing request, not as a status code that happens to still be 401
// for a different reason.
describe('POST /v1/alias never accepts a session', () => {
  it('refuses a valid admin session with no server key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/alias',
      headers: {
        cookie: adminCookie,
        'x-lyraflow-ui': '1',
        'x-lyraflow-project': String(routesTestProjectId),
        'user-agent': UA,
      },
      payload: { from_user_id: 'a', to_user_id: 'b' },
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'missing_server_key' })
  })
})

describe('ingest routes', () => {
  it('accepts a valid event with 202', async () => {
    const res = await track({
      message_id: randomUUID(),
      anonymous_id: 'a-routes',
      event: 'signup',
      properties: { plan: 'trial' },
    })
    expect(res.statusCode).toBe(202)
  })

  it('writes the event to ClickHouse', async () => {
    const id = randomUUID()
    await track({ message_id: id, anonymous_id: 'a-routes', event: 'persisted' })
    await app.deps.buffer.flush()
    const rs = await ch.query({
      query: `SELECT count() AS c FROM events WHERE event_id = '${id}'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ c: string }>()
    expect(Number(rows[0]?.c)).toBe(1)
  })

  // /v1/identify and /v1/page had no coverage at any level — only their
  // registrations — on an API the project promises to keep backward compatible
  // forever. Deleting either `app.post` line used to leave the suite green.

  it('accepts an identify event and stores it as $identify', async () => {
    const id = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/identify',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: { message_id: id, user_id: 'u-routes', traits: { plan: 'pro' } },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()

    const rs = await ch.query({
      query: `SELECT event_name, user_id, properties['plan'] AS plan FROM events WHERE event_id = '${id}'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ event_name: string; user_id: string; plan: string }>()
    // traits land in the same property maps as track properties, and the
    // event name is synthesised — both are contract, not incidental.
    expect(rows[0]).toEqual({ event_name: '$identify', user_id: 'u-routes', plan: 'pro' })
  })

  it('stores a NAMED page view as $page, with the name as a property (#53)', async () => {
    const id = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/page',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: {
        message_id: id,
        anonymous_id: 'a-page',
        name: 'Pricing',
        context: { path: '/pricing' },
      },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()

    const rs = await ch.query({
      query: `SELECT event_name, path, properties['$page_name'] AS page_name
              FROM events WHERE event_id = '${id}'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ event_name: string; path: string; page_name: string }>()
    // Was `event_name: 'Pricing'`, which is the defect this test used to pin:
    // the page view stopped being a page view and became its own event type,
    // indistinguishable from `track('Pricing')` once stored.
    expect(rows[0]).toEqual({ event_name: '$page', path: '/pricing', page_name: 'Pricing' })
  })

  it('falls back to $page when a page event carries no name', async () => {
    const id = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/page',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: { message_id: id, anonymous_id: 'a-page' },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()

    const rs = await ch.query({
      query: `SELECT event_name FROM events WHERE event_id = '${id}'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ event_name: string }>()
    expect(rows[0]?.event_name).toBe('$page')
  })

  it('rejects an unknown write key with 401', async () => {
    const res = await track({ message_id: randomUUID(), anonymous_id: 'a', event: 'x' }, 'wk_bad')
    expect(res.statusCode).toBe(401)
  })

  it('returns 202 for a malformed payload and records a dead letter', async () => {
    const res = await track({ message_id: 'not-a-uuid', event: 'x' })
    expect(res.statusCode).toBe(202)
    const rs = await ch.query({
      query: "SELECT count() AS c FROM events_dead_letter WHERE reason = 'validation_failed'",
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ c: string }>()
    expect(Number(rows[0]?.c)).toBeGreaterThan(0)
  })

  it('drops bot traffic without writing an event', async () => {
    const id = randomUUID()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'Googlebot/2.1' },
      payload: { message_id: id, anonymous_id: 'a-bot', event: 'signup' },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()
    const rs = await ch.query({
      query: `SELECT count() AS c FROM events WHERE event_id = '${id}'`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ c: string }>()
    expect(Number(rows[0]?.c)).toBe(0)
  })

  // #29: a PHP SDK on ext/curl or a Python SDK on requests announces a
  // transport User-Agent that is in BOT_TOKENS, so its first event was
  // dropped and answered 202 with nothing anywhere to explain it.
  it('accepts an event from a declared server-side SDK despite a bot-looking User-Agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'python-requests/2.31.0' },
      payload: {
        message_id: randomUUID(),
        anonymous_id: 'server-side-caller',
        type: 'track',
        event: 'server_side_event',
        context: { library: { name: 'lyraflow-python', version: '0.1.0' } },
      },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()
    expect(await countEvents("event_name = 'server_side_event'")).toBe(1)
  })

  // The same request WITHOUT the declaration is still dropped. Without this,
  // the test above passes against a filter that was simply deleted.
  it('still drops the same event when it declares no library', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'python-requests/2.31.0' },
      payload: {
        message_id: randomUUID(),
        anonymous_id: 'server-side-caller',
        type: 'track',
        event: 'undeclared_event',
      },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()
    expect(await countEvents("event_name = 'undeclared_event'")).toBe(0)
  })

  // The rule keys on SERVER-SIDE names. A crawler executing JS on an
  // instrumented page sends whatever the page sends, so exempting the
  // browser library would defeat the filter entirely.
  it('still drops a crawler that declares the browser library', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'Googlebot/2.1' },
      payload: {
        message_id: randomUUID(),
        anonymous_id: 'crawler',
        type: 'track',
        event: 'crawler_event',
        context: { library: { name: 'lyraflow-browser', version: '0.5.0' } },
      },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()
    expect(await countEvents("event_name = 'crawler_event'")).toBe(0)
  })

  // #152: a declared server-side SDK is exempt from the TRANSPORT header, and
  // judged on the visitor agent it forwards instead. Before this, a backend
  // honestly passing a crawler's user agent had that crawler stored as a
  // person -- the cooperative case, which is the one the filter exists for.
  it('drops a declared server SDK forwarding a crawler as the visitor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'python-requests/2.31.0' },
      payload: {
        message_id: randomUUID(),
        anonymous_id: 'forwarded-crawler',
        type: 'track',
        event: 'forwarded_crawler_event',
        context: {
          library: { name: 'lyraflow-python', version: '0.1.0' },
          user_agent: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        },
      },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()
    expect(await countEvents("event_name = 'forwarded_crawler_event'")).toBe(0)
  })

  // The other side of the same rule: a real visitor forwarded by the same SDK,
  // over the same bot-looking transport, is kept. Without this the test above
  // passes against a filter that simply stopped exempting server SDKs at all.
  it('keeps a declared server SDK forwarding a real visitor', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'python-requests/2.31.0' },
      payload: {
        message_id: randomUUID(),
        anonymous_id: 'forwarded-human',
        type: 'track',
        event: 'forwarded_human_event',
        context: {
          library: { name: 'lyraflow-python', version: '0.1.0' },
          user_agent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()
    expect(await countEvents("event_name = 'forwarded_human_event'")).toBe(1)
  })

  // A declared SDK that forwards NOTHING must stay exempt, or #29 regresses
  // for every SDK that does not bother to pass the visitor agent through.
  it('keeps a declared server SDK that forwards no visitor agent at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'python-requests/2.31.0' },
      payload: {
        message_id: randomUUID(),
        anonymous_id: 'forwarded-nothing',
        type: 'track',
        event: 'forwarded_nothing_event',
        context: { library: { name: 'lyraflow-python', version: '0.1.0' } },
      },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()
    expect(await countEvents("event_name = 'forwarded_nothing_event'")).toBe(1)
  })

  // Enrichment reads the forwarded agent too, so these events stop recording
  // `unknown` for device/os/browser -- which is what `python-requests` parses
  // to. Asserted on a stored column rather than on the parse, because the
  // column is what a segment or funnel actually reads.
  it('enriches a declared server SDK from the visitor agent, not the transport', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'python-requests/2.31.0' },
      payload: {
        message_id: randomUUID(),
        anonymous_id: 'forwarded-enrich',
        type: 'track',
        event: 'forwarded_enrich_event',
        context: {
          library: { name: 'lyraflow-python', version: '0.1.0' },
          user_agent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()
    // Lowercase: `parseUserAgent`'s tables return `chrome`, not `Chrome`.
    // Asserting os too, because `browser` alone would also match a bot UA
    // that happens to carry a Chrome token -- Googlebot's does.
    expect(
      await countEvents(
        "event_name = 'forwarded_enrich_event' AND browser = 'chrome' AND os = 'macos'",
      ),
    ).toBe(1)
  })

  // A BROWSER payload's own context.user_agent stays ignored. Preferring it
  // there would let any page choose its own device/os/browser and its own bot
  // verdict, which is a change to what the filter means for the traffic it was
  // built for. The transport header still decides.
  it('ignores context.user_agent on a payload declaring no server library', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'Googlebot/2.1' },
      payload: {
        message_id: randomUUID(),
        anonymous_id: 'browser-claiming-human',
        type: 'track',
        event: 'browser_claiming_human_event',
        context: {
          user_agent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        },
      },
    })
    expect(res.statusCode).toBe(202)
    await app.deps.buffer.flush()
    expect(await countEvents("event_name = 'browser_claiming_human_event'")).toBe(0)
  })

  // The reorder's consequence, asserted so it is a decision rather than a
  // surprise: malformed input from a crawler is now a validation rejection
  // with a dead-letter row, where before it was dropped as a bot with none.
  it('dead-letters malformed input from a crawler, rather than dropping it as a bot', async () => {
    const before = await countDeadLetters()
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'Googlebot/2.1' },
      payload: { message_id: 'not-a-uuid', type: 'track', event: 'x' },
    })
    expect(res.statusCode).toBe(202)
    expect(await countDeadLetters()).toBe(before + 1)
  })

  it('accepts a batch and reports per-item outcomes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: {
        batch: [
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a-b', event: 'one' },
          { type: 'track', message_id: 'bad', anonymous_id: 'a-b', event: 'two' },
        ],
      },
    })
    expect(res.statusCode).toBe(202)
    // throttled is always present (even at 0) so an SDK parsing a stable
    // shape never has to special-case its absence.
    expect(res.json()).toEqual({ accepted: 1, rejected: 1, throttled: 0, over_quota: 0, bot: 0 })
  })

  // Without this an SDK author whose first batch vanishes has nothing to
  // look at -- which is the exact experience #29 was filed about.
  it('reports bot drops in the batch response, apart from rejections', async () => {
    // `app` is shared across this whole describe block, and earlier tests
    // above already recorded bot outcomes on its counters -- so the pin
    // reads the delta this request adds, not an absolute total.
    const botBefore = app.deps.counters.totals().bot
    const res = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'Googlebot/2.1' },
      payload: {
        batch: [
          { message_id: randomUUID(), anonymous_id: 'a', type: 'track', event: 'crawled' },
          {
            message_id: randomUUID(),
            anonymous_id: 'b',
            type: 'track',
            event: 'from_sdk',
            context: { library: { name: 'lyraflow-node', version: '0.1.0' } },
          },
        ],
      },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({
      accepted: 1,
      rejected: 0,
      throttled: 0,
      over_quota: 0,
      bot: 1,
    })
    expect(app.deps.counters.totals().bot - botBefore).toBe(1)
  })

  // Every other filter test on this branch sends a batch with ONE outcome in
  // it. That shape cannot catch a pipeline that reaches the right verdict for
  // each item but loses one on the way out -- a counter incremented under the
  // wrong key, a `continue` that skips the tally, a response field that
  // shadows another. The conservation invariant is the assertion that makes
  // it structural: whatever the ingest decides, every item of the batch must
  // land in exactly one bucket, so the five counts sum to the batch length.
  //
  // Baselines throughout, never absolutes: `app` is shared across this whole
  // describe block and earlier tests have already moved the dead-letter table
  // and the bot counter.
  it('splits one batch across accepted, rejected and bot, and conserves the count', async () => {
    const deadLettersBefore = await countDeadLetters()
    const botBefore = app.deps.counters.totals().bot
    const batch = [
      // Declared server-side SDK: exempt from the filter despite the UA.
      {
        message_id: randomUUID(),
        anonymous_id: 'mixed-sdk',
        type: 'track',
        event: 'mixed_declared',
        context: { library: { name: 'lyraflow-node', version: '0.1.0' } },
      },
      // Valid, but undeclared -- so the bot UA drops it.
      {
        message_id: randomUUID(),
        anonymous_id: 'mixed-undeclared',
        type: 'track',
        event: 'mixed_undeclared',
      },
      // Malformed: parse runs BEFORE the bot check, so this is a rejection
      // with a dead letter rather than a silent bot drop.
      { message_id: 'not-a-uuid', anonymous_id: 'mixed-bad', type: 'track', event: 'mixed_bad' },
    ]
    const res = await app.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': 'Googlebot/2.1' },
      payload: { batch },
    })
    expect(res.statusCode).toBe(202)
    const body = res.json() as {
      accepted: number
      rejected: number
      throttled: number
      over_quota: number
      bot: number
    }
    expect(body).toEqual({ accepted: 1, rejected: 1, throttled: 0, over_quota: 0, bot: 1 })

    // Exactly one dead letter: the malformed item and nothing else. A bot
    // drop that also wrote one would make this 2.
    expect(await countDeadLetters()).toBe(deadLettersBefore + 1)
    // And exactly one bot drop, so the response's `bot: 1` is backed by the
    // counter the operator's usage card and the Prometheus label read from.
    expect(app.deps.counters.totals().bot - botBefore).toBe(1)

    // The invariant: nothing was double-counted and nothing vanished.
    expect(body.accepted + body.rejected + body.throttled + body.over_quota + body.bot).toBe(
      batch.length,
    )

    // The accepted one really was stored, and the dropped one really was not.
    await app.deps.buffer.flush()
    expect(await countEvents("event_name = 'mixed_declared'")).toBe(1)
    expect(await countEvents("event_name = 'mixed_undeclared'")).toBe(0)
  })

  it('refuses new events with 503 once draining', async () => {
    // A dedicated app + Readiness, not the shared fixture: Readiness has no
    // "un-drain" (draining is meant to be one-directional, same as
    // production), so mutating the shared instance would leave every test
    // that runs after this one permanently 503ing.
    const drainingReadiness = new Readiness()
    drainingReadiness.markReady()
    const drainingApp = buildApp({ config, pg, ch, readiness: drainingReadiness })
    await drainingApp.ready()
    drainingReadiness.markDraining()

    const res = await drainingApp.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: { message_id: randomUUID(), anonymous_id: 'a', event: 'x' },
    })
    expect(res.statusCode).toBe(503)

    await drainingApp.close()
  })

  it('returns 503 rather than 500 when Postgres is unreachable and the cache has no prior entry', async () => {
    // Nothing listens on this port, so the very first ProjectCache lookup
    // rejects with no cached value to fall back on — the cold-cache-during-an-
    // outage case rule 1 protects. Without app.setErrorHandler, that
    // unhandled rejection would fall through to Fastify's default 500.
    const brokenPg = createPgPool('postgres://lyraflow:lyraflow@localhost:1/lyraflow_test')
    const brokenReadiness = new Readiness()
    brokenReadiness.markReady()
    const brokenApp = buildApp({ config, pg: brokenPg, ch, readiness: brokenReadiness })
    await brokenApp.ready()

    const res = await brokenApp.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: { message_id: randomUUID(), anonymous_id: 'a', event: 'x' },
    })
    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('5')

    await brokenApp.close()
    await brokenPg.end().catch(() => {
      // The pool never established a real connection; end() may itself
      // reject on some platforms. Either way there is nothing left to clean up.
    })
  })

  it('returns 400 for a malformed JSON body, not 503', async () => {
    // Fastify's own body parser throws this before any route handler runs,
    // already carrying the correct 400. The /v1/* error handler must pass a
    // sub-500 status straight through instead of converting it to 503 — bad
    // JSON is a deterministic client error, not something retrying will fix.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: {
        'x-lyraflow-write-key': 'wk_routes',
        'user-agent': UA,
        'content-type': 'application/json',
      },
      payload: '{not valid json',
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 413 for a body over bodyLimit, not 503', async () => {
    // Well-formed JSON, but its serialized size exceeds buildApp's
    // bodyLimit (1_048_576 bytes) — Fastify rejects it before parsing, with
    // a genuine 413. Retrying an oversized body will fail again every time,
    // so this must not become 503 either.
    const oversized = {
      message_id: randomUUID(),
      anonymous_id: 'a',
      event: 'x',
      properties: { blob: 'x'.repeat(2_000_000) },
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_routes', 'user-agent': UA },
      payload: oversized,
    })
    expect(res.statusCode).toBe(413)
  })
})

/**
 * Routes exercised here with fully mocked IngestDeps rather than buildApp,
 * so each test can force a specific failure mode (a synchronous throw from
 * the ClickHouse client, a saturated buffer) deterministically instead of
 * fighting real Postgres/ClickHouse into that state.
 */
describe('ingest routes (mocked deps)', () => {
  const project: Project = {
    id: 99,
    slug: 'mocked',
    retentionMonths: 24,
    monthlyEventQuota: 1_000_000,
    serverKeyHash: 'mocked-server-key-hash',
  }

  // Minimal fakes satisfying only the methods routes.ts actually calls; cast
  // through `unknown` since they don't implement the full class surface —
  // the same pattern counters.test.ts already uses for a fake Pool.
  const projects = {
    byWriteKey: async (key: string) => (key === 'wk_mock' ? project : null),
    byServerKey: async () => null,
  } as unknown as IngestDeps['projects']
  const fakePool = { query: async () => ({ rows: [] }) } as unknown as Pool
  const okCh = { insert: async () => {} } as unknown as ClickHouseClient
  // None of the fixtures in this file exercise identify with both ids, so
  // these fakes only need to satisfy IngestDeps's shape — identity-routes.test.ts
  // is where bindings/aliases behaviour is actually exercised.
  const bindings = { bind: async () => 'noop' as const } as unknown as IngestDeps['bindings']
  const aliases = { alias: async () => 'noop' as const } as unknown as IngestDeps['aliases']

  function buildMockedApp(overrides: Partial<IngestDeps> = {}) {
    const app = Fastify({ logger: false })
    const readiness = new Readiness()
    readiness.markReady()

    const deps: IngestDeps = {
      buffer: new IngestBuffer<EventRow>({
        flushRows: 1000,
        flushIntervalMs: 60_000,
        maxRows: 1000,
        insert: async () => {},
      }),
      projects,
      counters: new IngestCounters(fakePool),
      cardinality: new CardinalityTracker(),
      geo: new NullGeoResolver(),
      readiness,
      ch: okCh,
      bindings,
      aliases,
      ...overrides,
    }
    registerIngestRoutes(app, deps)
    return app
  }

  it('logs a failing dead-letter write rather than swallowing it', async () => {
    // events_dead_letter is the only record of rejected data, so a
    // persistently failing write makes bad-data debugging impossible. Not
    // failing the request is right; being silent about it is not.
    const lines: string[] = []
    const app = Fastify({
      logger: {
        level: 'error',
        stream: {
          write: (line: string) => {
            lines.push(line)
          },
        },
      },
    })
    const readiness = new Readiness()
    readiness.markReady()
    registerIngestRoutes(app, {
      buffer: new IngestBuffer<EventRow>({
        flushRows: 1000,
        flushIntervalMs: 60_000,
        maxRows: 1000,
        insert: async () => {},
      }),
      projects,
      counters: new IngestCounters(fakePool),
      cardinality: new CardinalityTracker(),
      geo: new NullGeoResolver(),
      readiness,
      ch: {
        insert: async () => {
          throw new Error('clickhouse unreachable')
        },
      } as unknown as ClickHouseClient,
      bindings,
      aliases,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: { message_id: 'not-a-uuid', event: 'x' }, // fails validation -> dead-letter path
    })

    expect(res.statusCode).toBe(202) // still must not fail the caller
    // Catches the mutation of restoring the bare `catch {}`: no line is
    // emitted, and a broken dead-letter path stays invisible forever.
    const logged = lines.join('')
    expect(logged).toContain('dead-letter write failed')
    expect(logged).toContain('clickhouse unreachable')
    await app.close()
  })

  it('does not fail the request when a dead-letter write throws synchronously', async () => {
    const throwingCh = {
      insert: () => {
        throw new Error('client not connected') // synchronous, not a rejected promise
      },
    } as unknown as ClickHouseClient

    const mockedApp = buildMockedApp({ ch: throwingCh })
    const res = await mockedApp.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: { message_id: 'not-a-uuid', event: 'x' }, // fails validation -> dead-letter path
    })
    expect(res.statusCode).toBe(202)
    await mockedApp.close()
  })

  it('writes all dead letters from one batch in a single ClickHouse insert call', async () => {
    const insertCalls: Array<{ values: unknown[] }> = []
    const countingCh = {
      insert: async (opts: { values: unknown[] }) => {
        insertCalls.push(opts)
      },
    } as unknown as ClickHouseClient

    const mockedApp = buildMockedApp({ ch: countingCh })
    const res = await mockedApp.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: {
        batch: [
          { type: 'track', message_id: 'bad-1', anonymous_id: 'a', event: 'x' },
          { type: 'track', message_id: 'bad-2', anonymous_id: 'a', event: 'x' },
          { type: 'track', message_id: 'bad-3', anonymous_id: 'a', event: 'x' },
        ],
      },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ accepted: 0, rejected: 3, throttled: 0, over_quota: 0, bot: 0 })
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]?.values).toHaveLength(3)
    await mockedApp.close()
  })

  it('dead-letters a malformed batch envelope as one rejection without touching the items', async () => {
    // The envelope-failure branch of /v1/batch (BatchPayload.safeParse
    // failing) had no coverage. `batch: []` violates the .min(1) bound, so
    // this exercises the branch that answers 202 with rejected: 1 and writes
    // exactly one dead letter for the whole request. Deleting that branch's
    // writeDeadLetters call, or folding it into the per-item loop, changes
    // what this asserts.
    const insertCalls: Array<{ values: unknown[] }> = []
    const countingCh = {
      insert: async (opts: { values: unknown[] }) => {
        insertCalls.push(opts)
      },
    } as unknown as ClickHouseClient

    const mockedApp = buildMockedApp({ ch: countingCh })
    const res = await mockedApp.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: { batch: [] },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ accepted: 0, rejected: 1, throttled: 0, over_quota: 0, bot: 0 })
    expect(insertCalls).toHaveLength(1)
    expect(insertCalls[0]?.values).toHaveLength(1)
    await mockedApp.close()
  })

  it('stops a batch and returns 503 once the buffer saturates, rather than treating overload as rejected', async () => {
    const saturatingBuffer = new IngestBuffer<EventRow>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 1, // first add() succeeds; every add() after reports 'overloaded'
      insert: async () => {},
    })

    const mockedApp = buildMockedApp({ buffer: saturatingBuffer })
    const res = await mockedApp.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: {
        batch: [
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a', event: 'one' },
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a', event: 'two' },
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a', event: 'three' },
        ],
      },
    })

    expect(res.statusCode).toBe(503)
    expect(res.headers['retry-after']).toBe('5')
    // Item 1 was accepted before saturation hit; items 2 and 3 were never
    // attempted (throttled), and none is folded into `rejected` — a
    // retry-able condition must stay distinguishable from bad data.
    expect(res.json()).toEqual({ accepted: 1, rejected: 0, throttled: 2, over_quota: 0, bot: 0 })
    await mockedApp.close()
  })

  it('counts every un-attempted batch item as throttled, matching the response body exactly', async () => {
    const saturatingBuffer = new IngestBuffer<EventRow>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 1, // first add() succeeds; every add() after reports 'overloaded'
      insert: async () => {},
    })
    const counters = new IngestCounters(fakePool)

    const mockedApp = buildMockedApp({ buffer: saturatingBuffer, counters })
    const res = await mockedApp.inject({
      method: 'POST',
      url: '/v1/batch',
      headers: { 'x-lyraflow-write-key': 'wk_mock', 'user-agent': UA },
      payload: {
        batch: [
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a', event: 'one' },
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a', event: 'two' },
          { type: 'track', message_id: randomUUID(), anonymous_id: 'a', event: 'three' },
        ],
      },
    })

    const body = res.json() as { accepted: number; rejected: number; throttled: number }
    // This equality is the invariant that matters: the metric/quota counter
    // and the response the SDK sees must never disagree about how many
    // events were throttled. accept() only counts the one item it actually
    // attempted (item i) — the batch.length - i - 1 items the loop never
    // reached must be recorded too, or a dashboard reads 1 while the SDK
    // retries 2.
    expect(counters.totals().throttled).toBe(body.throttled)
    expect(body.throttled).toBe(2)
    await mockedApp.close()
  })
})

/**
 * Quota enforcement, driven through the real HTTP path against live
 * Postgres — a real ProjectCache, a real IngestCounters, a real
 * CardinalityTracker — with only ClickHouse faked, since none of these
 * assertions is about what was stored there.
 *
 * DEFEATING THE PROJECT CACHE. buildApp's ProjectCache holds a positive
 * entry for 60 seconds, so `setQuota` followed by a request would otherwise
 * be answered from a project loaded before the quota existed, and every test
 * here would pass or fail on whether the cache happened to be cold. This
 * block therefore builds its own app around `new ProjectCache(pg, 0)`: a
 * zero TTL makes `#read` report every entry as stale, so each request
 * re-reads the project and sees the quota the test just set. That is a
 * deliberate, visible construction rather than a lucky one — the tests do
 * not touch cache internals, and they do not depend on ordering.
 *
 * A FRESH APP PER TEST for the same class of reason: the persisted-usage
 * cache and the pending tallies both live for the lifetime of one
 * registration, and sharing either across tests would make each test's
 * result depend on the ones before it.
 */
describe('ingest quota enforcement', () => {
  const SLUG = 'routes-quota-test'
  const WRITE_KEY = 'wk_routes_quota'
  // A second project, used only by the cross-project test. Every other test
  // here drives one project, which is exactly why that test is needed.
  const SLUG_B = 'routes-quota-test-b'
  const WRITE_KEY_B = 'wk_routes_quota_b'

  let projectId: number
  let projectIdB: number
  let quotaApp: FastifyInstance
  let counters: IngestCounters
  let buffer: IngestBuffer<EventRow>
  let stored: EventRow[]
  let deadLetterInserts: number
  let usageReads: number

  // Counts only the quota's own usage SELECT (IngestCounters.persistedAccepted)
  // and forwards everything to the real pool. flush()'s `INSERT INTO
  // ingest_counters` deliberately does not match. This is what lets a test
  // assert the difference between "one read per project per TTL" and "one
  // read per event", which no assertion on status codes can see.
  const countingPg = {
    query: (text: string, values?: unknown[]) => {
      if (text.includes('FROM ingest_counters')) usageReads++
      return pg.query(text, values)
    },
  } as unknown as Pool

  const bindings = { bind: async () => 'noop' as const } as unknown as IngestDeps['bindings']
  const aliases = { alias: async () => 'noop' as const } as unknown as IngestDeps['aliases']

  function validEvent(): Record<string, unknown> {
    return { message_id: randomUUID(), anonymous_id: 'a-quota', event: 'quota' }
  }

  function post(url: string, payload: unknown, key = WRITE_KEY) {
    return quotaApp.inject({
      method: 'POST',
      url,
      headers: { 'x-lyraflow-write-key': key, 'user-agent': UA },
      payload: payload as Record<string, unknown>,
    })
  }

  async function setQuota(quota: number | null, id = projectId): Promise<void> {
    await pg.query('UPDATE projects SET monthly_event_quota = $2 WHERE id = $1', [id, quota])
  }

  /**
   * The wiring every test in this block shares: real Postgres behind a real
   * ProjectCache with a zero TTL (see this describe's own docstring), real
   * counters, a capturing buffer, and a counting ClickHouse fake. A test that
   * needs a different pool, a shorter usage TTL or a real logger passes
   * overrides rather than hand-rolling the whole registration, so no variant
   * can quietly differ from the default in some second respect.
   */
  function buildQuotaApp(overrides: Partial<IngestDeps> = {}, app?: FastifyInstance) {
    const readiness = new Readiness()
    readiness.markReady()
    const instance = app ?? Fastify({ logger: false })
    registerIngestRoutes(instance, {
      buffer,
      projects: new ProjectCache(pg, 0),
      counters,
      cardinality: new CardinalityTracker(),
      geo: new NullGeoResolver(),
      readiness,
      ch: {
        insert: async () => {
          deadLetterInserts++
        },
      } as unknown as ClickHouseClient,
      bindings,
      aliases,
      ...overrides,
    })
    return instance
  }

  beforeAll(async () => {
    await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG, SLUG_B]])
    const r = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Routes Quota', $1, $2, 'h') RETURNING id`,
      [SLUG, WRITE_KEY],
    )
    projectId = Number(r.rows[0]?.id)
    const b = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Routes Quota B', $1, $2, 'h') RETURNING id`,
      [SLUG_B, WRITE_KEY_B],
    )
    projectIdB = Number(b.rows[0]?.id)
  })

  afterAll(async () => {
    await pg.query('DELETE FROM ingest_counters WHERE project_id = ANY($1)', [
      [projectId, projectIdB],
    ])
    await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [[SLUG, SLUG_B]])
  })

  beforeEach(async () => {
    await pg.query('DELETE FROM ingest_counters WHERE project_id = ANY($1)', [
      [projectId, projectIdB],
    ])
    await setQuota(null)
    await setQuota(null, projectIdB)
    usageReads = 0
    deadLetterInserts = 0
    stored = []
    counters = new IngestCounters(countingPg)
    buffer = new IngestBuffer<EventRow>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 1000,
      insert: async (rows) => {
        stored.push(...rows)
      },
    })
    quotaApp = buildQuotaApp()
    await quotaApp.ready()
  })

  afterEach(async () => {
    await quotaApp.close()
  })

  it('answers 429 with quota_exceeded once the project is over', async () => {
    await setQuota(2)
    await post('/v1/track', validEvent()) // 1
    await post('/v1/track', validEvent()) // 2
    const res = await post('/v1/track', validEvent())
    expect(res.statusCode).toBe(429)
    expect(res.json()).toEqual({ error: 'quota_exceeded' })
  })

  it('sends no retry-after on a quota refusal', async () => {
    // 503 means "the buffer is full, come back shortly" and carries
    // retry-after. A quota refusal holds until the month rolls over, so the
    // header's presence would invite exactly the retry this design prevents.
    await setQuota(1)
    await post('/v1/track', validEvent())
    const res = await post('/v1/track', validEvent())
    expect(res.statusCode).toBe(429)
    expect(res.headers['retry-after']).toBeUndefined()
  })

  it('never counts a refusal toward the quota it reports', async () => {
    // Otherwise the hole deepens as it is reported, and events_accepted
    // diverges from what was actually stored.
    await setQuota(1)
    await post('/v1/track', validEvent())
    await post('/v1/track', validEvent())
    await post('/v1/track', validEvent())
    await counters.flush()
    const row = await readCounterRow(pg, projectId)
    expect(row.events_accepted).toBe('1')
    expect(row.events_over_quota).toBe('2')
  })

  it('a flood of INVALID events never exhausts the quota', async () => {
    // THE attack this design turns on. Rejected events store nothing, so
    // counting them would let an attacker burn a project's quota for free --
    // cheaper than the flood the quota exists to stop.
    await setQuota(3)
    for (let i = 0; i < 50; i++) await post('/v1/track', { nonsense: true })
    const res = await post('/v1/track', validEvent())
    expect(res.statusCode).toBe(202)
  })

  it('lets an unlimited project through without reading usage', async () => {
    await setQuota(null)
    for (let i = 0; i < 20; i++) {
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    }
    // The brief's title asserted "without reading usage" and nothing checked
    // it. A quota of null is decided from the project row alone, so the
    // usage table must never be touched: on a deployment that has set no
    // quota -- which, after migration 011, is every deployment -- this is
    // the difference between zero Postgres round trips on the hot path and
    // one per project per TTL forever.
    expect(usageReads).toBe(0)
  })

  it('a batch entirely over quota still answers 202, reporting the counts', async () => {
    // /v1/batch never fails wholesale over one event -- its contract is a 202
    // carrying the tally. The SDK's own reporting path reads that body.
    await setQuota(1)
    await post('/v1/track', validEvent())
    const res = await post('/v1/batch', {
      batch: [
        { type: 'track', ...validEvent() },
        { type: 'track', ...validEvent() },
      ],
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: 0, over_quota: 2 })
    // Not folded into `rejected`: these events are well-formed, and an SDK
    // told they were rejected would warn the developer about bad data that
    // does not exist.
    expect(res.json()).toEqual({ accepted: 0, rejected: 0, throttled: 0, over_quota: 2, bot: 0 })
  })

  // --- Not in the brief. ---

  it('refuses on the PERSISTED total alone, before this process has accepted anything', async () => {
    // Every prescribed test above drives the count entirely through this
    // process's pending tally, so an implementation that ignored
    // persistedAccepted and compared `pending >= quota` would pass all six
    // -- and would reset every project's usage to zero on each restart,
    // which is a quota that can be cleared by rebooting the server.
    await seedCounterRow(pg, projectId, monthStart(0), { accepted: 5 })
    await setQuota(5)
    const res = await post('/v1/track', validEvent())
    expect(res.statusCode).toBe(429)
    expect(usageReads).toBe(1)
  })

  it('counts only the current month of persisted usage', async () => {
    // The mirror of the test above: a previous month's spend must not follow
    // a project into the new one, or every quota becomes permanent after the
    // first month that exhausts it.
    await seedCounterRow(pg, projectId, monthStart(-1), { accepted: 999 })
    await setQuota(5)
    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
  })

  it('still counts a MALFORMED event from an over-quota project as rejected, not over_quota', async () => {
    // The reason the check sits after validation, asserted directly. Moving
    // it earlier does NOT fail the invalid-flood test above -- that test is
    // protected by pendingAccepted summing only `accepted`, not by where the
    // check sits -- so nothing else here can see the difference. What moves
    // is the answer and the bookkeeping: a malformed event would come back
    // 429 instead of 202, breaking the rule that bad data never errors a
    // customer's site, and would land in events_over_quota with no dead
    // letter, leaving both counters unable to say what actually happened.
    await setQuota(1)
    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    const res = await post('/v1/track', { nonsense: true })
    expect(res.statusCode).toBe(202)
    expect(deadLetterInserts).toBe(1)

    await counters.flush()
    const row = await readCounterRow(pg, projectId)
    expect(row.events_rejected).toBe('1')
    expect(row.events_over_quota).toBe('0')
  })

  it('still counts a CARDINALITY-limited event from an over-quota project as throttled', async () => {
    // The other half of the ordering property. The malformed-event test above
    // covers only the safeParse branch, so hoisting the whole quota stretch
    // above checkLimits passes every other test in this file -- and is not
    // equivalent: a cardinality-limited event from an over-quota project
    // would answer 429 instead of 202 (breaking the rule that bad data never
    // errors the customer's site), land in over_quota instead of throttled,
    // and write NO dead letter, losing the only record of the cardinality
    // breach.
    await setQuota(1)
    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)

    const overWide = {
      message_id: randomUUID(),
      anonymous_id: 'a-quota',
      event: 'quota',
      properties: Object.fromEntries(
        Array.from({ length: MAX_PROPERTIES_PER_EVENT + 1 }, (_, i) => [`k${i}`, i]),
      ),
    }
    const res = await post('/v1/track', overWide)

    expect(res.statusCode).toBe(202)
    expect(deadLetterInserts).toBe(1)
    // throttled, not over_quota, and not rejected either -- the last would
    // mean the payload failed validation and this test stopped exercising
    // the cardinality branch at all.
    expect(counters.totals()).toMatchObject({
      accepted: 1,
      throttled: 1,
      over_quota: 0,
      rejected: 0,
    })
  })

  it('an event dropped by buffer saturation never consumes quota', async () => {
    // README: "events dropped when the buffer saturates leave it untouched".
    // Nothing pinned it: hoisting record(..., 'accepted') above buffer.add
    // passes every other test here, and turns backpressure into quota spend
    // -- a project driven to 429 by events the server itself refused to
    // store. That is the same class as counting rejections, arrived at from
    // the opposite side.
    const saturating = new IngestBuffer<EventRow>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 2, // the first two events fit; every one after is 'overloaded'
      insert: async () => {},
    })
    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({ buffer: saturating })
    await quotaApp.ready()
    await setQuota(3)

    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await post('/v1/track', validEvent())).statusCode)

    // Never 429: only two events were ever stored, so the quota of three was
    // never reached. Hoisting the record gives [202,202,503,429,429].
    expect(statuses).toEqual([202, 202, 503, 503, 503])
    expect(counters.totals()).toMatchObject({ accepted: 2, throttled: 3, over_quota: 0 })
  })

  it('reads persisted usage once per project, not once per event', async () => {
    // The hot-path property, and nothing in the brief's six tests can see
    // it: all of them pass identically against a Postgres round trip per
    // event. Ten injected requests complete in milliseconds, far inside
    // QUOTA_USAGE_TTL_MS, so exactly one read is expected -- and a
    // per-event implementation produces ten.
    await setQuota(100)
    for (let i = 0; i < 10; i++) {
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    }
    expect(usageReads).toBe(1)
  })

  it('a refused event occupies neither the buffer nor the dead-letter table', async () => {
    // Placement, asserted rather than described: before buffer.add, so a
    // refusal costs no buffer memory (the resource IngestBuffer's maxRows
    // bound exists to protect), and with no dead letter, because the event
    // is valid and events_dead_letter is the record of data that could not
    // be parsed.
    await setQuota(1)
    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
    await buffer.flush()
    expect(stored).toHaveLength(1)
    expect(deadLetterInserts).toBe(0)
  })

  it('keeps accepting events when the usage read itself fails, and says so in the log', async () => {
    // The quota check put a Postgres read on the hot path, so it also put
    // Postgres's availability there. A blip must not turn into a
    // project-wide refusal of events that were nowhere near the limit --
    // the same "stale beats unavailable" rule ProjectCache follows, and the
    // same priority the spec sets: keep collecting events. Failing closed
    // here would be an outage of the customer's analytics caused by an
    // outage of ours, and nothing else in this file would notice.
    //
    // It must not be silent either: a permanently failing usage read means
    // the quota is no longer being enforced from persisted state at all.
    const failingPg = {
      query: (text: string, values?: unknown[]) =>
        text.includes('FROM ingest_counters')
          ? Promise.reject(new Error('connection reset'))
          : pg.query(text, values),
    } as unknown as Pool

    const lines: string[] = []
    const app = Fastify({
      logger: {
        level: 'error',
        stream: {
          write: (line: string) => {
            lines.push(line)
          },
        },
      },
    })
    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({ counters: new IngestCounters(failingPg) }, app)
    await quotaApp.ready()
    await setQuota(5)

    const res = await post('/v1/track', validEvent())
    expect(res.statusCode).toBe(202)
    expect(lines.join('')).toContain('quota usage read failed')
  })

  it('a FAILING usage read costs one Postgres attempt per TTL, not one per event', async () => {
    // The fail-open path is right; caching nothing on the way out was not.
    // Single-flight only coalesces requests that overlap a read's latency,
    // and the classic outage -- ECONNREFUSED against a Postgres that is
    // down -- fails in microseconds with nothing to overlap. Without a
    // negative entry, every subsequent event starts its own doomed query:
    // measured at 10 attempts for 10 sequential events and 200 for 200
    // concurrent ones. That inverts the one mechanism this task exists to
    // install into 1:1 with traffic, under exactly the condition that makes
    // queries expensive, driven by a public browser-shipped write key
    // against a `max: 10` pool.
    let attempts = 0
    const failingPg = {
      query: (text: string, values?: unknown[]) => {
        if (text.includes('FROM ingest_counters')) {
          attempts++
          return Promise.reject(new Error('ECONNREFUSED'))
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({
      counters: new IngestCounters(failingPg),
      // Long enough that the whole test runs inside one window, so the count
      // below is "attempts per outage", not "attempts per elapsed second".
      quotaUsageTtlMs: 60_000,
    })
    await quotaApp.ready()
    // Comfortably above the 410 events below: with the read failing, the
    // pending tally is the only thing enforcing the quota, and a small
    // quota would refuse events for that reason instead of exercising the
    // query count this test is about.
    await setQuota(100_000)

    for (let i = 0; i < 10; i++) {
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    }
    const wave = await Promise.all(
      Array.from({ length: 200 }, () => post('/v1/track', validEvent())),
    )
    expect(wave.every((r) => r.statusCode === 202)).toBe(true)
    const second = await Promise.all(
      Array.from({ length: 200 }, () => post('/v1/track', validEvent())),
    )
    expect(second.every((r) => r.statusCode === 202)).toBe(true)

    // 410 events, one query. Before the negative entry: 410.
    expect(attempts).toBe(1)
  })

  it('retries a failing usage read once the negative entry expires', async () => {
    // The other half of the bound: a failure must not disable the read for
    // the life of the process either, or a quota stops being enforced from
    // persisted state after the first blip and nothing ever reconsiders.
    let attempts = 0
    const failingPg = {
      query: (text: string, values?: unknown[]) => {
        if (text.includes('FROM ingest_counters')) {
          attempts++
          return Promise.reject(new Error('ECONNREFUSED'))
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({
      counters: new IngestCounters(failingPg),
      quotaUsageTtlMs: 20,
    })
    await quotaApp.ready()
    await setQuota(5)

    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    expect(attempts).toBe(1)
    await new Promise((r) => setTimeout(r, 40))
    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    expect(attempts).toBe(2)
  })

  it('re-reads the persisted figure once the TTL expires, rather than freezing it', async () => {
    // The entire refresh half of the cache was unreachable: every other test
    // here finishes in milliseconds, far inside the production 5s TTL, so
    // three independent mutations left the suite green -- deleting the TTL
    // comparison (an entry that never expires), deleting the month test, and
    // deleting `.finally(() => usageInflight.delete(...))`.
    //
    // That last one is the severe member of the class: the settled promise
    // stays in the in-flight map forever, every later call falls through to
    // it, and its `.then` never runs again -- so the persisted figure
    // FREEZES at its first value for the life of the process. That is a
    // quota that resets on restart, which is the exact failure the
    // persisted-total test above exists to prevent, reached by another
    // route. Asserting on the decision rather than only on the query count
    // catches all three: a frozen or never-expiring figure still reads 0
    // here, and still answers 202.
    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({ quotaUsageTtlMs: 20 })
    await quotaApp.ready()
    await setQuota(5)

    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    expect(usageReads).toBe(1)

    // Someone else -- another process, or the counter flush -- moves the
    // project to its limit while this process holds a cached zero.
    await seedCounterRow(pg, projectId, monthStart(0), { accepted: 5 })
    await new Promise((r) => setTimeout(r, 40))

    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
    expect(usageReads).toBe(2)
  })

  it('discards a cached figure belonging to the previous month, inside the TTL', async () => {
    // The month test in the cache, which the TTL seam alone cannot reach:
    // this needs the clock to cross a month boundary while the entry is
    // still FRESH, or the TTL expiry would refetch anyway and prove nothing.
    //
    // Only Date is faked -- not setTimeout/setInterval -- so the live pool's
    // own timers and socket I/O are untouched and the queries below are
    // real. Faking all timers here would stall the pool instead.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 900)))
      await seedCounterRow(pg, projectId, monthStart(0), { accepted: 5 })
      await setQuota(5)

      // January is spent, so the project is refused.
      expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
      expect(usageReads).toBe(1)

      // 200ms later -- far inside the 5s TTL -- but a different month, in
      // which the project has spent nothing.
      vi.setSystemTime(new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 100)))
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
      expect(usageReads).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses correctly when a CONCURRENT burst all joins one usage read', async () => {
    // The shape every other quota test in this file avoids, and the reason a
    // Critical survived ten reviews: every one of them issues a single
    // request at a time, and the only concurrent waves here run against a
    // permanently FAILING pool with a quota chosen so it can never refuse.
    // Nothing fired concurrent requests at a healthy pool near a boundary.
    //
    // The defect that shape hides: while the pending tally was read behind
    // `await projectOverQuota(...)`, every request joining one in-flight
    // usage read resumed in the same microtask drain, all read `pending`
    // before any of them had recorded, and all were admitted. Against a
    // quota of 10 this stored 200 events and counted `over_quota` zero
    // times -- no refusal, no metric, nothing to notice it by. The window is
    // the usage read's latency, and under the very flood a quota exists to
    // stop, pool queueing IS that latency.
    //
    // Latency is injected rather than hoped for: 150ms is far longer than
    // 200 in-process requests need to reach the check, so the whole burst
    // provably decides from one read -- asserted below as attempts === 1.
    const QUOTA = 10
    const BURST = 200
    let attempts = 0
    const slowPg = {
      query: async (text: string, values?: unknown[]) => {
        if (text.includes('FROM ingest_counters')) {
          attempts++
          await new Promise((r) => setTimeout(r, 150))
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    await setQuota(QUOTA)
    // A real 60s cache, warmed before the burst, so 200 project lookups do
    // not queue on the pool and stagger the requests apart -- the burst has
    // to arrive at the quota check together for this to test anything.
    const projects = new ProjectCache(pg, 60_000)
    await projects.byWriteKey(WRITE_KEY)
    const burstCounters = new IngestCounters(slowPg)

    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({ counters: burstCounters, projects })
    await quotaApp.ready()

    const results = await Promise.all(
      Array.from({ length: BURST }, () => post('/v1/track', validEvent())),
    )

    // One read for the whole burst: this is the interleaving, not a detail.
    expect(attempts).toBe(1)
    expect(results.filter((r) => r.statusCode === 202)).toHaveLength(QUOTA)
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(BURST - QUOTA)
    // And the counters agree with the answers given, so a burst cannot pass
    // silently: `over_quota` at zero was the loudest part of the defect.
    expect(burstCounters.totals().accepted).toBe(QUOTA)
    expect(burstCounters.totals().over_quota).toBe(BURST - QUOTA)
    // Nothing beyond the quota reached the buffer either.
    await buffer.flush()
    expect(stored).toHaveLength(QUOTA)
  })

  it('keeps refusing an over-quota project on the LAST KNOWN figure once the read starts failing', async () => {
    // Every other failure test here drives a pool that is permanently
    // healthy or permanently failing, so the fallback expression is only
    // ever evaluated against an EMPTY cache -- where "last known figure" and
    // "zero" are the same answer. This one crosses from healthy to failing
    // with a figure already cached, which is the only state that tells them
    // apart.
    //
    // Turning that fallback into a bare 0 admits a project already past its
    // limit for the whole outage: fail-open is the right direction for a
    // project nothing is known about, not a licence to forget what was
    // known a moment ago.
    let failing = false
    let attempts = 0
    const flakyPg = {
      query: (text: string, values?: unknown[]) => {
        if (text.includes('FROM ingest_counters')) {
          attempts++
          if (failing) return Promise.reject(new Error('ECONNREFUSED'))
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({ counters: new IngestCounters(flakyPg), quotaUsageTtlMs: 20 })
    await quotaApp.ready()
    await seedCounterRow(pg, projectId, monthStart(0), { accepted: 5 })
    await setQuota(5)

    // Healthy: the project is at its limit and refused.
    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
    expect(attempts).toBe(1)

    failing = true
    await new Promise((r) => setTimeout(r, 40))

    // The read is attempted and throws: the catch must fall back to the last
    // known figure for this month, not to zero.
    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
    expect(attempts).toBe(2)

    // And the negative entry must serve that same figure without a read --
    // the second, separately-mutable copy of the fallback.
    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
    expect(attempts).toBe(2)
  })

  it('falls back to zero, not to last month, when the read fails across a month boundary', async () => {
    // The failure path's own copy of the month check. During an outage
    // spanning a month boundary, a fallback that ignores the entry's month
    // keeps refusing a project into a month it has spent nothing of -- the
    // fail-CLOSED direction, reached through the failure path rather than
    // through the freshness check M11 covers.
    let failing = false
    let attempts = 0
    const flakyPg = {
      query: (text: string, values?: unknown[]) => {
        if (text.includes('FROM ingest_counters')) {
          attempts++
          if (failing) return Promise.reject(new Error('ECONNREFUSED'))
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 0, 31, 23, 59, 59, 900)))
      await quotaApp.close() // the beforeEach app; this test needs its own wiring
      quotaApp = buildQuotaApp({ counters: new IngestCounters(flakyPg) })
      await quotaApp.ready()
      await seedCounterRow(pg, projectId, monthStart(0), { accepted: 5 })
      await setQuota(5)

      expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
      expect(attempts).toBe(1)

      // Postgres goes away, and the month rolls over while it is away.
      failing = true
      vi.setSystemTime(new Date(Date.UTC(2026, 1, 1, 0, 0, 0, 100)))

      // February is unknown, not spent. Zero is the honest fallback; last
      // month's figure is not.
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
      expect(attempts).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("never lets one project's FAILING read suppress another project's", async () => {
    // The negative map needs its own cross-project test: keying only
    // usageFailedAt by a constant, with usage and usageInflight left
    // per-project, passes every other test in this block. The consequence is
    // a quota bypass on one tenant triggered by an unrelated tenant's
    // outage -- A's failure suppresses B's perfectly healthy read for a
    // whole TTL, and B is answered from an empty fallback.
    let attempts = 0
    const perProjectPg = {
      query: (text: string, values?: unknown[]) => {
        if (text.includes('FROM ingest_counters')) {
          attempts++
          // Only project A's usage read fails. B's Postgres is fine.
          if (Number(values?.[0]) === projectId) {
            return Promise.reject(new Error('ECONNREFUSED'))
          }
        }
        return pg.query(text, values)
      },
    } as unknown as Pool

    await quotaApp.close() // the beforeEach app; this test needs its own wiring
    quotaApp = buildQuotaApp({ counters: new IngestCounters(perProjectPg) })
    await quotaApp.ready()
    await seedCounterRow(pg, projectIdB, monthStart(0), { accepted: 5 })
    await setQuota(5)
    await setQuota(5, projectIdB)

    // A's read fails, so A fails open.
    expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    // B is at its limit and its own read works. A's failure must not answer
    // for it.
    expect((await post('/v1/track', validEvent(), WRITE_KEY_B)).statusCode).toBe(429)
    expect(attempts).toBe(2)
  })

  it("never lets one project's usage decide another project's quota", async () => {
    // Every other test in this block drives a single project, so keying the
    // usage map (and the in-flight map) by a constant leaves all of them
    // green. A cross-tenant quota leak is the highest-consequence thing this
    // cache can do -- one busy project silently refusing every other
    // project's events -- and nothing else here would notice it.
    await seedCounterRow(pg, projectId, monthStart(0), { accepted: 50 })
    await setQuota(5)
    await setQuota(5, projectIdB)

    // A is far past its limit and must be refused; B has spent nothing and
    // must not be, even though A's figure is now cached.
    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
    expect((await post('/v1/track', validEvent(), WRITE_KEY_B)).statusCode).toBe(202)
    // Two projects, two reads: B must not be answered from A's entry.
    expect(usageReads).toBe(2)
  })

  it('accepts exactly the quota and refuses the event after it', async () => {
    // Pins `>=` against `>`: with a quota of 3 the third event is the last
    // one inside the budget, and the fourth is the first outside it. A `>`
    // comparison lets every project store quota + 1.
    await setQuota(3)
    for (let i = 0; i < 3; i++) {
      expect((await post('/v1/track', validEvent())).statusCode).toBe(202)
    }
    expect((await post('/v1/track', validEvent())).statusCode).toBe(429)
  })
})

/**
 * `quotaSnapshot` (#43) — the reading behind lyraflow_ingest_quota_used_ratio.
 *
 * Its whole reason to exist is that /metrics must answer without touching a
 * database, so most of these are about what it declines to do.
 */
describe('quotaSnapshot', () => {
  const okCh2 = { insert: async () => {} } as unknown as ClickHouseClient
  const bindings2 = { bind: async () => 'noop' as const } as unknown as IngestDeps['bindings']
  const aliases2 = { alias: async () => 'noop' as const } as unknown as IngestDeps['aliases']

  function build(opts: {
    quota: number | null
    persisted: number
    onQuery?: () => void
  }): { app: ReturnType<typeof Fastify>; snapshot: () => ReturnType<typeof Object> } {
    const proj: Project = {
      id: 55,
      slug: 'snap',
      retentionMonths: 24,
      monthlyEventQuota: opts.quota,
      serverKeyHash: 'h',
    }
    const pool = {
      query: async (text: string) => {
        opts.onQuery?.()
        if (text.includes('events_accepted'))
          return { rows: [{ events_accepted: String(opts.persisted) }] }
        return { rows: [] }
      },
    } as unknown as Pool
    const app = Fastify({ logger: false })
    const readiness = new Readiness()
    readiness.markReady()
    const reg = registerIngestRoutes(app, {
      buffer: new IngestBuffer<EventRow>({
        flushRows: 1000,
        flushIntervalMs: 60_000,
        maxRows: 1000,
        insert: async () => {},
      }),
      projects: {
        byWriteKey: async (k: string) => (k === 'wk_snap' ? proj : null),
        byServerKey: async () => null,
      } as unknown as IngestDeps['projects'],
      counters: new IngestCounters(pool),
      cardinality: new CardinalityTracker(),
      geo: new NullGeoResolver(),
      readiness,
      ch: okCh2,
      bindings: bindings2,
      aliases: aliases2,
    })
    return { app, snapshot: reg.quotaSnapshot }
  }

  const send = (app: ReturnType<typeof Fastify>) =>
    app.inject({
      method: 'POST',
      url: '/v1/track',
      headers: { 'x-lyraflow-write-key': 'wk_snap', 'user-agent': UA },
      // `/v1/track` answers 202 for a REJECTED event too — accept and degrade
      // is the whole design — so a malformed payload here looks exactly like a
      // pass while never reaching the quota check at all. `message_id` must be
      // a UUID; `'snap-1'` parses as a string, fails the schema, and returns
      // the same 202 {"status":"accepted"}. Which is why the assertions below
      // check the SNAPSHOT rather than the status code.
      payload: { message_id: randomUUID(), anonymous_id: 'a', event: 'e' },
    })

  it('is empty before any event, so nothing is reported that was never enforced', () => {
    const { snapshot } = build({ quota: 1000, persisted: 0 })
    expect(snapshot()).toEqual([])
  })

  it('reports a project once enforcement has read its usage', async () => {
    const { app, snapshot } = build({ quota: 1000, persisted: 400 })
    expect((await send(app)).statusCode).toBe(202)

    const rows = snapshot()
    expect(rows.length).toBe(1)
    expect(rows[0]?.projectId).toBe(55)
    expect(rows[0]?.quota).toBe(1000)
    // 400 persisted + 1 pending. The PENDING half is the point: reporting the
    // persisted figure alone reads low by up to a whole flush interval, which
    // is exactly the window in which a project crosses its limit — so the
    // gauge would be least accurate at the moment it matters most.
    expect(rows[0]?.used).toBe(401)
  })

  it('never reports a project with no quota', async () => {
    // null is unlimited and is what every project carries by default. A ratio
    // against unlimited is not a number, and such a project is short-circuited
    // before any usage read — so it must not appear at all rather than appear
    // with a zero or a null.
    const { app, snapshot } = build({ quota: null, persisted: 0 })
    expect((await send(app)).statusCode).toBe(202)
    expect(snapshot()).toEqual([])
  })

  it('drops an entry whose month has rolled rather than reporting it', async () => {
    // `usage` is keyed by month. Reporting last month's persisted count
    // against this month's quota would produce a number that LOOKS like a
    // ratio and is not one — worse than reporting nothing, because an
    // operator would alert on it. A project that has sent nothing this month
    // simply has no series until it does.
    const { app, snapshot } = build({ quota: 1000, persisted: 400 })
    await send(app)
    expect(snapshot().length).toBe(1)

    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 15)))
      expect(snapshot()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits no series for a non-positive quota, which would serialise as Infinity', async () => {
    // Unreachable through the API today — project/routes.ts refuses 0 and
    // `isOverQuota` throws on it — so this guards the DIVISION rather than a
    // live path. It matters because JavaScript renders `n / 0` as the literal
    // `Infinity`, which is not valid Prometheus exposition (`+Inf` is), and
    // one malformed line makes a scraper reject the entire body — taking
    // every other metric down with a quota nobody set correctly.
    const { app, snapshot } = build({ quota: 0, persisted: 5 })
    await send(app)
    expect(snapshot()).toEqual([])
  })

  it('costs no database query, however many times it is called', async () => {
    // The requirement #43 states outright. /metrics is unauthenticated and
    // scraped on a schedule nobody here controls; a per-project read per
    // scrape would be a new load source reporting a number ingest already
    // holds. Counted rather than reasoned about.
    let queries = 0
    const { app, snapshot } = build({
      quota: 1000,
      persisted: 400,
      onQuery: () => {
        queries++
      },
    })
    await send(app)
    const afterIngest = queries
    expect(afterIngest, 'the fixture must actually query during ingest').toBeGreaterThan(0)

    for (let i = 0; i < 50; i++) snapshot()
    expect(queries).toBe(afterIngest)
  })
})
