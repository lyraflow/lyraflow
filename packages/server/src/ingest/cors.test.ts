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
let pg: Pool
let ch: ClickHouseClient

/**
 * Each test builds its own app rather than sharing one, because the
 * behaviour under test — the allowlist — is itself part of Config, and
 * different tests need different allowlists.
 */
async function buildTestApp(allowedOrigins: string): Promise<FastifyInstance> {
  const readiness = new Readiness()
  readiness.markReady()
  const config = loadConfig({
    LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
    LYRAFLOW_ALLOWED_ORIGINS: allowedOrigins,
  } as NodeJS.ProcessEnv)
  const app = buildApp({ config, pg, ch, readiness })
  await app.ready()
  return app
}

beforeAll(async () => {
  pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
  ch = createChClient(CH)
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', ['cors-test'])
  await pg.query(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('CORS', 'cors-test', 'wk_cors', 'h')`,
  )
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['cors-test'])
  await pg.end()
  await ch.close()
})

describe('CORS on the ingest routes', () => {
  it('answers a preflight for the ingest routes', async () => {
    // Every SDK request is preflighted: it carries a custom header and a JSON
    // content type. If OPTIONS is not handled, nothing reaches the ingest at all.
    const app = await buildTestApp('')
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/batch',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-lyraflow-write-key',
        },
      })
      expect(res.statusCode).toBeLessThan(300)
      expect(res.headers['access-control-allow-headers']).toContain('x-lyraflow-write-key')
    } finally {
      await app.close()
    }
  })

  it('reflects an allowed origin on a real ingest POST', async () => {
    const app = await buildTestApp('https://app.example.com')
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/track',
        headers: {
          origin: 'https://app.example.com',
          'x-lyraflow-write-key': 'wk_cors',
        },
        payload: {
          message_id: randomUUID(),
          anonymous_id: 'a-cors',
          event: 'signup',
        },
      })
      expect(res.statusCode).toBe(202)
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com')
    } finally {
      await app.close()
    }
  })

  it('does not allow an origin outside the allowlist', async () => {
    const app = await buildTestApp('https://app.example.com')
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/batch',
        headers: {
          origin: 'https://evil.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-lyraflow-write-key',
        },
      })
      expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example.com')
    } finally {
      await app.close()
    }
  })

  it('allows any origin when the allowlist is empty', async () => {
    const app = await buildTestApp('')
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/batch',
        headers: {
          origin: 'https://anything.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-lyraflow-write-key',
        },
      })
      expect(res.headers['access-control-allow-origin']).toBe('https://anything.example.com')
    } finally {
      await app.close()
    }
  })

  it('does NOT enable CORS on the server-key routes', async () => {
    // A browser has no business calling the segment, person or privacy
    // endpoints, and enabling CORS there would quietly invite it.
    const app = await buildTestApp('')
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/segments',
        headers: { origin: 'https://app.example.com', 'access-control-request-method': 'GET' },
      })
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    } finally {
      await app.close()
    }
  })

  it('does NOT enable CORS on /v1/alias, even though it is registered in the same file', async () => {
    // /v1/alias lives inside registerIngestRoutes alongside the write-key
    // routes but is gated on the server key — the case a global
    // app.register(cors, ...) or an over-wide encapsulation boundary would
    // most easily get wrong.
    const app = await buildTestApp('')
    try {
      const res = await app.inject({
        method: 'OPTIONS',
        url: '/v1/alias',
        headers: {
          origin: 'https://app.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'content-type,x-lyraflow-server-key',
        },
      })
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
    } finally {
      await app.close()
    }
  })
})
