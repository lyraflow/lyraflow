import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
  reserveProjectIdsPastClickHouse,
} from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type PgDictionarySource, ensureIdentityDictionaries } from './dictionaries.js'
import { RESOLVED_PERSON_ALIAS, resolvedPersonExpr } from './resolve.js'

/**
 * The shape-only unit tests for resolvedPersonExpr moved to
 * packages/core/src/identity/resolve.test.ts alongside the implementation in
 * Plan 3. Only the live-service suite stays here: core's tests must not
 * require a database, and these need a real ClickHouse and Postgres.
 *
 * The imports below deliberately still come from './resolve.js' — the
 * re-export left behind for Plan 2's call sites — so this suite also proves
 * that re-export actually resolves.
 */

/**
 * Proves resolvedPersonExpr end to end against the live test stack — the
 * unit tests above only check the expression's *shape* (which dictionary
 * names/columns appear, and in what textual order); none of them evaluate
 * the SQL, so all of them would pass unchanged against an expression that
 * resolves the wrong person, or one with stage 2 quietly deleted.
 *
 * Lives here rather than in packages/db/src/schema-identity.test.ts, as the
 * Task 6 brief sketches, because packages/db does not — and must not —
 * depend on packages/server: TypeScript project references form a DAG
 * (packages/server already references packages/db via tsconfig.json), so a
 * reference back from packages/db to packages/server would be a cycle
 * `tsc -b` rejects outright, and importing across the boundary without a
 * declared reference would leave typecheck unable to resolve the import.
 * packages/server/src/identity/dictionaries.test.ts already establishes the
 * pattern this follows: a live-service describe block, inside the package
 * that owns the module under test, migrating both databases and talking to
 * the real Postgres/ClickHouse test containers.
 */
describe('resolvedPersonExpr (live ClickHouse + Postgres)', () => {
  const CH_DB = 'lyraflow_test'
  const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
  const ch = createChClient({
    url: 'http://localhost:8123',
    username: 'lyraflow',
    password: 'lyraflow',
    database: CH_DB,
  })

  // Resolved by the ClickHouse *server* itself, which runs inside
  // docker-compose.test.yml's own network and reaches Postgres at the
  // service hostname/port — not this test process's host-mapped
  // localhost:5433 (see the identical comment in dictionaries.test.ts).
  const pgSource: PgDictionarySource = {
    host: 'postgres',
    port: 5432,
    user: 'lyraflow',
    password: 'lyraflow',
    database: CH_DB,
  }

  let projectId: number

  beforeAll(async () => {
    // Full wipe, not just migrate(): see the identical comment in
    // schema-identity.test.ts. Required here specifically because
    // 003_identity.sql's identity_bindings_dict_src view was amended in
    // place (the valid_to overlap fix) rather than superseded by a new
    // migration — migrate() only skips versions it has already recorded, so
    // against a test container that ran an earlier version of this suite, a
    // stale `schema_migrations` row for version 3 would leave the
    // pre-amendment (overlapping) view definition in place and this file's
    // own sub-second rebind test would silently pass against a view that
    // was never actually re-created.
    await pg.query('DROP SCHEMA public CASCADE')
    await pg.query('CREATE SCHEMA public')
    await migrate({
      pg,
      ch,
      migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
      appSchemaVersion: 999,
    })
    // Recreating the schema restarts `projects_id_seq` at 1, while ClickHouse
    // still holds rows under the ids the previous suites used. Without this the
    // next project created anywhere in the run is handed a number ClickHouse
    // already answers to -- lyraflow/lyraflow#201. See the helper's own comment.
    await reserveProjectIdsPastClickHouse(pg, ch)
    await pg.query('DELETE FROM projects WHERE slug = $1', ['resolve-expr-test'])
    const r = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('ResolveExpr', 'resolve-expr-test', 'wk_resolve_expr', 'h') RETURNING id`,
    )
    projectId = Number(r.rows[0]?.id)
    await ensureIdentityDictionaries(ch, pgSource)
  })

  afterAll(async () => {
    await pg.query('DELETE FROM identity_bindings WHERE project_id = $1', [projectId])
    await pg.query('DELETE FROM person_aliases WHERE project_id = $1', [projectId])
    await pg.query('DELETE FROM projects WHERE slug = $1', ['resolve-expr-test'])
    // Every query in this suite filters on this file's own fresh project_id,
    // so leaving these rows behind is harmless today — but ClickHouse has no
    // per-file DROP/CASCADE the way Postgres does above, so without this the
    // events table grows by this suite's row count on every run, forever,
    // and would eventually collide with a future test that (unlike this
    // file) filters by event_name alone without a project_id qualifier.
    await ch.command({ query: `ALTER TABLE events DELETE WHERE project_id = ${projectId}` })
    await pg.end()
    await ch.close()
  })

  async function insertEvent(opts: {
    anonymousId: string
    userId?: string
    timestamp: string
    eventName: string
  }): Promise<void> {
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: [
        {
          project_id: projectId,
          event_id: randomUUID(),
          anonymous_id: opts.anonymousId,
          user_id: opts.userId ?? '',
          event_name: opts.eventName,
          timestamp: opts.timestamp,
          received_at: opts.timestamp,
          trusted: 0,
          properties: {},
          properties_num: {},
        },
      ],
    })
  }

  async function bind(anonymousId: string, personId: string, boundAt: string): Promise<void> {
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
       VALUES ($1, $2, $3, $4::timestamptz)`,
      [projectId, anonymousId, personId, boundAt],
    )
  }

  async function alias(personId: string, canonicalId: string): Promise<void> {
    await pg.query(
      'INSERT INTO person_aliases (project_id, person_id, canonical_id) VALUES ($1, $2, $3)',
      [projectId, personId, canonicalId],
    )
  }

  // So the test does not wait on LIFETIME(MIN 5 MAX 15) — see the Task 6
  // brief and dictionaries.test.ts's identical use of SYSTEM RELOAD.
  async function reloadDictionaries(): Promise<void> {
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.person_aliases` })
  }

  async function resolvedFor(eventName: string): Promise<string | undefined> {
    const rs = await ch.query({
      query: `SELECT ${resolvedPersonExpr({ database: CH_DB })} AS ${RESOLVED_PERSON_ALIAS}
              FROM events WHERE project_id = ${projectId} AND event_name = '${eventName}'
              ORDER BY timestamp LIMIT 1`,
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{ person_id: string }>()
    return row?.person_id
  }

  // 1. Retroactive attachment — the product's premise. At this point
  // 'retro-device' has exactly one binding, so — unlike test 2 below — this
  // alone would not distinguish a genuinely range-aware dictionary from a
  // range-blind one that just answers every lookup with its one known
  // person; that distinction is what test 2 (and the sub-second test after
  // it) actually exercises. What this test does catch on its own: building
  // the tiling with valid_from clamped to the bind's own bound_at instead of
  // retroactively to the epoch (identity_bindings_dict_src's NULL-lag case).
  it('resolves an anonymous event from before the bind to the bound person', async () => {
    await insertEvent({
      anonymousId: 'retro-device',
      timestamp: '2026-08-06 09:00:00.000',
      eventName: 'retro_pre_bind',
    })
    await bind('retro-device', 'alice', '2026-08-06 12:00:00+00')
    await reloadDictionaries()

    expect(await resolvedFor('retro_pre_bind')).toBe('alice')
  })

  // 2. No cross-person bleed. Catches: a dictionary keyed only on
  // (project_id, anonymous_id) with no RANGE clause at all, which would
  // answer every lookup with whichever binding ClickHouse happens to keep
  // (typically the latest), handing the pre-rebind event bob's identity
  // instead of alice's; catches a tiling that fails to narrow the first
  // person's valid_to down to the second bind's bound_at.
  it('does not bleed across a rebind: the earlier event keeps the first person, the later event gets the second', async () => {
    await insertEvent({
      anonymousId: 'rebind-device',
      timestamp: '2026-08-06 13:00:00.000',
      eventName: 'rebind_before',
    })
    await insertEvent({
      anonymousId: 'rebind-device',
      timestamp: '2026-08-06 16:00:00.000',
      eventName: 'rebind_after',
    })
    await bind('rebind-device', 'alice', '2026-08-06 12:00:00+00')
    await bind('rebind-device', 'bob', '2026-08-06 15:00:00+00')
    await reloadDictionaries()

    expect(await resolvedFor('rebind_before')).toBe('alice')
    expect(await resolvedFor('rebind_after')).toBe('bob')
  })

  // 2b. The same bleed, at the granularity that actually produces it in
  // production. identity_bindings_dict_src derived valid_to as
  // lead(bound_at) exactly, but ClickHouse's RANGE(MIN ... MAX ...) is
  // inclusive at *both* ends, so the outgoing tile's valid_to and the
  // incoming tile's valid_from land on the identical instant — and with
  // range_lookup_strategy defaulting to 'min', the older (outgoing) tile
  // wins the tie. toDateTime() (see resolve.ts) floors every event to the
  // second, so the window this is wrong for is not one instant but a full
  // second: any event timestamped in [bound_at, bound_at + 1s) resolves to
  // the person being replaced, not the one taking over. This event lands
  // 300ms after bob's bind — comfortably inside that window — and must
  // resolve to bob, not alice.
  it('does not misattribute an event landing within the same second as a rebind', async () => {
    await bind('subsecond-device', 'alice', '2026-08-06 14:00:00+00')
    await bind('subsecond-device', 'bob', '2026-08-06 15:00:00+00')
    await insertEvent({
      anonymousId: 'subsecond-device',
      timestamp: '2026-08-06 15:00:00.300',
      eventName: 'subsecond_after_rebind',
    })
    await reloadDictionaries()

    expect(await resolvedFor('subsecond_after_rebind')).toBe('bob')
  })

  // 3. Stage 2 applies to identified events — the case the original defect
  // missed, and the most important assertion in this file. 'x' never
  // touches identity_bindings at all (stage 1 is short-circuited by a
  // non-empty user_id), so the ONLY way this resolves to 'y' is stage 2
  // running unconditionally over the short-circuited value. Catches:
  // deleting stage 2 outright (resolves to 'x'); catches gating stage 2's
  // dictGetOrDefault call behind the same `user_id == ''` condition that
  // guards stage 1 (also resolves to 'x' — precisely how /v1/alias became a
  // silent no-op the first time this shipped).
  it('resolves an identified event carrying an aliased user_id to the canonical id', async () => {
    await alias('x', 'y')
    await insertEvent({
      anonymousId: 'alias-device',
      userId: 'x',
      timestamp: '2026-08-06 10:00:00.000',
      eventName: 'identified_aliased',
    })
    await reloadDictionaries()

    expect(await resolvedFor('identified_aliased')).toBe('y')
  })

  // 3b. The other production path into stage 2: an anonymous event resolved
  // by stage 1 to a device-bound person who has *since* been aliased away.
  // Every other test in this file exercises stage 2 either through the
  // user_id branch (test 3) or with no alias row present at all (tests 1,
  // 2, 2b, 4) — none of them touch a stage-1 *output* feeding stage 2 as
  // its input. Catches: stage 2's key tuple being built from the row's raw
  // anonymous_id instead of stage 1's resolved value (would resolve to
  // 'device-owner', never consulting the alias at all); the mirror image of
  // test 3's mutation — stage 2 applied only on the *identified* branch and
  // skipped on the device-resolved one (verified empirically: this reverts
  // to 'device-owner' here while leaving test 3 green, exactly as test 3
  // reverting to 'x' while leaving this one green shows the opposite gating
  // — together the pair pins stage 2 to both branches independently, which
  // neither test alone does).
  it('resolves a device-bound person who has since been aliased to the canonical id', async () => {
    await bind('aliased-device-owner', 'device-owner', '2026-08-06 08:00:00+00')
    await alias('device-owner', 'canonical-owner')
    await insertEvent({
      anonymousId: 'aliased-device-owner',
      timestamp: '2026-08-06 09:00:00.000',
      eventName: 'device_resolved_then_aliased',
    })
    await reloadDictionaries()

    expect(await resolvedFor('device_resolved_then_aliased')).toBe('canonical-owner')
  })

  // 4. Fallback. Catches: swapping dictGetOrDefault's default argument for
  // something other than the device's own anonymous_id (an empty string, a
  // NULL passed through, or a crash on a genuine cache miss instead of a
  // graceful default).
  it('falls back to its own anonymous_id when no binding exists for the device', async () => {
    await insertEvent({
      anonymousId: 'unbound-device',
      timestamp: '2026-08-06 10:00:00.000',
      eventName: 'no_binding',
    })
    await reloadDictionaries()

    expect(await resolvedFor('no_binding')).toBe('unbound-device')
  })
})
