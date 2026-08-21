import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { type Pool, createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PURGE_TABLES, purgeProject } from './purge.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

// A prefix no other suite uses, so cleanup here can never touch another
// file's rows even though they share a live database. Same convention as
// deletion-store.test.ts.
const PREFIX = 'purgeproject'
let counter = 0

/**
 * Raw INSERT, not the ingest API: nothing under test reads `write_key` or
 * `server_key_hash`, and a raw insert keeps this file independent of
 * @lyraflow/core's slugify-derived naming.
 */
async function createProject(db: Pool, name: string): Promise<{ id: number }> {
  const slug = `${PREFIX}-${Date.now()}-${counter++}`
  const r = await db.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, `wk_${slug}`, `sk_${slug}`],
  )
  return { id: Number(r.rows[0]?.id) }
}

/**
 * `n` events for `projectId`, each with its own id/identity/timestamp so
 * none collapse under `events`' ReplacingMergeTree. Inserting into `events`
 * is enough to populate `device_index` and `event_schema` too, through their
 * materialized views (device_index_mv, event_schema_str_mv) -- this file
 * never writes to either target table directly.
 */
async function insertEvents(chClient: typeof ch, projectId: number, n: number): Promise<void> {
  const now = Date.now()
  await chClient.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: Array.from({ length: n }, (_, i) => ({
      project_id: projectId,
      event_id: randomUUID(),
      anonymous_id: `${PREFIX}-anon-${randomUUID()}`,
      user_id: '',
      event_name: `${PREFIX}_event_${i}`,
      timestamp: new Date(now + i * 1000).toISOString().replace('T', ' ').replace('Z', ''),
      received_at: new Date(now + i * 1000).toISOString().replace('T', ' ').replace('Z', ''),
      trusted: 0,
      properties: {},
      properties_num: {},
    })),
  })
}

/**
 * Direct insert into `person_traits`, which `insertEvents` never populates:
 * it only ever writes plain events, never a `$identify`, so this table needs
 * its own fixture. `person_traits`'
 * columns are `AggregateFunction` states, so a plain JSONEachRow insert
 * cannot target it -- this mirrors what `person_traits_str_mv`
 * (004_person_traits.sql) itself does, `argMaxState` over a single row.
 */
async function insertPersonTrait(
  chClient: typeof ch,
  projectId: number,
  userId: string,
  traitKey: string,
  value: string,
): Promise<void> {
  await chClient.command({
    query: `INSERT INTO person_traits
            SELECT
              {projectId:UInt32} AS project_id,
              {anonymousId:String} AS anonymous_id,
              {userId:String} AS user_id,
              {traitKey:String} AS trait_key,
              argMaxState({value:String}, now64(3)) AS value_str,
              argMaxState(CAST(0, 'Float64'), now64(3)) AS value_num,
              argMaxState(CAST(0, 'UInt8'), now64(3)) AS has_num`,
    query_params: {
      projectId,
      anonymousId: '',
      userId,
      traitKey,
      value,
    },
  })
}

/** Row count in `table` for `projectId`. Every table `purgeProject` touches
 * carries a `project_id` column, so one query shape covers all five. */
async function countFor(chClient: typeof ch, table: string, projectId: number): Promise<number> {
  const rs = await chClient.query({
    query: `SELECT count() AS n FROM ${table} WHERE project_id = {p:UInt32}`,
    query_params: { p: projectId },
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ n: string }>()
  return Number(rows[0]?.n ?? 0)
}

/** `countFor`, across every table `purgeProject` is responsible for. */
async function countsFor(chClient: typeof ch, projectId: number): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const table of PURGE_TABLES) {
    out[table] = await countFor(chClient, table, projectId)
  }
  return out
}

/** Cleans both stores of every project this file created, looked up by
 * prefix rather than trusting in-memory ids -- a run that died mid-suite
 * leaves ClickHouse rows behind under an old project id that nothing else
 * would otherwise reach. Run at the top of `beforeAll` as well as in
 * `afterAll`, so the file is safe to run standalone more than once in a row
 * -- the same non-negotiable privacy/purge.test.ts states for its own
 * cleanup, and it applies here for the same reason: this file's whole point
 * is to delete rows out from under a shared test database. */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug LIKE $1', [
    `${PREFIX}-%`,
  ])
  const ids = existing.rows.map((r) => Number(r.id))
  if (ids.length > 0) {
    const list = ids.join(',')
    for (const table of PURGE_TABLES) {
      await ch.command({ query: `ALTER TABLE ${table} DELETE WHERE project_id IN (${list})` })
    }
  }
  await pg.query('DELETE FROM projects WHERE slug LIKE $1', [`${PREFIX}-%`])
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await pg.end()
  await ch.close()
})

describe('purgeProject', () => {
  it('removes every trace of the project from both stores', async () => {
    const project = await createProject(pg, 'Acme')
    await insertEvents(ch, project.id, 3)
    const result = await purgeProject({ ch, pg, projectId: project.id })
    expect(result.deleted).toBe(true)
    for (const table of PURGE_TABLES) {
      expect(await countFor(ch, table, project.id)).toBe(0)
    }
    const rows = await pg.query('SELECT id FROM projects WHERE id = $1', [project.id])
    expect(rows.rowCount).toBe(0)
  })

  it('leaves another project untouched', async () => {
    const doomed = await createProject(pg, 'Doomed')
    const keeper = await createProject(pg, 'Keeper')
    await insertEvents(ch, doomed.id, 3)
    await insertEvents(ch, keeper.id, 4)
    const before = await countsFor(ch, keeper.id)
    await purgeProject({ ch, pg, projectId: doomed.id })
    expect(await countsFor(ch, keeper.id)).toEqual(before)
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [keeper.id])).rowCount).toBe(1)
  })

  // THE STORE-ORDER PIN. Reversing the last two steps of purgeProject fails
  // this test and no other. This is #39's regression test.
  it('keeps the Postgres row while ClickHouse still holds rows', async () => {
    const project = await createProject(pg, 'Acme')
    await insertEvents(ch, project.id, 2)
    const seen: boolean[] = []
    await purgeProject({
      ch,
      pg,
      projectId: project.id,
      onProgress: async () => {
        const rows = await pg.query('SELECT id FROM projects WHERE id = $1', [project.id])
        seen.push(rows.rowCount === 1)
      },
    })
    expect(seen.every(Boolean)).toBe(true)
  })

  // THE VERIFY PIN. This is the buffered-flush shape: a row accepted before
  // the request lands in `events` after its partition was dropped. Deleting
  // the verify step fails this test and no other.
  it('refuses to delete the Postgres row when rows reappear mid-purge', async () => {
    const project = await createProject(pg, 'Acme')
    await insertEvents(ch, project.id, 2)
    let injected = false
    const result = await purgeProject({
      ch,
      pg,
      projectId: project.id,
      onProgress: async (p) => {
        if (p.table === 'events_dead_letter' && !injected) {
          injected = true
          await insertEvents(ch, project.id, 1)
        }
      },
    })
    expect(result.deleted).toBe(false)
    expect(result.remaining.events).toBeGreaterThan(0)
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [project.id])).rowCount).toBe(1)

    // And the second pass converges, because nothing is writing any more.
    const second = await purgeProject({ ch, pg, projectId: project.id })
    expect(second.deleted).toBe(true)
  })

  it('is a no-op the second time', async () => {
    const project = await createProject(pg, 'Acme')
    await insertEvents(ch, project.id, 2)
    await purgeProject({ ch, pg, projectId: project.id })
    const again = await purgeProject({ ch, pg, projectId: project.id })
    expect(again.deleted).toBe(true)
  })

  it('drops a single-key partition table as well as the tuple-key ones', async () => {
    const project = await createProject(pg, 'Acme')
    await insertPersonTrait(ch, project.id, 'p1', 'email', 'a@example.com')
    await purgeProject({ ch, pg, projectId: project.id })
    expect(await countFor(ch, 'person_traits', project.id)).toBe(0)
  })
})
