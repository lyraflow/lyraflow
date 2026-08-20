/**
 * The half of `seed-demo` that cannot be proved without databases: that the
 * rows land, that the three materialised structures the screens read populate
 * from that insert on their own, and that identity resolution actually
 * attaches an anonymous visitor's early events to the person they became.
 *
 * Requires the same live Postgres (5433) + ClickHouse (8123) every other
 * live-database suite in this repo uses. Like `binary.test.ts`, the identity
 * dictionaries are created against the address CLICKHOUSE can reach
 * (`postgres:5432`, the compose service name) rather than the host-mapped port
 * this test process itself uses — a dictionary pointed at `localhost:5433`
 * creates cleanly and then resolves nobody, because `localhost` inside the
 * ClickHouse container is ClickHouse.
 */

import { join } from 'node:path'
import { createProject, resolvedPersonExpr } from '@lyraflow/core'
import {
  type ClickHouseClient,
  type Pool,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
import {
  type PgDictionarySource,
  ensureIdentityDictionaries,
} from '@lyraflow/server/dist/identity/dictionaries.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type DemoData, generateDemoData, summarise } from './generate.js'
import { insertDemoData } from './insert.js'

const CH_DB = 'lyraflow_test'
const pg: Pool = createPgPool(`postgres://lyraflow:lyraflow@localhost:5433/${CH_DB}`)
const ch: ClickHouseClient = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
})
const PG_SOURCE: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

/** Already a slug, so `slugify` is the identity function on it and cleanup can
 * look the project up directly. Its own prefix, distinct from every other
 * live-database suite's fixtures in this repo. */
const PROJECT_SLUG = 'seed-demo-insert-test'
const ANCHOR = new Date('2026-08-17T12:00:00.000Z')

let projectId: number
let data: DemoData

async function dropProject(): Promise<void> {
  const existing = await pg.query<{ id: string }>('SELECT id FROM projects WHERE slug = $1', [
    PROJECT_SLUG,
  ])
  const row = existing.rows[0]
  if (!row) return
  const id = Number(row.id)
  for (const table of ['events', 'event_schema', 'person_traits', 'device_index']) {
    await ch.command({
      query: `ALTER TABLE ${table} DELETE WHERE project_id = ${id}`,
      clickhouse_settings: { mutations_sync: '1' },
    })
  }
  await pg.query('DELETE FROM projects WHERE id = $1', [id])
}

async function scalar(query: string): Promise<number> {
  const rs = await ch.query({ query, format: 'JSONEachRow' })
  const rows = await rs.json<{ n: string | number }>()
  return Number(rows[0]?.n ?? 0)
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  // At the top as well as in afterAll, per this repo's live-database rule: a
  // previous crashed run must not leave a project this one trips over.
  await dropProject()
  await ensureIdentityDictionaries(ch, PG_SOURCE)

  const project = await createProject(pg, PROJECT_SLUG)
  projectId = Number(project.id)

  data = generateDemoData({ seed: 31, persons: 60, events: 900, days: 90, anchor: ANCHOR })
  await insertDemoData(data, { ch, pg, database: CH_DB, projectId })
}, 120_000)

afterAll(async () => {
  await dropProject()
  await pg.end()
  await ch.close()
})

/**
 * Every row this seeder writes carries an `anonymous_id` of the form
 * `demo-device-…` (`generate.ts`), and every absolute count below is scoped by
 * that as well as by `project_id`.
 *
 * Scoping by project alone is not isolation, and this is not hypothetical: the
 * project here is created by slug and takes whatever serial id it is given, so
 * on a database where it is the first project created it gets **id 1** — and
 * `packages/db/src/schema-clickhouse.test.ts` inserts events under a
 * *hardcoded* `project_id: 1`, whose materialised view then adds its own
 * `device_index` rows. That is exactly how this file first went red in CI and
 * not locally: `expected 63 to be 60`, the three extra being that file's
 * `anon-1` and friends. Locally the database already held other projects, so
 * the id was high and the collision never happened.
 *
 * The prefix predicate is what makes these counts mean "the rows this seeder
 * wrote" rather than "the rows in this project, whoever wrote them".
 *
 * Alias-aware: two of the queries below select from `events AS e`, where the
 * column needs qualifying but the function call must not be.
 */
const ours = (alias = '') => `startsWith(${alias}anonymous_id, 'demo-device-')`

describe('insertDemoData', () => {
  it('writes every generated event into events', async () => {
    expect(
      await scalar(`SELECT count() AS n FROM events WHERE project_id = ${projectId} AND ${ours()}`),
    ).toBe(900)
  })

  it('spreads the stored timestamps across the whole window rather than one day', async () => {
    const rs = await ch.query({
      query: `SELECT min(timestamp) AS lo, max(timestamp) AS hi
              FROM events WHERE project_id = ${projectId} AND ${ours()}`,
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{ lo: string; hi: string }>()
    const lo = new Date(`${row?.lo.replace(' ', 'T')}Z`).getTime()
    const hi = new Date(`${row?.hi.replace(' ', 'T')}Z`).getTime()
    const spanDays = (hi - lo) / 86_400_000

    // The clamp would have collapsed this to at most one day. See
    // `rows.test.ts` for that comparison in isolation; this is the same claim
    // measured after a round trip through ClickHouse's DateTime64.
    expect(spanDays).toBeGreaterThan(70)
    expect(summarise(data).earliest.getTime()).toBe(lo)
  })

  it('populates event_schema, so the segment builder has property suggestions', async () => {
    const rs = await ch.query({
      // DISTINCT, matching what `schema/routes.ts` does on the same table and
      // for the reason its own comment gives: event_schema is
      // ReplacingMergeTree(last_seen), so duplicates collapse AT MERGE TIME
      // and not before. Until the parts merge, one key legitimately appears
      // more than once -- and this assertion is exact equality against a
      // five-element list, so a second `plan` row fails it.
      //
      // Not FINAL, deliberately: routes.ts:67-69 already argues that case,
      // and it applies here identically -- a FINAL read depends on whether a
      // merge has happened, which is the very thing that is not guaranteed.
      //
      // The other three ClickHouse assertions in this file were checked
      // against the same question and are already safe: person_traits and
      // device_index are read through argMaxMerge/argMinMerge with a GROUP BY,
      // and the device count is uniqExact -- all part-agnostic.
      query: `SELECT DISTINCT property_key, value_kind FROM event_schema
              WHERE project_id = ${projectId} AND event_name = '$identify'
              ORDER BY property_key, value_kind`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ property_key: string; value_kind: string }>()
    const byKind = (kind: string) =>
      rows.filter((r) => r.value_kind === kind).map((r) => r.property_key)

    expect(byKind('string')).toEqual([
      'country',
      'display_name',
      'is_trial',
      'plan',
      'signup_source',
    ])
    expect(byKind('number')).toEqual(['mrr_usd', 'seats'])
  })

  it('reads event_schema in a way an UNMERGED duplicate cannot break', async () => {
    // The test above failed on CI twice in a row before this fix, and it
    // failed on nothing but timing: a second `plan` row that a merge had not
    // yet collapsed. Reproducing that by waiting for the right merge state is
    // not a test, so the duplicate is written DIRECTLY -- ReplacingMergeTree
    // accepts it happily, which is the whole point of the engine.
    //
    // This makes the guarantee deterministic instead of probabilistic: with
    // DISTINCT the extra row is invisible, without it the key appears twice.
    await ch.insert({
      table: 'event_schema',
      values: [
        {
          project_id: projectId,
          event_name: '$identify',
          property_key: 'plan',
          value_kind: 'string',
          last_seen: '2020-01-01 00:00:00',
        },
      ],
      format: 'JSONEachRow',
    })

    const rs = await ch.query({
      query: `SELECT DISTINCT property_key, value_kind FROM event_schema
              WHERE project_id = ${projectId} AND event_name = '$identify'
              ORDER BY property_key, value_kind`,
      format: 'JSONEachRow',
    })
    const keys = (await rs.json<{ property_key: string; value_kind: string }>())
      .filter((r) => r.value_kind === 'string')
      .map((r) => r.property_key)

    expect(keys.filter((k) => k === 'plan').length, 'a duplicated key must read as one').toBe(1)
    expect(keys).toEqual(['country', 'display_name', 'is_trial', 'plan', 'signup_source'])
  })

  it('populates person_traits with the values the trait picklist reads', async () => {
    const rs = await ch.query({
      query: `SELECT DISTINCT value FROM (
                SELECT argMaxMerge(value_str) AS value, argMaxMerge(has_num) AS has_num
                FROM person_traits
                WHERE project_id = ${projectId} AND trait_key = 'plan'
                GROUP BY project_id, anonymous_id, user_id, trait_key
              ) WHERE has_num = 0 ORDER BY value`,
      format: 'JSONEachRow',
    })
    expect((await rs.json<{ value: string }>()).map((r) => r.value)).toEqual([
      'enterprise',
      'free',
      'pro',
    ])
  })

  it('populates device_index with one row set per device', async () => {
    const devices = await scalar(
      `SELECT uniqExact(anonymous_id) AS n FROM device_index
       WHERE project_id = ${projectId} AND ${ours()}`,
    )
    expect(devices).toBe(60)
  })

  it('records first-touch acquisition where a context predicate can find it', async () => {
    const withSource = await scalar(
      `SELECT count() AS n FROM (
         SELECT argMinMerge(first_source) AS s FROM device_index
         WHERE project_id = ${projectId} AND ${ours()}
         GROUP BY project_id, anonymous_id, user_id, month
       ) WHERE s != ''`,
    )
    expect(withSource).toBeGreaterThan(0)
    expect(withSource).toBeLessThan(60)
  })

  /**
   * THE ONE THAT WOULD FAIL IF THE BINDINGS WERE SKIPPED. Every event of an
   * identified person — including the anonymous ones from before they signed up
   * — must resolve to that person. Without the Postgres binding rows and a
   * dictionary that has loaded them, `dictGetOrDefault` answers with the
   * device's own anonymous id, the pre-signup events become a separate
   * "person", and every population count is wrong in a way that looks
   * plausible.
   */
  it('resolves an anonymous-then-identified visitor to one person', async () => {
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })

    const identified = data.persons.filter((p) => p.identified)
    expect(identified.length).toBeGreaterThan(0)

    const resolved = resolvedPersonExpr({ database: CH_DB, alias: 'e' })
    const rs = await ch.query({
      query: `SELECT ${resolved} AS person_id, count() AS n
              FROM events AS e WHERE e.project_id = ${projectId} AND ${ours('e.')}
              GROUP BY person_id`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ person_id: string; n: string }>()
    const counts = new Map(rows.map((r) => [r.person_id, Number(r.n)]))

    // One resolved person per generated person, no more and no fewer.
    expect(counts.size).toBe(data.persons.length)

    for (const person of identified) {
      const own = data.events.filter((e) => e.payload.anonymous_id === person.anonymousId).length
      const anonymousOnes = data.events.filter(
        (e) =>
          e.payload.anonymous_id === person.anonymousId &&
          e.at.getTime() < (person.identifyAt?.getTime() ?? 0),
      ).length

      // There really were pre-identify events to attach retroactively...
      expect(anonymousOnes).toBeGreaterThan(0)
      // ...and all of them resolved to the person, not to the device.
      expect(counts.get(person.personId)).toBe(own)
      expect(counts.has(person.anonymousId)).toBe(false)
    }
  })

  it('leaves a never-identified visitor resolving to their own device', async () => {
    const anonymousOnly = data.persons.filter((p) => !p.identified)
    expect(anonymousOnly.length).toBeGreaterThan(0)

    const resolved = resolvedPersonExpr({ database: CH_DB, alias: 'e' })
    const ids = anonymousOnly.map((p) => `'${p.anonymousId}'`).join(',')
    const n = await scalar(
      `SELECT uniqExact(person_id) AS n FROM (
         SELECT ${resolved} AS person_id FROM events AS e
         WHERE e.project_id = ${projectId} AND ${ours('e.')}
       ) WHERE person_id IN (${ids})`,
    )
    expect(n).toBe(anonymousOnly.length)
  })

  it('adds to what is already there rather than replacing it', async () => {
    const before = await scalar(
      `SELECT count() AS n FROM events WHERE project_id = ${projectId} AND ${ours()}`,
    )
    const second = generateDemoData({
      seed: 32,
      persons: 10,
      events: 120,
      days: 30,
      anchor: ANCHOR,
    })
    await insertDemoData(second, { ch, pg, database: CH_DB, projectId })
    expect(
      await scalar(`SELECT count() AS n FROM events WHERE project_id = ${projectId} AND ${ours()}`),
    ).toBe(before + 120)
  })
})
