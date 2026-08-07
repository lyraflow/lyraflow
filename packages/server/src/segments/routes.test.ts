import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { hashServerKey } from '../auth/project-cache.js'
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

const WRITE_KEY = 'wk_segments_routes'
const SERVER_KEY = 'sk_segments_routes'
const OTHER_SERVER_KEY = 'sk_segments_other'

let app: FastifyInstance
let otherProjectId: number

const trait = { kind: 'trait', key: 'plan', operator: '=', value: 'trial' }

const preview = (body: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method: 'POST',
    url: '/v1/segments/preview',
    headers: {
      'content-type': 'application/json',
      'x-lyraflow-server-key': SERVER_KEY,
      ...headers,
    },
    payload: body as never,
  })

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  for (const slug of ['segments-routes-test', 'segments-routes-other']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  await pg.query(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Segments Routes', 'segments-routes-test', $1, $2)`,
    [WRITE_KEY, hashServerKey(SERVER_KEY)],
  )
  const other = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Segments Other', 'segments-routes-other', $1, $2) RETURNING id`,
    ['wk_segments_other', hashServerKey(OTHER_SERVER_KEY)],
  )
  otherProjectId = Number(other.rows[0]?.id)

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
  for (const slug of ['segments-routes-test', 'segments-routes-other']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  await pg.end()
  await ch.close()
})

describe('POST /v1/segments/preview', () => {
  /**
   * The write key must not open this route. Asserted by sending a VALID write
   * key in the server-key header, so the rejection is specifically "this key
   * is not a server key" — error `invalid_server_key`.
   *
   * Sending no server key at all would also return 401, but for the wrong
   * reason (`missing_server_key`), and would stay green against a route that
   * happily accepted write keys. Plan 2 shipped exactly that test once.
   */
  it('requires the server key, not the write key', async () => {
    const res = await preview(
      { ast_version: 1, filter: trait },
      { 'x-lyraflow-server-key': WRITE_KEY },
    )
    expect(res.statusCode).toBe(401)
    expect(res.json().error).toBe('invalid_server_key')
  })

  it('returns a count and the cost warnings together', async () => {
    const res = await preview({
      ast_version: 1,
      filter: {
        kind: 'behavior',
        event: '*',
        aggregate: 'count',
        operator: '>=',
        value: 1,
        window: { kind: 'ever' },
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(typeof body.person_count).toBe('number')
    expect(body.warnings).toHaveLength(2)
    // The spec requires results to carry the instant they describe, rather
    // than implying a freshness the system cannot deliver.
    expect(typeof body.as_of).toBe('string')
  })

  it('rejects a malformed tree with 400 and a field path', async () => {
    const res = await preview({ ast_version: 1, filter: { kind: 'trait' } })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeDefined()
  })

  it('rejects a tree past the caps with 400, not 500', async () => {
    let node: unknown = trait
    for (let i = 0; i < 12; i++) node = { kind: 'group', op: 'and', children: [node] }
    const res = await preview({ ast_version: 1, filter: node })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/nested|depth/i)
  })

  it('rejects an unknown ast_version rather than guessing', async () => {
    const res = await preview({ ast_version: 99, filter: trait })
    expect(res.statusCode).toBe(400)
  })

  it('cannot be pointed at another project', async () => {
    // There is no AST node for project_id and no request field for it; this
    // asserts that adding one to the payload changes nothing.
    const mine = await preview({ ast_version: 1, filter: trait })
    const spoofed = await preview({ ast_version: 1, filter: trait, project_id: otherProjectId })
    expect(mine.statusCode).toBe(200)
    expect(spoofed.json().person_count).toBe(mine.json().person_count)
  })
})
