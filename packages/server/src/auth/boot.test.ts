// This file proves what app.ts's own wiring adds on top of SessionSweeper
// (covered by sweeper.test.ts's own unit tests, including its error-
// containment guarantees -- the same split retention/wiring.test.ts uses
// against RetentionWorker, whose own unit tests live in worker.test.ts):
// that buildApp
// constructs the sweeper but never starts it (see app.ts's own comment for
// why -- a live timer issuing real DELETEs against the shared test database
// during unrelated tests is exactly the cross-file interference the
// shared-database rule exists to prevent), and that `runOnce()` reaches the
// SAME `sessions` table every route in this codebase reads and writes
// through, not a lookalike constructed separately.
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from '../app.js'
import { loadConfig } from '../config.js'
import { Readiness } from '../health.js'
import { ensureAdminUser } from './bootstrap.js'
import { SessionStore } from './sessions.js'

const CH = {
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
}
const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient(CH)

// A prefix no other suite uses, per the shared test harness.
const PREFIX = 'auth-boot'
const EMAIL = `${PREFIX}-suite@example.test`
const PASSWORD = `${PREFIX}-suite-password`

let app: FastifyInstance
let adminId = 0

function build(): FastifyInstance {
  const config = loadConfig({
    LYRAFLOW_POSTGRES_URL: 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test',
    LYRAFLOW_CLICKHOUSE_URL: CH.url,
    LYRAFLOW_CLICKHOUSE_USER: CH.username,
    LYRAFLOW_CLICKHOUSE_PASSWORD: CH.password,
    LYRAFLOW_CLICKHOUSE_DB: CH.database,
  } as NodeJS.ProcessEnv)
  const readiness = new Readiness()
  readiness.markReady()
  return buildApp({ config, pg, ch, readiness })
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })

  // admin_user is a SINGLETON table -- this suite clears it in both
  // beforeAll and afterAll rather than assuming it starts empty, per
  // bootstrap.test.ts's own comment on the same table.
  await pg.query('DELETE FROM admin_user')
  const outcome = await ensureAdminUser(pg, { email: EMAIL, password: PASSWORD })
  expect(outcome).toBe('created')
  const row = await pg.query<{ id: string }>('SELECT id FROM admin_user')
  adminId = Number(row.rows[0]?.id)

  app = build()
  await app.ready()
})

beforeEach(async () => {
  await pg.query('DELETE FROM sessions')
})

afterAll(async () => {
  await app.close()
  await pg.query('DELETE FROM sessions')
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

describe('session sweeper wiring (app.ts)', () => {
  // buildApp constructs the session sweeper but does NOT start it. A live
  // timer during unrelated route tests is exactly the cross-file
  // interference the shared-database rule exists to prevent, and every
  // route test in this codebase calls buildApp.
  it('does not start the session sweeper during buildApp', () => {
    expect(app.deps.sessionSweeper.running).toBe(false)
  })

  // The sweeper actually removes an expired row when run, through the same
  // `sessions` table SessionStore.issue()/verify() use -- a second
  // SessionStore instance here, pointed at the same table with a negative
  // TTL, proves that: nothing about app.deps.sessionSweeper is scoped to
  // rows issued through app.deps.sessions specifically.
  it('sweeps expired sessions when run once', async () => {
    const expired = new SessionStore(pg, -1000)
    await expired.issue(adminId)
    const removed = await app.deps.sessionSweeper.runOnce()
    expect(removed).toBeGreaterThanOrEqual(1)
  })
})
