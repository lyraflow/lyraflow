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
 * none collapse under `events`' ReplacingMergeTree, and each carrying a
 * non-empty `properties` / `properties_num` map. Inserting into `events` is
 * enough to populate `device_index` AND `event_schema` too, through their
 * materialized views (device_index_mv, event_schema_str_mv,
 * event_schema_num_mv) -- this file never writes to either target table
 * directly.
 *
 * The non-empty maps are load-bearing, not incidental: `event_schema_str_mv`
 * / `event_schema_num_mv` (002_events.sql) are
 * `ARRAY JOIN mapKeys(properties)` / `mapKeys(properties_num)`, and an ARRAY
 * JOIN over an empty map produces zero rows, not one row with an empty key.
 * An earlier version of this fixture used `{}` for both, which left
 * `event_schema` permanently unpopulated by every test in this file --
 * `event_schema`'s own whole-table `ALTER ... DELETE` was never exercised at
 * all, caught only because a reviewer confirmed the empty-ARRAY-JOIN
 * behaviour against the live test ClickHouse.
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
      properties: { kind: PREFIX },
      properties_num: { n: i },
    })),
  })
}

/**
 * A row in `events_dead_letter`, which nothing else in this file writes to
 * -- unlike `events`, nothing populates it through a materialized view, so
 * without this fixture `events_dead_letter` is never non-empty anywhere in
 * this file and its whole-table `ALTER ... DELETE` (purge.ts's `MUTATED`
 * loop) goes entirely unpinned.
 */
async function insertDeadLetter(chClient: typeof ch, projectId: number): Promise<void> {
  await chClient.insert({
    table: 'events_dead_letter',
    format: 'JSONEachRow',
    values: [
      {
        project_id: projectId,
        received_at: new Date().toISOString().replace('T', ' ').replace('Z', ''),
        reason: 'invalid_payload',
        detail: `${PREFIX} fixture`,
        payload: JSON.stringify({ event: 'broken' }),
      },
    ],
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

const CLEANUP_PARTITIONED = [
  { table: 'events', compound: true },
  { table: 'device_index', compound: true },
  { table: 'person_traits', compound: false },
] as const

/**
 * Drops every partition `table` holds for any id in `ids`, in one
 * `system.parts` read rather than one per id -- cleanup can be asked to
 * clear a handful of leftover projects at once and the read cost should not
 * scale with how many. Mirrors purge.ts's own `listPartitions`/drop shape,
 * duplicated here rather than imported: this is test-only cleanup code, not
 * the thing under test.
 */
async function dropPartitionsFor(
  table: string,
  compound: boolean,
  ids: readonly number[],
): Promise<void> {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const rs = await ch.query({
    query: `SELECT DISTINCT partition FROM system.parts
             WHERE database = currentDatabase() AND table = {table:String} AND active`,
    query_params: { table },
    format: 'JSONEachRow',
  })
  for (const row of await rs.json<{ partition: string }>()) {
    const match = compound
      ? /^\((\d+),\s*(\d+)\)$/.exec(row.partition)
      : /^(\d+)$/.exec(row.partition)
    if (!match) continue
    const id = Number(match[1])
    if (!idSet.has(id)) continue
    await ch.command(
      compound
        ? {
            query: `ALTER TABLE ${table} DROP PARTITION tuple({p:UInt32}, {m:UInt32})`,
            query_params: { p: id, m: Number(match[2]) },
          }
        : {
            query: `ALTER TABLE ${table} DROP PARTITION {p:UInt32}`,
            query_params: { p: id },
          },
    )
  }
}

/** Cleans both stores of every project this file created, looked up by
 * prefix rather than trusting in-memory ids -- a run that died mid-suite
 * leaves ClickHouse rows behind under an old project id that nothing else
 * would otherwise reach. Run at the top of `beforeAll` as well as in
 * `afterAll`, so the file is safe to run standalone more than once in a row
 * -- the same non-negotiable privacy/purge.test.ts states for its own
 * cleanup, and it applies here for the same reason: this file's whole point
 * is to delete rows out from under a shared test database.
 *
 * `events`, `device_index` and `person_traits` are dropped by PARTITION
 * (`dropPartitionsFor`), not `ALTER ... DELETE`: a mutation predicated on a
 * column that is not part of the partition key forces ClickHouse to rewrite
 * every active part of the table, and these three are shared with every
 * other suite in the run. `event_schema` and `events_dead_letter` carry no
 * partition on `project_id` at all, so there is no drop available for
 * either -- `ALTER ... DELETE` is the only option, kept scoped to exactly
 * this file's own ids rather than ever run unscoped against the whole
 * table. */
async function cleanup(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug LIKE $1', [
    `${PREFIX}-%`,
  ])
  const ids = existing.rows.map((r) => Number(r.id))
  if (ids.length > 0) {
    for (const { table, compound } of CLEANUP_PARTITIONED) {
      await dropPartitionsFor(table, compound, ids)
    }
    const list = ids.join(',')
    // mutations_sync = 1: these tables now hold this file's own rows (F1),
    // so a cleanup that returns before the mutation actually finishes would
    // leave the next test's fixtures racing them.
    await ch.command({
      query: `ALTER TABLE event_schema DELETE WHERE project_id IN (${list})`,
      clickhouse_settings: { mutations_sync: '1' },
    })
    await ch.command({
      query: `ALTER TABLE events_dead_letter DELETE WHERE project_id IN (${list})`,
      clickhouse_settings: { mutations_sync: '1' },
    })
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
    await insertDeadLetter(ch, project.id)
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
    await insertDeadLetter(ch, doomed.id)
    await insertEvents(ch, keeper.id, 4)
    await insertDeadLetter(ch, keeper.id)
    const before = await countsFor(ch, keeper.id)
    const result = await purgeProject({ ch, pg, projectId: doomed.id })

    // The doomed project was actually purged, not merely left out of the
    // keeper's own count -- a total no-op would pass the two assertions
    // below this one just as well.
    expect(result.deleted).toBe(true)
    for (const table of PURGE_TABLES) {
      expect(await countFor(ch, table, doomed.id)).toBe(0)
    }
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [doomed.id])).rowCount).toBe(0)

    expect(await countsFor(ch, keeper.id)).toEqual(before)
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [keeper.id])).rowCount).toBe(1)
  })

  // THE STORE-ORDER PIN. This pins that the Postgres row survives for the
  // WHOLE ClickHouse teardown, through the verify read too, with no
  // unobserved window in between -- not merely that it survives while
  // ClickHouse teardown is still in progress. #39's regression test.
  //
  // `onProgress` alone cannot see the gap this test is actually about: its
  // fifth and final call fires once ClickHouse teardown is done, and the
  // verify read plus the Postgres DELETE both run AFTER that call with no
  // observation point of their own -- an `onProgress`-only version of this
  // test cannot tell "DELETE runs after the verify read" from "DELETE runs
  // right after teardown, skipping the verify read entirely". `chSpy` closes
  // that gap: every `ch.query()` call purgeProject makes -- `listPartitions`
  // during teardown, `countRows` during the verify read -- also samples
  // whether the Postgres row is still there, so the previously-unobserved
  // window between teardown and the DELETE is covered too. The brief's
  // literal Step 5.1 mutation (DELETE moved to sit directly above the
  // verify loop) fails THIS test together with "refuses to delete the
  // Postgres row when rows reappear mid-purge" below -- not this test
  // alone, and not that other test alone either.
  it('keeps the Postgres row while ClickHouse still holds rows', async () => {
    const project = await createProject(pg, 'Acme')
    await insertEvents(ch, project.id, 2)
    const seen: boolean[] = []
    const observed: boolean[] = []
    const chSpy = new Proxy(ch, {
      get: (target, prop) =>
        prop === 'query'
          ? async (params: Parameters<ClickHouseClient['query']>[0]) => {
              const rows = await pg.query('SELECT id FROM projects WHERE id = $1', [project.id])
              observed.push(rows.rowCount === 1)
              return target.query(params)
            }
          : Reflect.get(target, prop),
    }) as ClickHouseClient

    await purgeProject({
      ch: chSpy,
      pg,
      projectId: project.id,
      onProgress: async () => {
        const rows = await pg.query('SELECT id FROM projects WHERE id = $1', [project.id])
        seen.push(rows.rowCount === 1)
      },
    })
    expect(seen.every(Boolean)).toBe(true)
    // The gap `onProgress` cannot see: at least the three `listPartitions`
    // reads and the five `countRows` reads of the verify loop, all with the
    // Postgres row still present at the moment each one ran.
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every(Boolean)).toBe(true)
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
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [project.id])).rowCount).toBe(0)
  })

  it('is a no-op the second time', async () => {
    const project = await createProject(pg, 'Acme')
    await insertEvents(ch, project.id, 2)
    const first = await purgeProject({ ch, pg, projectId: project.id })
    expect(first.deleted).toBe(true)
    const again = await purgeProject({ ch, pg, projectId: project.id })
    expect(again.deleted).toBe(true)
    expect((await pg.query('SELECT id FROM projects WHERE id = $1', [project.id])).rowCount).toBe(0)
  })

  it('drops a single-key partition table as well as the tuple-key ones', async () => {
    const project = await createProject(pg, 'Acme')
    await insertPersonTrait(ch, project.id, 'p1', 'email', 'a@example.com')
    await purgeProject({ ch, pg, projectId: project.id })
    expect(await countFor(ch, 'person_traits', project.id)).toBe(0)
  })
})
