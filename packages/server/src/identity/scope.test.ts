import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PersonAliases } from './aliases.js'
import { IdentityBindings } from './bindings.js'
import {
  MAX_PERSON_RANGE_CLAUSES,
  type PersonScope,
  personEventsPredicate,
  resolvePersonScope,
} from './scope.js'

describe('personEventsPredicate', () => {
  // No windows at all — the state a person with no bound devices resolves
  // to. The device branch must be absent entirely, not present-and-empty:
  // an accidental `OR (user_id = '' AND ())` would be invalid SQL, or worse,
  // silently match everything if a clause-joining bug ever emitted `OR ()`.
  it('emits only the identity-group clause when there are no windows', () => {
    const scope: Pick<PersonScope, 'group' | 'windows'> = { group: ['alice'], windows: [] }
    const params: Record<string, unknown> = {}
    const sql = personEventsPredicate(scope, params)
    expect(sql).toBe('(user_id IN {group:Array(String)})')
    expect(params).toEqual({ group: ['alice'] })
  })

  it('adds a bounded device clause for a finite window', () => {
    const scope: Pick<PersonScope, 'group' | 'windows'> = {
      group: ['alice'],
      windows: [{ device: 'd1', from: 1_000, to: 2_000 }],
    }
    const params: Record<string, unknown> = {}
    const sql = personEventsPredicate(scope, params)
    expect(sql).toBe(
      "(user_id IN {group:Array(String)} OR (user_id = '' AND " +
        '((anonymous_id = {d0:String} AND timestamp >= {f0:DateTime64(3)} AND timestamp < {t0:DateTime64(3)}))))',
    )
    expect(params.d0).toBe('d1')
    expect(params.f0).toBe('1970-01-01 00:00:01.000')
    expect(params.t0).toBe('1970-01-01 00:00:02.000')
  })

  // The defect this guards cost a full plan to find (task-4-brief.md): an
  // infinite bound must OMIT its half of the range clause, not be clamped to
  // some representable date. `new Date(Infinity)` is an Invalid Date, and
  // chDateTime throws formatting it — so a regression here fails loudly
  // rather than silently narrowing a window.
  it('omits the lower bound clause for -Infinity and the upper for +Infinity, without throwing', () => {
    const scope: Pick<PersonScope, 'group' | 'windows'> = {
      group: ['alice'],
      windows: [{ device: 'd1', from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY }],
    }
    const params: Record<string, unknown> = {}
    expect(() => personEventsPredicate(scope, params)).not.toThrow()
    const sql = personEventsPredicate(scope, params)
    expect(sql).toBe(
      "(user_id IN {group:Array(String)} OR (user_id = '' AND ((anonymous_id = {d0:String}))))",
    )
    expect(params.f0).toBeUndefined()
    expect(params.t0).toBeUndefined()
  })

  // The purge worker's whole reason to take a `prefix`: two predicates for
  // two different scopes (two chunks of one person, or two people in the
  // same batch) sharing a single params object must not clobber each other's
  // bound values.
  it('namespaces every bound value with prefix, so two predicates can share one params object', () => {
    const scopeA: Pick<PersonScope, 'group' | 'windows'> = {
      group: ['alice'],
      windows: [{ device: 'd1', from: 0, to: 1_000 }],
    }
    const scopeB: Pick<PersonScope, 'group' | 'windows'> = {
      group: ['bob'],
      windows: [{ device: 'd2', from: 0, to: 2_000 }],
    }
    const params: Record<string, unknown> = {}
    const sqlA = personEventsPredicate(scopeA, params, 'a_')
    const sqlB = personEventsPredicate(scopeB, params, 'b_')

    expect(sqlA).toContain('{a_group:Array(String)}')
    expect(sqlB).toContain('{b_group:Array(String)}')
    expect(params).toEqual({
      a_group: ['alice'],
      a_d0: 'd1',
      a_f0: '1970-01-01 00:00:00.000',
      a_t0: '1970-01-01 00:00:01.000',
      b_group: ['bob'],
      b_d0: 'd2',
      b_f0: '1970-01-01 00:00:00.000',
      b_t0: '1970-01-01 00:00:02.000',
    })
  })
})

describe('resolvePersonScope', () => {
  const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
  const ch = createChClient({
    url: 'http://localhost:8123',
    username: 'lyraflow',
    password: 'lyraflow',
    database: 'lyraflow_test',
  })
  let projectId: number
  let bindings: IdentityBindings
  let aliases: PersonAliases

  beforeAll(async () => {
    // Additive-only migrate, not a wipe: this file runs standalone as well as
    // alongside the rest of the suite. Same pattern as bindings.test.ts.
    await migrate({
      pg,
      ch,
      migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
      appSchemaVersion: 999,
    })
    await pg.query('DELETE FROM projects WHERE slug = $1', ['scope-test'])
    const r = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('Scope', 'scope-test', 'wk_scope', 'h') RETURNING id`,
    )
    projectId = Number(r.rows[0]?.id)
  })

  beforeEach(async () => {
    await pg.query('DELETE FROM identity_bindings WHERE project_id = $1', [projectId])
    await pg.query('DELETE FROM person_aliases WHERE project_id = $1', [projectId])
    bindings = new IdentityBindings(pg)
    aliases = new PersonAliases(pg)
  })

  afterAll(async () => {
    await pg.query('DELETE FROM identity_bindings WHERE project_id = $1', [projectId])
    await pg.query('DELETE FROM person_aliases WHERE project_id = $1', [projectId])
    await pg.query('DELETE FROM projects WHERE slug = $1', ['scope-test'])
    await pg.end()
    await ch.close()
  })

  const at = (h: number) => new Date(Date.UTC(2026, 7, 6, h))

  it("resolves a canonical's own group, devices, deduped ids, and windows", async () => {
    await bindings.bind(projectId, 'device-1', 'alice', at(10))

    const scope = await resolvePersonScope({ bindings, aliases }, projectId, 'alice')

    expect(scope.canonical).toBe('alice')
    expect(scope.group).toEqual(['alice'])
    expect(scope.devices).toEqual(['device-1'])
    expect(scope.ids).toEqual(['alice', 'device-1'])
    expect(scope.windows).toEqual([
      { device: 'device-1', from: Number.NEGATIVE_INFINITY, to: Number.POSITIVE_INFINITY },
    ])
  })

  // Step 2 of the resolution: an id merged away must still contribute its
  // own devices to the surviving canonical's scope.
  it("includes a merged-away id's devices in the surviving canonical's group", async () => {
    await bindings.bind(projectId, 'old-device', 'old-alice', at(10))
    await aliases.alias(projectId, 'old-alice', 'new-alice')

    const scope = await resolvePersonScope({ bindings, aliases }, projectId, 'new-alice')

    expect(scope.canonical).toBe('new-alice')
    expect(scope.group.sort()).toEqual(['new-alice', 'old-alice'])
    expect(scope.devices).toEqual(['old-device'])
  })

  // Step 4: a bare device id with nothing of its own identifying it as a
  // person resolves through the device's most recent binding.
  it('falls back to resolving a device id through its most recent binding', async () => {
    await bindings.bind(projectId, 'shared-device', 'first-owner', at(9))
    await bindings.bind(projectId, 'shared-device', 'second-owner', at(10))

    const scope = await resolvePersonScope({ bindings, aliases }, projectId, 'shared-device')

    expect(scope.canonical).toBe('second-owner')
    expect(scope.ids.sort()).toEqual(['second-owner', 'shared-device'])
  })

  // An id nothing has ever identified resolves to itself, with no devices
  // and no windows — the shape person.ts's 404 rests on.
  it('resolves an entirely unknown id to itself, with no devices and no windows', async () => {
    const scope = await resolvePersonScope({ bindings, aliases }, projectId, 'nobody')

    expect(scope.canonical).toBe('nobody')
    expect(scope.group).toEqual(['nobody'])
    expect(scope.devices).toEqual([])
    expect(scope.ids).toEqual(['nobody'])
    expect(scope.windows).toEqual([])
  })

  // One device rebound to the SAME person many times coalesces to one
  // window rather than one per bind — MAX_PERSON_RANGE_CLAUSES exists to
  // reject genuine fragmentation, not routine repeat identify() calls.
  it('coalesces contiguous same-person rebinds on one device into a single window', async () => {
    const bindCount = MAX_PERSON_RANGE_CLAUSES + 5
    const timestamps = Array.from(
      { length: bindCount },
      (_, i) => new Date(Date.UTC(2026, 7, 6, 0, i)),
    )
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
       SELECT $1, 'repeat-device', 'repeat-person', t::timestamptz
       FROM unnest($2::timestamptz[]) AS t`,
      [projectId, timestamps],
    )

    const scope = await resolvePersonScope({ bindings, aliases }, projectId, 'repeat-person')

    expect(scope.windows).toHaveLength(1)
    expect(scope.windows[0]?.device).toBe('repeat-device')
  })
})
