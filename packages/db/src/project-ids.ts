import type { ClickHouseClient } from '@clickhouse/client'
import type { Pool } from 'pg'

/**
 * Every ClickHouse table that stores rows of its own under a `project_id`.
 *
 * The three remaining project-scoped objects — `identity_bindings`,
 * `person_aliases` and `suppressed_persons` — are Dictionaries sourced from
 * Postgres, so they follow a schema reset rather than surviving it and cannot
 * strand an id. Only the MergeTree family holds data that outlives Postgres.
 */
const PROJECT_SCOPED_TABLES = [
  'events',
  'event_schema',
  'device_index',
  'person_traits',
  'events_dead_letter',
] as const

/**
 * Advance `projects_id_seq` past every project id ClickHouse still holds rows
 * for, and return that high-water mark.
 *
 * **Call this immediately after recreating the Postgres schema in a test.**
 * Postgres owns project ids and ClickHouse holds everything keyed by them, but
 * only one of the two is reset by `DROP SCHEMA public CASCADE` — which three
 * suites do deliberately, to prove a migration replays from nothing. The drop
 * takes `projects_id_seq` with it, `migrate()` recreates it starting at 1, and
 * the next project created is handed an id that another suite's ClickHouse
 * rows already answer to. Its project-scoped queries then silently include
 * them.
 *
 * That is lyraflow/lyraflow#201, and the reuse is real rather than theoretical:
 * `projects_id_seq` measured 34 before one run of `schema-postgres.test.ts`
 * and 2 after it.
 *
 * Raising the sequence is deliberately the only thing this does. Purging
 * ClickHouse would restore the same invariant and is the wrong tool: under a
 * parallel run it deletes rows out from under whichever suites are mid-flight,
 * whereas declining to reuse a number cannot damage anyone's data. It is also
 * why this never lowers the sequence — `GREATEST` keeps a Postgres that is
 * already ahead exactly where it is, so the call is safe to make routinely and
 * safe to make twice.
 *
 * Not for production. Nothing outside a test resets the schema, and a running
 * install's sequence is already past everything ClickHouse holds.
 */
export async function reserveProjectIdsPastClickHouse(
  pg: Pool,
  ch: ClickHouseClient,
): Promise<number> {
  const union = PROJECT_SCOPED_TABLES.map(
    (table) => `SELECT max(project_id) AS m FROM ${table}`,
  ).join(' UNION ALL ')
  const rs = await ch.query({
    query: `SELECT max(m) AS m FROM (${union})`,
    format: 'JSONEachRow',
  })
  const rows = await rs.json<{ m: string | number | null }>()
  const highWater = Number(rows[0]?.m ?? 0)
  // An empty ClickHouse returns 0 for a UInt32 `max`, which is already true of
  // a fresh database and needs no reservation.
  if (!Number.isFinite(highWater) || highWater <= 0) return 0

  // `setval(..., true)` marks the value as consumed, so the next `nextval` is
  // highWater + 1 rather than highWater itself. GREATEST is what makes this a
  // one-way ratchet.
  await pg.query(
    `SELECT setval(
       'projects_id_seq',
       GREATEST((SELECT last_value FROM projects_id_seq), $1::bigint),
       true
     )`,
    [highWater],
  )
  return highWater
}
