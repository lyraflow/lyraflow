//
// Seeds a real ClickHouse and asserts POPULATIONS, not SQL text. Every other
// segment test in this plan asserts the shape of a string; this is the only
// one that would notice the compiler emitting valid SQL that means the wrong
// thing.
import { join } from 'node:path'
import { type Cursor, type FilterNode, compileSegment } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type PgDictionarySource, ensureIdentityDictionaries } from '../identity/dictionaries.js'
import { runSegment, runSegmentMembers } from './execute.js'

const CH_DB = 'lyraflow_test'
const PROJECT = 7700
const NOW = new Date('2026-08-07T00:00:00.000Z')

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
})

// ClickHouse resolves the dictionary source itself, from inside the compose
// network — see the identical note in dictionaries.test.ts.
const pgSource: PgDictionarySource = {
  host: 'postgres',
  port: 5432,
  user: 'lyraflow',
  password: 'lyraflow',
  database: CH_DB,
}

const uuid = (n: number) => `77000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// Module scope, not local to beforeAll, so the tie-break test below can
// build additional rows with the exact same shape as the seed fixture.
const ev = (
  id: string,
  anon: string,
  user: string,
  name: string,
  ts: string,
  properties: Record<string, string> = {},
) => ({
  project_id: PROJECT,
  event_id: id,
  anonymous_id: anon,
  user_id: user,
  event_name: name,
  timestamp: ts,
  received_at: ts,
  trusted: 1,
  properties,
  properties_num: {},
})

const count = (filter: FilterNode) =>
  runSegment({
    client: ch,
    compiled: compileSegment({
      query: { ast_version: 1, filter } as never,
      projectId: PROJECT,
      database: CH_DB,
      now: NOW,
    }),
  })

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })

  // The project row has to exist: suppressed_persons references projects(id).
  // Deleting it first cascades away any suppression row a previous run left
  // behind — without that, the suppression test below reads a population that
  // is already one short and can never observe the decrement it asserts.
  await pg.query('DELETE FROM projects WHERE id = $1', [PROJECT])
  await pg.query(
    `INSERT INTO projects (id, name, slug, write_key, server_key_hash)
     VALUES ($1, 'Segments', 'segments-exec-test', 'wk_segments_exec', 'h')`,
    [PROJECT],
  )
  await ensureIdentityDictionaries(ch, pgSource)
  await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })

  // alice: trial, ran import 3x in the last week, never invited
  // bob:   trial, ran import once, DID invite
  // carol: pro,   ran import 3x
  await ch.insert({
    table: 'events',
    format: 'JSONEachRow',
    values: [
      ev(uuid(1), 'dev-a', 'alice', '$identify', '2026-08-01 00:00:00.000', { plan: 'trial' }),
      ev(uuid(2), 'dev-a', 'alice', 'import_started', '2026-08-03 00:00:00.000'),
      ev(uuid(3), 'dev-a', 'alice', 'import_started', '2026-08-04 00:00:00.000'),
      ev(uuid(4), 'dev-a', 'alice', 'import_started', '2026-08-05 00:00:00.000'),
      ev(uuid(5), 'dev-b', 'bob', '$identify', '2026-08-01 00:00:00.000', { plan: 'trial' }),
      ev(uuid(6), 'dev-b', 'bob', 'import_started', '2026-08-03 00:00:00.000'),
      ev(uuid(7), 'dev-b', 'bob', 'invite_teammate', '2026-08-04 00:00:00.000'),
      ev(uuid(8), 'dev-c', 'carol', '$identify', '2026-08-01 00:00:00.000', { plan: 'pro' }),
      ev(uuid(9), 'dev-c', 'carol', 'import_started', '2026-08-03 00:00:00.000'),
      ev(uuid(10), 'dev-c', 'carol', 'import_started', '2026-08-04 00:00:00.000'),
      ev(uuid(11), 'dev-c', 'carol', 'import_started', '2026-08-05 00:00:00.000'),
    ],
  })
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE id = $1', [PROJECT])
  await pg.end()
  await ch.close()
})

const trialTrait: FilterNode = { kind: 'trait', key: 'plan', operator: '=', value: 'trial' }
const ranImport3x: FilterNode = {
  kind: 'behavior',
  event: 'import_started',
  aggregate: 'count',
  operator: '>=',
  value: 3,
  window: { kind: 'last', n: 7, unit: 'days' },
}
const invited: FilterNode = {
  kind: 'behavior',
  event: 'invite_teammate',
  aggregate: 'count',
  operator: '>=',
  value: 1,
  window: { kind: 'ever' },
}

describe('runSegment (live ClickHouse)', () => {
  it("runs the spec's worked example and returns only alice", async () => {
    // "trial users who ran import at least 3 times in the last 7 days but
    //  never invited a teammate"
    await expect(
      count({
        kind: 'group',
        op: 'and',
        children: [trialTrait, ranImport3x, { kind: 'not', child: invited }],
      }),
    ).resolves.toBe(1)
  })

  it('counts everyone in the base population with a trivially true tree', async () => {
    // Proves the base population includes people no behaviour touches — the
    // property that makes NOT and OR well-defined.
    await expect(
      count({
        kind: 'lifecycle',
        field: 'first_seen',
        operator: '>',
        value: '2020-01-01T00:00:00.000Z',
      }),
    ).resolves.toBe(3)
  })

  it('counts people who NEVER did something without an anti-join', async () => {
    // alice and carol never invited.
    await expect(count({ kind: 'not', child: invited })).resolves.toBe(2)
  })

  it('does not double-count a retried delivery', async () => {
    // Same event_id, different timestamp — exactly what a retry that omitted
    // `timestamp` produces. Stored as a second row by ReplacingMergeTree's
    // sort key, so a naive countIf sees alice importing 4 times.
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          project_id: PROJECT,
          event_id: uuid(4),
          anonymous_id: 'dev-a',
          user_id: 'alice',
          event_name: 'import_started',
          timestamp: '2026-08-05 00:00:01.000',
          received_at: '2026-08-05 00:00:01.000',
          trusted: 1,
          properties: {},
          properties_num: {},
        },
      ],
    })

    const atLeast4: FilterNode = {
      kind: 'behavior',
      event: 'import_started',
      aggregate: 'count',
      operator: '>=',
      value: 4,
      window: { kind: 'last', n: 7, unit: 'days' },
    }
    // alice has 3 distinct imports and one duplicate row. Without dedup this
    // returns 1.
    await expect(count(atLeast4)).resolves.toBe(0)
  })

  it('excludes a suppressed person from every result', async () => {
    const before = await count(trialTrait)
    await pg.query(
      `INSERT INTO suppressed_persons (project_id, person_id) VALUES ($1, 'alice')
       ON CONFLICT DO NOTHING`,
      [PROJECT],
    )
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })
    await expect(count(trialTrait)).resolves.toBe(before - 1)

    // Un-suppress: this file has no per-test isolation, only a per-run one in
    // beforeAll, so a row left behind here would silently bleed into every
    // test declared below — including the members-mode tests that assume
    // alice is visible. Restoring the pre-test state here, not just at the
    // end of the run, is what keeps declaration-order tests independent.
    await pg.query(`DELETE FROM suppressed_persons WHERE project_id = $1 AND person_id = 'alice'`, [
      PROJECT,
    ])
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })
  })

  const listMembers = (filter: FilterNode, cursor?: Cursor) =>
    runSegmentMembers({
      client: ch,
      compiled: compileSegment({
        query: { ast_version: 1, filter } as never,
        projectId: PROJECT,
        database: CH_DB,
        now: NOW,
        select: 'members',
        cursor,
      }),
    })

  it('returns the people a segment matches, not merely valid SQL', async () => {
    const rows = await listMembers(trialTrait)
    expect(rows.map((r) => r.person_id).sort()).toEqual(['alice', 'bob'])
  })

  it('orders by last_seen descending', async () => {
    const rows = await listMembers({
      kind: 'lifecycle',
      field: 'first_seen',
      operator: '>',
      value: '2020-01-01T00:00:00.000Z',
    })
    const seen = rows.map((r) => r.last_seen)
    expect([...seen].sort().reverse()).toEqual(seen)
  })

  it('carries the context columns keyed by field name', async () => {
    const [row] = await listMembers(trialTrait)
    expect(row).toHaveProperty('country')
    expect(row).toHaveProperty('utm_source')
    // Traits are deliberately not returned.
    expect(row).not.toHaveProperty('plan')
  })

  it('continues after a cursor without repeating the boundary row', async () => {
    const all = await listMembers({
      kind: 'lifecycle',
      field: 'first_seen',
      operator: '>',
      value: '2020-01-01T00:00:00.000Z',
    })
    const first = all[0]
    if (!first) throw new Error('fixture produced no rows')
    const rest = await listMembers(
      {
        kind: 'lifecycle',
        field: 'first_seen',
        operator: '>',
        value: '2020-01-01T00:00:00.000Z',
      },
      {
        lastSeen: first.last_seen,
        personId: first.person_id,
        // Required by the Cursor type but never read by compileSegment —
        // asOf is the HTTP layer's contract for pinning one instant across
        // a walk, which this direct-compiler test never round-trips through.
        asOf: NOW.toISOString(),
      },
    )
    expect(rest.map((r) => r.person_id)).not.toContain(first.person_id)
    expect(rest.length).toBe(all.length - 1)
  })

  it('excludes a suppressed person from a member list too', async () => {
    // The guardrail must hold in the second output mode, not only in count.
    await pg.query(
      `INSERT INTO suppressed_persons (project_id, person_id) VALUES ($1, 'bob')
       ON CONFLICT DO NOTHING`,
      [PROJECT],
    )
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })
    const rows = await listMembers(trialTrait)
    // Exact expected set, not `not.toContain('bob')` — that assertion passes
    // equally on an EMPTY result, so it would not notice the whole trial
    // cohort silently vanishing alongside bob. alice is the only trial
    // person left once bob is suppressed.
    expect(rows.map((r) => r.person_id)).toEqual(['alice'])

    // Un-suppress, same reasoning as the count-mode suppression test above:
    // this file has no per-test isolation, only a per-run one in beforeAll,
    // so a row left behind here would silently bleed into every test
    // declared below it.
    await pg.query(`DELETE FROM suppressed_persons WHERE project_id = $1 AND person_id = 'bob'`, [
      PROJECT,
    ])
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })
  })

  // THE live-coverage test for the `last_seen = :x AND person_id > :y`
  // tie-break branch (compile.ts's `after` clause). The three-person seed
  // fixture was shaped to give alice and carol an incidental last_seen tie
  // (both last touched at '2026-08-05 00:00:00.000'), but "does not
  // double-count a retried delivery" above inserts a later-timestamped row
  // for alice specifically to test dedup, which as a side effect pushes her
  // last_seen past carol's and destroys that tie before this point in the
  // file — so relying on it would leave the tie-break branch with no live
  // coverage. This uses two FRESH people with a deliberately, unambiguously
  // shared last_seen instead, independent of anything the other tests do to
  // the seed fixture's timestamps.
  it('does not skip or repeat either side of a genuine last_seen tie across a cursor boundary', async () => {
    const TIE_TS = '2026-08-06 00:00:00.000'
    const dora = uuid(20)
    const edgar = uuid(21)
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        ev(dora, 'dev-dora', 'dora', '$identify', TIE_TS, { plan: 'tie-test' }),
        ev(edgar, 'dev-edgar', 'edgar', '$identify', TIE_TS, { plan: 'tie-test' }),
      ],
    })

    try {
      const tieTrait: FilterNode = { kind: 'trait', key: 'plan', operator: '=', value: 'tie-test' }
      const [first, second] = await listMembers(tieTrait)
      if (!first || !second) throw new Error('fixture produced fewer than two tied rows')
      expect(first.last_seen).toBe(second.last_seen)
      // The projection's own ORDER BY breaks the tie on person_id ASC, so
      // dora (lexicographically first) sorts ahead of edgar — pinning which
      // row is "the boundary" below, not just that some order was produced.
      expect([first.person_id, second.person_id]).toEqual(['dora', 'edgar'])

      const rest = await listMembers(tieTrait, {
        lastSeen: first.last_seen,
        personId: first.person_id,
        asOf: NOW.toISOString(),
      })
      // edgar must appear EXACTLY once past the boundary: `last_seen < :x`
      // alone (no tie-break) would skip every row sharing the boundary
      // instant, including edgar; a tie-break that compared the wrong
      // direction would instead repeat dora.
      expect(rest.map((r) => r.person_id)).toEqual(['edgar'])
    } finally {
      // Unlike the seed fixture's alice/bob/carol (fixed ids the whole file
      // is built around) and the intentional duplicate row above, dora and
      // edgar are TWO EXTRA distinct people this test alone introduces. This
      // file has no per-test isolation and PROJECT (7700) is a fixed id
      // never cleared at the top of beforeAll — left behind, they would
      // silently inflate every population-count assertion in this file on
      // its NEXT run (a real failure mode hit while writing this test: a
      // clean run afterwards saw 5 people instead of 3).
      await ch.command({
        query: `ALTER TABLE events DELETE WHERE project_id = ${PROJECT} AND event_id IN ('${dora}', '${edgar}')`,
      })
    }
  })
})
