/**
 * The invariant this file exists for: **a project id is never handed out
 * twice while ClickHouse still holds rows under it.**
 *
 * Postgres owns project ids, ClickHouse holds everything keyed by them, and
 * the two are reset by different means. Three test files legitimately run
 * `DROP SCHEMA public CASCADE` to prove a migration replays from nothing
 * (`schema-postgres`, `schema-identity`, and `identity/resolve` in the server
 * package). That drops `projects_id_seq` with everything else, so the next
 * `migrate()` recreates it starting at 1 — while ClickHouse, which nothing
 * dropped, still holds events, schema rows and device rows under ids 1, 2, 3
 * and up from every earlier suite in the same run.
 *
 * The next suite to create a project is then handed an id another suite's
 * ClickHouse rows already answer to, and its project-scoped queries silently
 * include them. That is lyraflow/lyraflow#201: two `seed-demo` assertions
 * that compare an exact property list saw a stray `theme` key belonging to
 * `privacy/export.test.ts`, but only under the full parallel suite, and only
 * when a schema-dropping file happened to run first. Measured directly:
 * `projects_id_seq` went from 34 to 2 across one run of
 * `schema-postgres.test.ts`.
 *
 * Purging ClickHouse instead would be the other way to restore the invariant,
 * and it is the wrong one: under a parallel run it would delete rows out from
 * under whichever suites are mid-flight. Advancing the sequence cannot damage
 * anyone's data — it only declines to reuse a number.
 */

import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ClickHouseClient,
  type Pool,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
  reserveProjectIdsPastClickHouse,
} from './index.js'

const CH_DB = 'lyraflow_test'
const pg: Pool = createPgPool(`postgres://lyraflow:lyraflow@localhost:5433/${CH_DB}`)
const ch: ClickHouseClient = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
})

/** Deliberately far above anything a test run creates, so this file's own
 * marker cannot be mistaken for another suite's project and vice versa. */
const MARKER_PROJECT_ID = 900_001
const SLUG = 'project-ids-seq-test'

const MIGRATIONS = () => loadMigrations(join(import.meta.dirname, '..', 'migrations'))

async function resetSchema(): Promise<void> {
  await pg.query('DROP SCHEMA public CASCADE')
  await pg.query('CREATE SCHEMA public')
  await migrate({ pg, ch, migrations: MIGRATIONS(), appSchemaVersion: 999 })
}

async function sequenceValue(): Promise<number> {
  const r = await pg.query<{ last_value: string }>('SELECT last_value FROM projects_id_seq')
  return Number(r.rows[0]?.last_value ?? 0)
}

async function createProjectRow(slug: string): Promise<number> {
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $1, $1, 'h') RETURNING id`,
    [slug],
  )
  return Number(r.rows[0]?.id)
}

beforeAll(async () => {
  await migrate({ pg, ch, migrations: MIGRATIONS(), appSchemaVersion: 999 })
  await ch.insert({
    table: 'event_schema',
    format: 'JSONEachRow',
    values: [
      {
        project_id: MARKER_PROJECT_ID,
        event_name: '$identify',
        property_key: 'marker',
        value_kind: 'string',
        last_seen: '2020-01-01 00:00:00',
      },
    ],
  })
}, 120_000)

afterAll(async () => {
  await ch.command({
    query: `ALTER TABLE event_schema DELETE WHERE project_id = ${MARKER_PROJECT_ID}`,
    clickhouse_settings: { mutations_sync: '1' },
  })
  await pg.query('DELETE FROM projects WHERE slug LIKE $1', [`${SLUG}%`])
  await pg.end()
  await ch.close()
})

describe('reserveProjectIdsPastClickHouse', () => {
  // The bug itself, stated as the behaviour that must not happen. Without the
  // call this fails with an id of 1 or 2 -- a number ClickHouse already
  // answers to for every suite that ran before the schema drop.
  it('never hands out an id ClickHouse still holds rows for, after a schema reset', async () => {
    await resetSchema()
    expect(await sequenceValue()).toBeLessThan(MARKER_PROJECT_ID)

    await reserveProjectIdsPastClickHouse(pg, ch)

    const id = await createProjectRow(`${SLUG}-a`)
    expect(id).toBeGreaterThan(MARKER_PROJECT_ID)
  })

  // The other half: it must not stampede the sequence forward on a database
  // whose ClickHouse is behind Postgres, or every call would inflate ids for
  // no reason and the function would be unsafe to call routinely.
  it('leaves the sequence alone when Postgres is already ahead of ClickHouse', async () => {
    const before = await sequenceValue()
    expect(before).toBeGreaterThan(MARKER_PROJECT_ID)

    await reserveProjectIdsPastClickHouse(pg, ch)

    expect(await sequenceValue()).toBe(before)
  })

  // Idempotent, because all three call sites run it on every suite start and
  // a helper that only works the first time is a trap.
  it('is safe to call repeatedly', async () => {
    await reserveProjectIdsPastClickHouse(pg, ch)
    await reserveProjectIdsPastClickHouse(pg, ch)
    const id = await createProjectRow(`${SLUG}-b`)
    expect(id).toBeGreaterThan(MARKER_PROJECT_ID)
  })
})
