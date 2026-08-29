// `where` on the stats endpoint, against a real ClickHouse. `trends.test.ts`
// pins the breakdown; this pins what a predicate MEANS -- that it cuts the
// count rather than merely parsing, that it composes with a breakdown, that
// it survives the retry dedup, that a suppressed person stays out even
// under a matching filter, and that a bad one is refused rather than
// ignored.
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

const PROJECT = 7704
const SERVER_KEY = 'sk_stats_where'
let app: FastifyInstance

let seq = 0
const ev = (
  name: string,
  day: string,
  properties: Record<string, string> = {},
  properties_num: Record<string, number> = {},
  columns: Record<string, string> = {},
  eventId?: string,
) => ({
  project_id: PROJECT,
  event_id: eventId ?? `77040000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  anonymous_id: `dev-${seq}`,
  user_id: '',
  event_name: name,
  timestamp: `${day} 10:00:00.000`,
  received_at: `${day} 10:00:00.000`,
  trusted: 1,
  properties,
  properties_num,
  ...columns,
})

const RANGE = 'since=2026-06-01T00:00:00Z&until=2026-06-16T00:00:00Z'

const stats = async (query: string) => {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/events/stats?${RANGE}&${query}`,
    headers: { 'x-lyraflow-server-key': SERVER_KEY },
  })
  return { status: res.statusCode, body: res.json() }
}

/** Every bucket's count added up, ignoring any breakdown. */
const total = (body: { buckets: { events: number }[] }) =>
  body.buckets.reduce((n, b) => n + b.events, 0)

/** Total events per series across the whole window. */
const totals = (body: { buckets: { series?: string; events: number }[] }) => {
  const out: Record<string, number> = {}
  for (const b of body.buckets) out[b.series ?? ''] = (out[b.series ?? ''] ?? 0) + b.events
  return out
}

/** One predicate list, URL-encoded the way a caller sends it. */
const where = (list: unknown[]) => `where=${encodeURIComponent(JSON.stringify(list))}`

// Resolved by the ClickHouse *server* itself, inside the compose network --
// same pattern `routes.test.ts` uses.
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH.database,
}

/** Mirrors `routes.test.ts`'s own `suppress` helper: the dictionary, not
 * the table, is what the compiled query reads. */
const suppress = async (projectId: number, personId: string, at: Date) => {
  await pg.query(
    'INSERT INTO suppressed_persons (project_id, person_id, suppressed_at) VALUES ($1, $2, $3)',
    [projectId, personId, at],
  )
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH.database}.suppressed_persons` })
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await ensureIdentityDictionaries(ch, pgSource)
  await pg.query('DELETE FROM projects WHERE slug = $1', ['stats-where'])
  await pg.query(
    `INSERT INTO projects (id, name, slug, write_key, server_key_hash)
     VALUES ($1, 'Stats where', 'stats-where', $2, $3)`,
    [PROJECT, 'wk_stats_where', hashServerKey(SERVER_KEY)],
  )
  for (const table of ['events', 'device_index', 'person_traits']) {
    await ch.command({
      query: `ALTER TABLE ${table} DELETE WHERE project_id = ${PROJECT}`,
      clickhouse_settings: { mutations_sync: '1' },
    })
  }

  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      // Four $page, three distinct paths. The whole point of the feature:
      // without a predicate these are one undifferentiated series.
      ev('$page', '2026-06-03', { path: '/register' }, {}, { utm_source: 'newsletter' }),
      ev('$page', '2026-06-04', { path: '/register' }, {}, { utm_source: 'twitter' }),
      ev('$page', '2026-06-04', { path: '/pricing' }),
      ev('$page', '2026-06-05', { path: '/' }),
      // A DIFFERENT event carrying the same property value, so a predicate
      // with no `event` has something to find and one with `event` has
      // something to exclude.
      ev('signup', '2026-06-05', { path: '/register' }),
      // Numeric property, which ingest routes into the other bag entirely.
      ev('$page', '2026-06-05', { path: '/checkout' }, { seats: 5 }),
      // A retry: TWO physical rows, ONE event_id, in DIFFERENT day buckets.
      // `LIMIT 1 BY project_id, event_id` must still collapse them under a
      // predicate, or the filter would be counting rows rather than events.
      ev('$page', '2026-06-08', { path: '/retry' }, {}, {}, '77040000-0000-4000-8000-000000009001'),
      ev('$page', '2026-06-09', { path: '/retry' }, {}, {}, '77040000-0000-4000-8000-000000009001'),
    ],
  })

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
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = $1', ['stats-where'])
  await pg.end()
  await ch.close()
})

describe('GET /v1/events/stats?where=', () => {
  it('narrows the count instead of merely parsing', async () => {
    // The assertion that matters: the two answers DIFFER. A `where` that
    // silently did nothing would pass any test that only checked a 200.
    const all = await stats('event=$page&interval=1d')
    const filtered = await stats(
      `event=$page&interval=1d&${where([{ property: 'path', operator: '=', value: '/register' }])}`,
    )
    expect(total(all.body)).toBe(6)
    expect(total(filtered.body)).toBe(2)
  })

  it('treats an empty predicate list the same as no filter at all', async () => {
    // `where=[]` takes the `where !== undefined` branch, validates as an
    // empty array, and compiles to an empty clause -- distinct code paths
    // from omitting the parameter entirely, and worth pinning as equivalent.
    const all = await stats('event=$page&interval=1d')
    const empty = await stats(`event=$page&interval=1d&${where([])}`)
    expect(total(empty.body)).toBe(total(all.body))
  })

  it('filters on an event column, not only on a property', async () => {
    // An attribute predicate compiles to a BARE column name, which resolves
    // only because the clause sits inside the scan of `events` itself.
    const { status, body } = await stats(
      `event=$page&interval=1d&${where([
        { source: 'attribute', attribute: 'utm_source', operator: '=', value: 'twitter' },
      ])}`,
    )
    expect(status).toBe(200)
    expect(total(body)).toBe(1)
  })

  it('reads a numeric property out of the other bag', async () => {
    const { body } = await stats(
      `event=$page&interval=1d&${where([{ property: 'seats', operator: '>=', value: 5 }])}`,
    )
    expect(total(body)).toBe(1)
  })

  it('ANDs several predicates rather than ORing them', async () => {
    const { body } = await stats(
      `event=$page&interval=1d&${where([
        { property: 'path', operator: '=', value: '/register' },
        { source: 'attribute', attribute: 'utm_source', operator: '=', value: 'twitter' },
      ])}`,
    )
    expect(total(body)).toBe(1)
  })

  it('applies without an event name, because "anything, where path = /register" is a question', async () => {
    // Decision 5. The `$page` pair plus the `signup`.
    const { body } = await stats(
      `interval=1d&${where([{ property: 'path', operator: '=', value: '/register' }])}`,
    )
    expect(total(body)).toBe(3)
  })

  it('composes with a breakdown', async () => {
    // The predicate is inside the scan and the series expression is outside
    // it; this is the test that proves the two halves compose.
    //
    // Asserting the series SET, not only two members of it: without the
    // `path = /register` filter, the unfiltered breakdown also has a `''`
    // series (four events with no `utm_source`) alongside `newsletter` and
    // `twitter`. A filter that did nothing would still make the two
    // `toBe(1)` checks below pass, because a no-op leaves `newsletter` and
    // `twitter` at 1 either way -- it is the ABSENCE of the `''` series that
    // is the actual proof the filter narrowed the scan.
    const { body } = await stats(
      `event=$page&interval=1w&group_by=attribute:utm_source&${where([
        { property: 'path', operator: '=', value: '/register' },
      ])}`,
    )
    expect(Object.keys(totals(body)).sort()).toEqual(['newsletter', 'twitter'])
    expect(totals(body).newsletter).toBe(1)
    expect(totals(body).twitter).toBe(1)
  })

  it('still counts a retried event once', async () => {
    // Two physical rows, one event_id, two different day buckets -- no
    // per-bucket aggregate can collapse that, so this pins `LIMIT 1 BY`
    // surviving the new clause rather than the clause being applied after it.
    const { body } = await stats(
      `event=$page&interval=1d&${where([{ property: 'path', operator: '=', value: '/retry' }])}`,
    )
    expect(total(body)).toBe(1)
  })

  it("keeps a suppressed person's events out even when they match the filter", async () => {
    // `notSuppressedExpr` is ANDed into the SAME inner WHERE as `where`'s
    // own predicates (decision 4) -- a filter naming exactly the erased
    // person's events must still exclude them, rather than the two
    // conditions somehow only applying to each other. A separate event name
    // and its own fixture, self-contained the way `routes.test.ts`'s own
    // suppression test is, so this does not disturb the fixed totals every
    // other test in this file pins against the shared beforeAll fixture.
    const eventName = 'stats_suppressed_probe'
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        ev(eventName, '2026-06-10', { path: '/probe' }, {}, {
          user_id: 'stats-where-suppressed-user',
        }),
        ev(eventName, '2026-06-10', { path: '/probe' }, {}, {
          user_id: 'stats-where-control-user',
        }),
      ],
    })
    // Strictly after the event above -- "all events before their boundary"
    // is the shape `routes.test.ts`'s own suppression test exists to catch.
    await suppress(PROJECT, 'stats-where-suppressed-user', new Date('2026-06-11T00:00:00Z'))

    const { body } = await stats(
      `event=${eventName}&interval=1d&${where([
        { property: 'path', operator: '=', value: '/probe' },
      ])}`,
    )
    // Only the control user's event survives -- if suppression were not
    // applied inside the same inner scan as the filter, this would be 2.
    expect(total(body)).toBe(1)
  })

  it('refuses JSON it cannot parse rather than ignoring it', async () => {
    // Ignoring it would answer a WIDER question than the caller asked, and
    // look identical to a correct answer.
    const bad = await stats('event=$page&interval=1d&where=not-json')
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_where')
  })

  it('refuses a value that is not an array', async () => {
    // Valid JSON, wrong shape -- a different failure from the one above and
    // the same error code, because from the caller's side it is one mistake
    // in one parameter.
    const bad = await stats(
      `event=$page&interval=1d&where=${encodeURIComponent('{"property":"path"}')}`,
    )
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_where')
  })

  it('refuses an over-length where as invalid_where, not invalid_query', async () => {
    // `AttributePredicate`'s value has no length bound of its own, so one
    // long value crosses the ceiling on its own -- this must fail inside the
    // handler's own check, not inside `StatsQuery.safeParse`, or the caller
    // is told the whole query is malformed rather than which control is.
    const bad = await stats(
      `event=$page&interval=1d&${where([
        { property: 'path', operator: '=', value: 'x'.repeat(4001) },
      ])}`,
    )
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_where')
  })

  it('refuses a predicate the grammar does not accept', async () => {
    const bad = await stats(
      `event=$page&interval=1d&${where([{ property: 'path', operator: 'matches', value: 'x' }])}`,
    )
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_where')
  })

  it('refuses eleven predicates, one past the cap', async () => {
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      property: `p${i}`,
      operator: '=',
      value: 'x',
    }))
    const bad = await stats(`event=$page&interval=1d&${where(eleven)}`)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_where')
  })

  it('accepts exactly ten, so the cap is not off by one', async () => {
    const ten = Array.from({ length: 10 }, () => ({
      property: 'path',
      operator: '=',
      value: '/register',
    }))
    const ok = await stats(`event=$page&interval=1d&${where(ten)}`)
    expect(ok.status).toBe(200)
    // Proves the ten ANDed predicates actually compiled into a working
    // clause, not only that the cap admitted the request.
    expect(total(ok.body)).toBe(2)
  })

  it('binds a value rather than interpolating it', async () => {
    // If this were concatenated into the SQL it would not be a 200 with an
    // empty result -- it would be a ClickHouse syntax error, or worse.
    const { status, body } = await stats(
      `event=$page&interval=1d&${where([
        { property: 'path', operator: '=', value: "') OR 1=1 --" },
      ])}`,
    )
    expect(status).toBe(200)
    expect(total(body)).toBe(0)
  })

  it('reports a bad where separately from a bad group_by', async () => {
    // Two different mistakes must not produce one error code -- the screen
    // says which control is wrong.
    const bad = await stats('event=$page&interval=1d&group_by=trait:plan')
    expect(bad.body.error).toBe('invalid_group_by')
  })
})
