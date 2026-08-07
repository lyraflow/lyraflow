import { join } from 'node:path'
import { type BindEvent, type Binding, deriveTiling } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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

const at = (h: number, m = 0, s = 0, ms = 0) => new Date(Date.UTC(2026, 7, 6, h, m, s, ms))

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
  // bind event. Catches equally a write-side "skip if this person is already
  // in force" suppression, which was implemented and reverted for not being
  // order-invariant (see BIND_SQL's docstring, and the differential fixture
  // 'reclaim' below which demonstrates the loss).
  it('writes again for the same person at a different instant: a different instant is a new event', async () => {
    expect(await bindings.bind(projectId, 'd1', 'alice', at(12))).toBe('written')
    expect(await bindings.bind(projectId, 'd1', 'alice', at(13))).toBe('written')
    const r = await pg.query('SELECT count(*) c FROM identity_bindings WHERE project_id = $1', [
      projectId,
    ])
    expect(Number((r.rows[0] as { c: string }).c)).toBe(2)
  })

  // Kept from the reverted suppression work: the property is worth pinning
  // either way. 'bob' holds d-late from 10:00 and 'alice' from 20:00, and
  // then a LATE, out-of-order identify places alice at 15:00 — an instant at
  // which BOB is the person in force. It must be written: alice, not bob,
  // held the device from 15:00, and without the row every event in
  // [15:00, 20:00) resolves to bob.
  //
  // Catches: a memo keyed on (project, device) alone, which sees "alice again
  // on d-late" and returns a false 'noop'. Catches any write-side suppression
  // that compares the incoming person against the device's most recent bind
  // (alice@20:00) rather than against nothing at all.
  it('writes a late, out-of-order identify whose instant belongs to a different person', async () => {
    await bindings.bind(projectId, 'd-late', 'bob', at(10))
    await bindings.bind(projectId, 'd-late', 'alice', at(20))
    expect(await bindings.bind(projectId, 'd-late', 'alice', at(15))).toBe('written')
    const r = await pg.query<{ person_id: string }>(
      `SELECT person_id FROM identity_bindings
        WHERE project_id = $1 AND anonymous_id = 'd-late' ORDER BY bound_at`,
      [projectId],
    )
    expect(r.rows.map((x) => x.person_id)).toEqual(['bob', 'alice', 'alice'])
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

  // Both halves matter. The upper bound alone was vacuous: deleting
  // `#remember`'s body entirely leaves the cache permanently at 0, which
  // satisfies `<= 4` perfectly while removing the memo this test is named
  // after. The lower bound is what makes the cap a claim about a cache that
  // actually holds something.
  it('populates its cache, and bounds it so unknown device ids cannot grow it without limit', async () => {
    const b = new IdentityBindings(pg, { cacheMax: 4 })
    for (let i = 0; i < 20; i++) await b.bind(projectId, `flood-${i}`, `p-${i}`, at(12))
    expect(b.cacheSize).toBeGreaterThan(0)
    expect(b.cacheSize).toBeLessThanOrEqual(4)
  })

  // Replaces the personIdsFor test deleted with that method: devicesForAny is
  // what the read route actually calls, and nothing covered its multi-device
  // case directly.
  it('collects every device bound to any member of a person group', async () => {
    await bindings.bind(projectId, 'phone', 'alice', at(12))
    await bindings.bind(projectId, 'laptop', 'alice', at(13))
    await bindings.bind(projectId, 'tablet', 'alice-merged-away', at(13))
    const devices = await bindings.devicesForAny(projectId, ['alice', 'alice-merged-away'])
    expect(devices.sort()).toEqual(['laptop', 'phone', 'tablet'])
  })

  it('exposes a documented cache cap', () => {
    expect(MAX_CACHED_BINDINGS).toBeGreaterThan(0)
  })

  it('returns every bind event on a device, including binds to other people', async () => {
    // The other-person binds are what CLOSE a window. Returning only the
    // requested person's binds would leave every window open to infinity and
    // hand a rebound device's whole history back to its first owner.
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at) VALUES
         ($1, 'shared', 'alice', '2026-08-01T00:00:00Z'),
         ($1, 'shared', 'bob',   '2026-08-05T00:00:00Z')`,
      [projectId],
    )
    const events = await bindings.bindEventsForDevices(projectId, ['shared'])
    const forDevice = events.get('shared') ?? []
    expect(forDevice.map((e) => e.personId)).toEqual(['alice', 'bob'])
    expect(forDevice[0]?.boundAt).toBe(Date.parse('2026-08-01T00:00:00Z'))
  })

  // The union-bug fixture above (alice, bob) happens to have person_id and
  // bound_at agree on ordering, so it cannot tell "ORDER BY bound_at" apart
  // from "ORDER BY person_id" — deleting `bound_at ASC` from the ORDER BY
  // stays green against it. 'zed' before 'amy' inverts that: alphabetically
  // amy < zed, but zed binds first, so only a genuine bound_at sort produces
  // ['zed', 'amy'].
  it('orders bind events by when they happened, not by person id', async () => {
    await bindings.bind(projectId, 'order-check', 'zed', at(1))
    await bindings.bind(projectId, 'order-check', 'amy', at(5))
    const events = await bindings.bindEventsForDevices(projectId, ['order-check'])
    expect(events.get('order-check')?.map((e) => e.personId)).toEqual(['zed', 'amy'])
  })

  // No earlier test passes more than one device to bindEventsForDevices, so
  // nothing else here reaches the grouping logic (`out.get(...) ?? []` then
  // `out.set(...)`) with two keys in play. A regression that merged every
  // row into one bucket, or dropped a key, would pass the rest of this file
  // as it stands.
  it('keeps each device events separate when several are fetched at once', async () => {
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at) VALUES
         ($1, 'multi-a', 'ann', '2026-08-01T00:00:00Z'),
         ($1, 'multi-a', 'bea', '2026-08-03T00:00:00Z'),
         ($1, 'multi-b', 'cyd', '2026-08-02T00:00:00Z')`,
      [projectId],
    )
    const events = await bindings.bindEventsForDevices(projectId, ['multi-a', 'multi-b'])
    expect(events.size).toBe(2)
    expect(events.get('multi-a')?.map((e) => e.personId)).toEqual(['ann', 'bea'])
    expect(events.get('multi-b')?.map((e) => e.personId)).toEqual(['cyd'])
  })

  it('returns an empty map for no devices, without querying', async () => {
    // Postgres's ANY('{}') matches nothing anyway, so a plain size===0
    // assertion would stay green even if the empty-array guard were deleted
    // and the query ran regardless — it would just come back empty. Spying
    // on the pool is what actually pins "without querying", as the test name
    // claims.
    const spy = vi.spyOn(pg, 'query')
    try {
      expect((await bindings.bindEventsForDevices(projectId, [])).size).toBe(0)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  // NaN specifically, not just "some invalid value": `#remember` evicts with
  // `while (size >= this.#cacheMax)`, and `size >= NaN` is always false, so a
  // NaN cap silently disables eviction and makes a cache keyed on an id that
  // arrives through a PUBLIC write key unbounded. Same class of defect
  // dictionaries.ts's Number.isInteger check on `port` exists for.
  // Catches: deleting the constructor guard (no throw).
  it('rejects a cache cap that is not a positive integer', () => {
    expect(() => new IdentityBindings(pg, { cacheMax: Number.NaN })).toThrow(/cacheMax/)
    expect(() => new IdentityBindings(pg, { cacheMax: 0 })).toThrow(/cacheMax/)
    expect(() => new IdentityBindings(pg, { cacheMax: 2.5 })).toThrow(/cacheMax/)
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
  const ONE_SECOND_MS = 1000

  /**
   * Mirrors identity_bindings_dict_src's GREATEST/LEAST clamp to the range
   * ClickHouse's DateTime can represent, its -1 second adjustment on the
   * finite (has-a-successor) upper bound, AND its `WHERE valid_to >=
   * valid_from` filter (see 003_identity.sql for the full reasoning behind
   * all three).
   *
   * `deriveTiling` models a tile as half-open [from, to) — the next tile
   * starts exactly where this one ends, no shared instant — but ClickHouse's
   * RANGE(MIN ... MAX ...) is inclusive at both ends, so the view achieves
   * the same half-open behaviour, discretised to its columns' one-second
   * resolution, by subtracting a second from every finite `to` (see
   * resolve.test.ts's live 'does not misattribute an event landing within
   * the same second as a rebind' for what regresses without it). The open
   * (+Infinity) upper bound has no successor to butt up against, so it is
   * left at its clamp, unadjusted.
   *
   * That same -1s subtraction can invert a tile — two binds for one device
   * inside the same wall-clock second, where the earlier is not the
   * device's first-ever bind, produce a clamped `to < from`. The view drops
   * that row entirely (`WHERE valid_to >= valid_from`) rather than clamping
   * it to a zero-width sliver — a zero-width tile would sit at the same
   * ClickHouse-truncated second as its successor's own truncated
   * `valid_from`, reintroducing the exact same-instant tie the -1s fix
   * exists to avoid. `null` here signals exactly that: "the view would not
   * emit this row at all", not "clamp it to something small".
   *
   * This function is what ties `deriveTiling` and the SQL view back
   * together and keeps them from drifting apart unnoticed — see
   * ranges.ts's docstring. Missing the filter here left that promise only
   * half kept: none of the four original fixtures below had binds under a
   * second apart, so an inverted tile never reached this function, and
   * `clampForView` returning one anyway (instead of `null`) would have gone
   * uncaught. The 'sub-second binds' fixture exists specifically to
   * exercise that path.
   */
  function clampForView(b: Binding): { from: number; to: number } | null {
    const to =
      b.to === Number.POSITIVE_INFINITY ? CH_MAX_MS : Math.min(b.to - ONE_SECOND_MS, CH_MAX_MS)
    const from = Math.max(b.from, EPOCH_MS)
    return to >= from ? { from, to } : null
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

    // flatMap, not map: a tile clampForView reports as null (dropped by the
    // view's own WHERE filter) must be absent from `expected`, not present
    // as `null` or as a clamped-but-inverted row — mirroring the view
    // exactly, including in row *count*, is the point.
    // Derived from the RAW event list, never from a model of what the write
    // path chose to store. That distinction is load-bearing: while a
    // write-side suppression was briefly in place, this line modelled it
    // instead, which made `expected` a restatement of the implementation
    // rather than of the ideal derivation — both sides encoded the same rule,
    // so the comparison could no longer detect that the stored rows resolved
    // differently from deriveTiling over the events actually submitted. The
    // reference must stay independent of the write path for this test to mean
    // anything.
    const expected = deriveTiling(events).flatMap((b) => {
      const clamped = clampForView(b)
      return clamped ? [{ personId: b.personId, ...clamped }] : []
    })

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

  // All three events are stored — adjacent same-person events are never
  // collapsed, on either side. The explicit row count is the honest statement
  // of this module's growth characteristic (see IdentityBindings' docstring):
  // three identifies produce three rows even when two of them say the same
  // thing. It is also what a write-side suppression would break, which is why
  // it is asserted rather than left implicit.
  it('agrees on repeated same-person events, uncollapsed', async () => {
    await assertViewMatchesReference('repeat', [
      { personId: 'p', boundAt: at(1).getTime() },
      { personId: 'p', boundAt: at(5).getTime() },
      { personId: 'q', boundAt: at(9).getTime() },
    ])
    const r = await pg.query('SELECT count(*) c FROM identity_bindings WHERE anonymous_id = $1', [
      'repeat',
    ])
    expect(Number((r.rows[0] as { c: string }).c)).toBe(3)
  })

  // THE fixture for the hazard that killed the write-side suppression, kept
  // as a permanent guard against it being reintroduced. Submitted in exactly
  // the order that breaks a point-in-time "is this person already in force?"
  // check: alice@10:00, then alice@20:00 (redundant AT THE MOMENT it arrives
  // — alice is in force there — and therefore suppressible), then a LATE
  // bob@15:00 which splits the tile the suppressed event was sitting inside.
  //
  // With all three stored the tiling is alice[-inf,15) bob[15,20)
  // alice[20,+inf), which is what deriveTiling over the raw events says and
  // what this assertion pins. With alice@20:00 suppressed it is
  // alice[-inf,15) bob[15,+inf) — alice never gets the device back, silently
  // and permanently. Nothing else in this file submits events in an order
  // where a suppressed event is later split, so without this fixture that
  // whole class of write-side optimisation looks safe.
  it('agrees when a late bind splits a tile an earlier redundant-looking event sat inside', async () => {
    await assertViewMatchesReference('reclaim', [
      { personId: 'alice', boundAt: at(10).getTime() },
      { personId: 'alice', boundAt: at(20).getTime() },
      { personId: 'bob', boundAt: at(15).getTime() },
    ])
    const r = await pg.query<{ person_id: string }>(
      `SELECT person_id FROM identity_bindings_dict_src
        WHERE project_id = $1 AND anonymous_id = 'reclaim' ORDER BY valid_from`,
      [projectId],
    )
    // Stated as a resolution claim, not only as a tiling comparison: alice
    // must own the timeline again after 20:00.
    expect(r.rows.map((x) => x.person_id)).toEqual(['alice', 'bob', 'alice'])
  })

  it('agrees when a late, out-of-order identify retroactively attaches earlier history', async () => {
    // Written in this order (bob first) but alice's earlier boundAt must
    // still own the -infinity slot once both events exist.
    await assertViewMatchesReference('retroactive', [
      { personId: 'bob', boundAt: at(20).getTime() },
      { personId: 'alice', boundAt: at(5).getTime() },
    ])
  })

  // Task 6 review round 4: none of the four fixtures above has binds under a
  // second apart, so clampForView's `null`-drop path (added for this fixture)
  // was never actually exercised until now — an implementation that dropped
  // that path back to always returning a clamped `{ from, to }` would have
  // left every fixture above green. 'first-of-pair' is bound 0.4s after
  // 'earlier-owner' — NOT the device's first tile, so its own bound_at, not
  // the epoch clamp, becomes its valid_from — and 0.4s before
  // 'second-of-pair', so the -1s discretisation inverts it: clamped
  // to = (t1 + 400) - 1000 = t1 - 600, which is before its own from = t1.
  // deriveTiling itself is untouched (its continuous [from, to) for
  // 'first-of-pair' is a perfectly ordinary, non-empty [t1, t1+400ms)) — the
  // inversion is purely an artifact of the view's one-second discretisation,
  // which is exactly why this belongs here rather than in ranges.test.ts.
  it('agrees on sub-second binds: the view drops the inverted tile, and this comparison must too', async () => {
    await assertViewMatchesReference('subsecond', [
      { personId: 'earlier-owner', boundAt: at(8).getTime() },
      { personId: 'first-of-pair', boundAt: at(9, 0, 0, 0).getTime() },
      { personId: 'second-of-pair', boundAt: at(9, 0, 0, 400).getTime() },
    ])
  })
})
