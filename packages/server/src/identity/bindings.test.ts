import { join } from 'node:path'
import { type BindEvent, type Binding, deriveTiling } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { IdentityBindings, MAX_CACHED_BINDINGS } from './bindings.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
let projectId: number
let bindings: IdentityBindings

beforeAll(async () => {
  // Additive-only migrate, not a wipe: this file runs standalone (e.g.
  // `vitest run packages/server/src/identity/bindings.test.ts`) as well as
  // alongside the rest of the suite, and must not assume some other file's
  // beforeAll already created the schema. Same pattern as ingest/routes.test.ts.
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM projects WHERE slug = $1', ['id-bindings-test'])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Bindings', 'id-bindings-test', 'wk_id_bindings', 'h') RETURNING id`,
  )
  projectId = Number(r.rows[0]?.id)
})

beforeEach(async () => {
  await pg.query('DELETE FROM identity_bindings WHERE project_id = $1', [projectId])
  bindings = new IdentityBindings(pg)
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = $1', ['id-bindings-test'])
  await pg.end()
  await ch.close()
})

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 6, h, m))

describe('IdentityBindings.bind', () => {
  it('writes a first binding as a bind event', async () => {
    expect(await bindings.bind(projectId, 'd1', 'alice', at(12))).toBe('written')
    const r = await pg.query<{ person_id: string; bound_at: Date }>(
      'SELECT person_id, bound_at FROM identity_bindings WHERE project_id = $1',
      [projectId],
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.person_id).toBe('alice')
    expect(r.rows[0]?.bound_at.toISOString()).toBe('2026-08-06T12:00:00.000Z')
  })

  // Catches: the memo returning 'written' on a genuine repeat (defeats the
  // point of the cache), or the DB layer ever double-inserting a row for the
  // identical (project, device, person, instant) triple.
  it('is a no-op on repeat identify for the same person at the same instant', async () => {
    await bindings.bind(projectId, 'd1', 'alice', at(12))
    expect(await bindings.bind(projectId, 'd1', 'alice', at(12))).toBe('noop')
    const r = await pg.query('SELECT count(*) c FROM identity_bindings WHERE project_id = $1', [
      projectId,
    ])
    expect(Number((r.rows[0] as { c: string }).c)).toBe(1)
  })

  // Catches: a memo keyed on (project, device) alone — without the instant —
  // that would wrongly treat this as a repeat and silently drop a genuine new
  // bind event.
  it('writes again for the same person at a different instant: a different instant is a new event', async () => {
    expect(await bindings.bind(projectId, 'd1', 'alice', at(12))).toBe('written')
    expect(await bindings.bind(projectId, 'd1', 'alice', at(13))).toBe('written')
    const r = await pg.query('SELECT count(*) c FROM identity_bindings WHERE project_id = $1', [
      projectId,
    ])
    expect(Number((r.rows[0] as { c: string }).c)).toBe(2)
  })

  it('writes a second event for a different person on the same device at a different instant', async () => {
    await bindings.bind(projectId, 'd1', 'alice', at(12))
    expect(await bindings.bind(projectId, 'd1', 'bob', at(15))).toBe('written')
    const r = await pg.query<{ person_id: string }>(
      'SELECT person_id FROM identity_bindings WHERE project_id = $1 ORDER BY bound_at',
      [projectId],
    )
    expect(r.rows.map((x) => x.person_id)).toEqual(['alice', 'bob'])
  })

  /**
   * THE test for requirement (a): a same-instant collision between two
   * different people must resolve to the identical winner regardless of
   * which of the two arrives first. Two devices exercise both arrival
   * orders of the same pair ('zed' then 'amy', and 'amy' then 'zed').
   *
   * This is the test that would catch `LEAST` being swapped for
   * `EXCLUDED.person_id` (last-writer-wins): under that mutation, deviceA
   * (zed then amy) would settle on 'amy' but deviceB (amy then zed) would
   * settle on 'zed' — the two devices would disagree, and the assertion that
   * both equal 'amy' fails. It would equally catch `DO NOTHING`
   * (first-writer-wins): deviceA would settle on 'zed', deviceB on 'amy' —
   * again disagreeing, and neither matching the expected 'amy'.
   */
  it('resolves a same-instant collision to the lexicographically smaller person_id, regardless of arrival order', async () => {
    await bindings.bind(projectId, 'device-a', 'zed', at(9))
    await bindings.bind(projectId, 'device-a', 'amy', at(9))

    await bindings.bind(projectId, 'device-b', 'amy', at(9))
    await bindings.bind(projectId, 'device-b', 'zed', at(9))

    const r = await pg.query<{ anonymous_id: string; person_id: string }>(
      `SELECT anonymous_id, person_id FROM identity_bindings
       WHERE project_id = $1 AND anonymous_id IN ('device-a', 'device-b')
       ORDER BY anonymous_id`,
      [projectId],
    )
    expect(r.rows).toEqual([
      { anonymous_id: 'device-a', person_id: 'amy' },
      { anonymous_id: 'device-b', person_id: 'amy' },
    ])
    // Exactly one row per device: the collision resolves in place, it never
    // produces two rows for the identical (device, instant).
    const count = await pg.query('SELECT count(*) c FROM identity_bindings WHERE project_id = $1', [
      projectId,
    ])
    expect(Number((count.rows[0] as { c: string }).c)).toBe(2)
  })

  // The memo must cache the value Postgres actually settled on, not the
  // argument passed in — otherwise the losing side of a collision would
  // wrongly memoize itself as bound, and a later repeat call from that same
  // loser would report a false 'noop' against a row that actually holds the
  // winner.
  it('does not let the losing side of a collision poison its own memo with a false noop', async () => {
    await bindings.bind(projectId, 'device-c', 'amy', at(9)) // winner, arrives first
    expect(await bindings.bind(projectId, 'device-c', 'zed', at(9))).toBe('written') // loses the tie
    // zed asking again must see that it did NOT actually end up bound here.
    expect(await bindings.bind(projectId, 'device-c', 'zed', at(9))).toBe('written')
    const r = await pg.query<{ person_id: string }>(
      `SELECT person_id FROM identity_bindings WHERE project_id = $1 AND anonymous_id = 'device-c'`,
      [projectId],
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.person_id).toBe('amy')
  })

  it('survives concurrent binds of the same device without violating the constraint', async () => {
    const results = await Promise.allSettled([
      bindings.bind(projectId, 'race', 'alice', at(12)),
      new IdentityBindings(pg).bind(projectId, 'race', 'bob', at(12)),
    ])
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true)
    const r = await pg.query<{ person_id: string }>(
      'SELECT person_id FROM identity_bindings WHERE project_id = $1 AND anonymous_id = $2',
      [projectId, 'race'],
    )
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]?.person_id).toBe('alice') // lexicographically smaller of alice/bob
  })

  it('bounds its cache so unknown device ids cannot grow it without limit', async () => {
    const b = new IdentityBindings(pg, { cacheMax: 4 })
    for (let i = 0; i < 20; i++) await b.bind(projectId, `flood-${i}`, `p-${i}`, at(12))
    expect(b.cacheSize).toBeLessThanOrEqual(4)
  })

  it('resolves every id belonging to a person, for single-person reads', async () => {
    await bindings.bind(projectId, 'phone', 'alice', at(12))
    await bindings.bind(projectId, 'laptop', 'alice', at(13))
    const ids = await bindings.personIdsFor(projectId, 'alice')
    expect(ids.sort()).toEqual(['alice', 'laptop', 'phone'])
  })

  it('exposes a documented cache cap', () => {
    expect(MAX_CACHED_BINDINGS).toBeGreaterThan(0)
  })

  // Requirement (b): bound_at is truncated to millisecond precision on write.
  // JS's Date can never itself carry a fractional millisecond (the spec's
  // TimeClip truncates at construction), so this is defense against a value
  // arriving via some other route with a real microsecond component — proven
  // here by round-tripping a written row through Postgres's own microsecond
  // extraction rather than trusting the JS-side Date to have testified to
  // anything.
  it('always stores bound_at with a zero microsecond remainder below one millisecond', async () => {
    await bindings.bind(projectId, 'd-trunc', 'alice', at(12, 34))
    const r = await pg.query<{ us: number }>(
      `SELECT EXTRACT(microseconds FROM bound_at)::int % 1000 AS us
         FROM identity_bindings WHERE project_id = $1 AND anonymous_id = 'd-trunc'`,
      [projectId],
    )
    expect(r.rows[0]?.us).toBe(0)
  })
})

/**
 * Requirement (c): the TypeScript reference derivation (`deriveTiling`) and
 * the SQL view it mirrors (`identity_bindings_dict_src`) must agree on every
 * shape of bind-event set this write path can produce. Nothing else in the
 * suite ties the two together — `ranges.test.ts` tests `deriveTiling` in
 * isolation and `schema-identity.test.ts` tests the view in isolation — so
 * this is the only place a drift between them would surface.
 */
describe('IdentityBindings write path agrees with deriveTiling', () => {
  const EPOCH_MS = Date.UTC(1970, 0, 1)
  const CH_MAX_MS = Date.parse('2106-02-07T06:28:15.000Z')

  /** Mirrors identity_bindings_dict_src's GREATEST/LEAST clamp to the range
   * ClickHouse's DateTime can represent. */
  function clampForView(b: Binding): { from: number; to: number } {
    return { from: Math.max(b.from, EPOCH_MS), to: Math.min(b.to, CH_MAX_MS) }
  }

  async function assertViewMatchesReference(anonymousId: string, events: BindEvent[]) {
    for (const e of events) {
      await bindings.bind(projectId, anonymousId, e.personId, new Date(e.boundAt))
    }

    const r = await pg.query<{ person_id: string; valid_from: Date; valid_to: Date }>(
      `SELECT person_id, valid_from, valid_to FROM identity_bindings_dict_src
       WHERE project_id = $1 AND anonymous_id = $2 ORDER BY valid_from`,
      [projectId, anonymousId],
    )
    const actual = r.rows.map((row) => ({
      personId: row.person_id,
      from: row.valid_from.getTime(),
      to: row.valid_to.getTime(),
    }))

    const expected = deriveTiling(events).map((b) => ({
      personId: b.personId,
      ...clampForView(b),
    }))

    expect(actual).toEqual(expected)
  }

  it('agrees on a mixed set of distinct people, tiling with no gaps or overlaps', async () => {
    await assertViewMatchesReference('mix', [
      { personId: 'alice', boundAt: at(8).getTime() },
      { personId: 'bob', boundAt: at(14).getTime() },
      { personId: 'carol', boundAt: at(11).getTime() },
    ])
  })

  it('agrees on a same-instant collision between two people', async () => {
    await assertViewMatchesReference('collision', [
      { personId: 'zed', boundAt: at(10).getTime() },
      { personId: 'amy', boundAt: at(10).getTime() },
      { personId: 'bob', boundAt: at(15).getTime() },
    ])
  })

  it('agrees on repeated same-person events, uncollapsed', async () => {
    await assertViewMatchesReference('repeat', [
      { personId: 'p', boundAt: at(1).getTime() },
      { personId: 'p', boundAt: at(5).getTime() },
      { personId: 'q', boundAt: at(9).getTime() },
    ])
  })

  it('agrees when a late, out-of-order identify retroactively attaches earlier history', async () => {
    // Written in this order (bob first) but alice's earlier boundAt must
    // still own the -infinity slot once both events exist.
    await assertViewMatchesReference('retroactive', [
      { personId: 'bob', boundAt: at(20).getTime() },
      { personId: 'alice', boundAt: at(5).getTime() },
    ])
  })
})
