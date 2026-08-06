import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
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
let app: FastifyInstance

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', ['routes-test'])
  await pg.query(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Routes', 'routes-test', 'wk_routes', 'h')`,
  )

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
  // Several tests above (e.g. the batch test) trigger an auto-flush via
  // flushRows without waiting on it. Draining before ch.close() keeps that
  // fire-and-forget insert from being severed mid-flight by the client
  // shutdown, which otherwise logs a spurious ECONNRESET through onError.
  await app.deps.buffer.flush()
  await app.close()
  await pg.query('DELETE FROM projects WHERE slug = $1', ['routes-test'])
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
    expect(res.json()).toEqual({ accepted: 1, rejected: 1 })
  })

  it('refuses new events with 503 once draining', async () => {
    app.deps.readiness.markDraining()
    const res = await track({ message_id: randomUUID(), anonymous_id: 'a', event: 'x' })
    expect(res.statusCode).toBe(503)
  })
})
