import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type PgDictionarySource, ensureIdentityDictionaries } from './dictionaries.js'
import { RESOLVED_PERSON_ALIAS, resolvedPersonExpr } from './resolve.js'

describe('resolvedPersonExpr', () => {
  it('short-circuits on user_id but still applies the alias stage', () => {
    const sql = resolvedPersonExpr()
    expect(sql).toContain("user_id != ''")
    // The stage-1 short-circuit is a valid optimisation, but omitting stage 2
    // was the bug that silently made /v1/alias a no-op for every event
    // carrying the aliased id. A nested `dictGetOrDefault` call for stage 2
    // necessarily WRAPS stage 1 (stage 2 must apply to both the user_id and
    // the device-resolved branches), which means the 'person_aliases'
    // dictionary literal — the outermost call's own first argument — is
    // always written before the nested 'identity_bindings' literal reads,
    // textually, regardless of nesting. Deleting stage 2 entirely removes
    // 'person_aliases' from the string altogether, which sql.indexOf reports
    // as -1 — no longer greater than identity_bindings' (non-negative) index
    // — so this assertion still catches that mutation. Read literally, it
    // additionally asserts that stage 2 is the outermost operation (applies
    // over the whole stage-1 result, not just one branch of it); the leading
    // SQL comment naming both dictionaries in evaluation order exists so a
    // human reading generated SQL (e.g. in ClickHouse's query_log) has the
    // same "stage 1 feeds stage 2" story the docstring gives here.
    expect(sql.indexOf('person_aliases')).toBeGreaterThan(sql.indexOf('identity_bindings'))
  })

  it('qualifies both dictionaries with the database', () => {
    const sql = resolvedPersonExpr({ database: 'lyraflow' })
    expect(sql).toContain("'lyraflow.identity_bindings'")
    expect(sql).toContain("'lyraflow.person_aliases'")
  })

  it('passes the event timestamp as the range key so resolution is time-aware', () => {
    expect(resolvedPersonExpr()).toContain('timestamp')
  })

  it('falls back to the anonymous id when no binding exists', () => {
    expect(resolvedPersonExpr()).toContain('anonymous_id)')
  })

  // Beyond the brief: the `alias` option is part of the documented interface
  // (resolvedPersonExpr(opts?: { database?: string; alias?: string })) but
  // untested by the brief's own Step 1 fixture. Plan 3's segment compiler
  // joins events under a table alias (e.g. `events e`), so every column this
  // expression touches must be qualifiable, not just the dictionary names.
  it('qualifies every column reference with the given table alias', () => {
    const sql = resolvedPersonExpr({ alias: 'e' })
    expect(sql).toContain('e.user_id')
    expect(sql).toContain('e.project_id')
    expect(sql).toContain('e.anonymous_id')
    expect(sql).toContain('e.timestamp')
    // Bare, unqualified column names must not remain — a partial rewrite
    // that qualifies some columns but not others would resolve against the
    // wrong table the moment this expression sits in a multi-table query.
    expect(sql).not.toMatch(/[^.]\buser_id\b/)
    expect(sql).not.toMatch(/[^.]\bproject_id\b/)
    expect(sql).not.toMatch(/[^.]\banonymous_id\b/)
    expect(sql).not.toMatch(/[^.]\btimestamp\b/)
  })

  it('defaults to unqualified columns when no alias is given', () => {
    const sql = resolvedPersonExpr()
    expect(sql).not.toMatch(/\w\.\w*user_id/)
  })

  // This module builds SQL text from caller-supplied values (`database`,
  // `alias`); per the module's own constraints, anything that reaches the
  // SQL must be validated, not interpolated blindly, even though every
  // current caller in this codebase passes a fixed literal. `database` sits
  // inside a *quoted* dictionary-name string literal
  // (`'<database>.identity_bindings'`), so the immediate risk is a caller
  // breaking out of that string with an embedded quote, not a bare
  // identifier-injection into unquoted SQL — validating both the same way
  // (safe-identifier characters only) closes that off without needing two
  // different escaping strategies.
  it('rejects a database name that is not a safe identifier', () => {
    expect(() => resolvedPersonExpr({ database: "lyraflow'; DROP TABLE events; --" })).toThrow(
      /database/i,
    )
  })

  it('rejects a table alias that is not a safe identifier', () => {
    expect(() => resolvedPersonExpr({ alias: 'e; DROP TABLE events; --' })).toThrow(/alias/i)
  })
})

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
    await migrate({
      pg,
      ch,
      migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
      appSchemaVersion: 999,
    })
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

  // 1. Retroactive attachment — the product's premise. Catches: dropping the
  // RANGE(...)/COMPLEX_KEY_RANGE_HASHED lookup for a plain equality dictGet
  // that only matches events at-or-after the bind's own bound_at (which
  // would leave this event resolved to its own anonymous_id instead of the
  // bound person); catches building the tiling with valid_from clamped to
  // bound_at itself instead of retroactively to the epoch.
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
