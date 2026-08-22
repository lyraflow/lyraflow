import { join } from 'node:path'
import { FUNNEL_DEFINITION_VERSION, type FunnelDefinition } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DuplicateFunnelNameError, FunnelStore, StoredDefinitionError } from './store.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const store = new FunnelStore(pg)
let projectId: number
let otherProjectId: number

const signup: FunnelDefinition = {
  steps: [
    { event: '$page', where: [{ property: 'path', operator: '=', value: '/' }] },
    { event: 'signed_up' },
  ],
  window_seconds: 604800,
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  for (const slug of ['funstore-a', 'funstore-b']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
  const a = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('A', 'funstore-a', 'wk_funstore_a', 'h') RETURNING id`,
  )
  const b = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('B', 'funstore-b', 'wk_funstore_b', 'h') RETURNING id`,
  )
  projectId = Number(a.rows[0]?.id)
  otherProjectId = Number(b.rows[0]?.id)
})

beforeEach(async () => {
  await pg.query('DELETE FROM funnels WHERE project_id = ANY($1)', [[projectId, otherProjectId]])
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [['funstore-a', 'funstore-b']])
  await pg.end()
  await ch.close()
})

/** Any fixed window; `recordRun` requires one (#91) and these tests are about
 *  the counts, not the range. The range's own behaviour is pinned below. */
const RANGE = {
  since: new Date('2026-08-01T00:00:00.000Z'),
  until: new Date('2026-08-08T00:00:00.000Z'),
}

const behaviour = (event: string) => ({
  kind: 'behavior' as const,
  event,
  aggregate: 'count' as const,
  window: { kind: 'last' as const, n: 14, unit: 'days' as const },
  operator: '=' as const,
  value: 1,
})

describe('FunnelStore', () => {
  it('creates and reads back a definition', async () => {
    const created = await store.create(projectId, 'signup', signup)
    const found = await store.get(projectId, created.id)
    expect(found?.steps).toHaveLength(2)
    expect(found?.steps[0]?.where?.[0]?.value).toBe('/')
    expect(found?.windowSeconds).toBe(604800)
    expect(found?.definitionVersion).toBe(FUNNEL_DEFINITION_VERSION)
  })

  it('finds a funnel by name, which is how the CLI addresses one', async () => {
    await store.create(projectId, 'signup', signup)
    expect((await store.getByName(projectId, 'signup'))?.name).toBe('signup')
    expect(await store.getByName(projectId, 'nope')).toBeNull()
  })

  it('rejects a duplicate name within a project', async () => {
    await store.create(projectId, 'signup', signup)
    await expect(store.create(projectId, 'signup', signup)).rejects.toBeInstanceOf(
      DuplicateFunnelNameError,
    )
  })

  it('allows the same name in a different project', async () => {
    await store.create(projectId, 'signup', signup)
    await expect(store.create(otherProjectId, 'signup', signup)).resolves.toBeDefined()
  })

  it('does not return another project’s funnel', async () => {
    const f = await store.create(projectId, 'signup', signup)
    expect(await store.get(otherProjectId, f.id)).toBeNull()
    expect(await store.remove(otherProjectId, f.id)).toBe(false)
  })

  it('clears the snapshot when the steps change', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await store.recordRun(projectId, f.id, {
      entered: 100,
      converted: 10,
      at: new Date(),
      range: RANGE,
    })
    await store.update(projectId, f.id, { steps: [{ event: 'x' }, { event: 'y' }] })
    const after = await store.get(projectId, f.id)
    expect(after?.lastEntered).toBeNull()
    expect(after?.lastConverted).toBeNull()
    expect(after?.lastEvaluatedAt).toBeNull()
  })

  it('clears the snapshot when the window changes', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await store.recordRun(projectId, f.id, {
      entered: 100,
      converted: 10,
      at: new Date(),
      range: RANGE,
    })
    await store.update(projectId, f.id, { windowSeconds: 60 })
    expect((await store.get(projectId, f.id))?.lastEntered).toBeNull()
  })

  it('clears the snapshot when the segment restriction changes', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await store.recordRun(projectId, f.id, {
      entered: 100,
      converted: 10,
      at: new Date(),
      range: RANGE,
    })
    await store.update(projectId, f.id, { segmentId: 42 })
    const after = await store.get(projectId, f.id)
    expect(after?.segmentId).toBe(42)
    expect(after?.lastEntered).toBeNull()
  })

  it('KEEPS the snapshot on a rename', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await store.recordRun(projectId, f.id, {
      entered: 100,
      converted: 10,
      at: new Date(),
      range: RANGE,
    })
    await store.update(projectId, f.id, { name: 'signup-v2' })
    const after = await store.get(projectId, f.id)
    expect(after?.name).toBe('signup-v2')
    expect(after?.lastEntered).toBe(100)
    expect(after?.lastConverted).toBe(10)
    expect(after?.lastEvaluatedAt).not.toBeNull()
  })

  // The web UI sends the whole definition on every save (issue #92): a
  // rename PATCH still carries `steps`/`window_seconds`, and they must not
  // be mistaken for a change just because they were present in the request.
  describe('keeps the snapshot when the definition is unchanged, even if the patch carries it', () => {
    it('rename plus the current steps and window echoed back verbatim', async () => {
      const f = await store.create(projectId, 'signup', signup)
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      await store.update(projectId, f.id, {
        name: 'signup-v2',
        steps: signup.steps,
        windowSeconds: signup.window_seconds,
      })
      const after = await store.get(projectId, f.id)
      expect(after?.name).toBe('signup-v2')
      expect(after?.lastEntered).toBe(100)
      expect(after?.lastConverted).toBe(10)
      expect(after?.lastEvaluatedAt).not.toBeNull()
    })

    it('window_seconds re-sent at its current value', async () => {
      const f = await store.create(projectId, 'signup', signup)
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      await store.update(projectId, f.id, { windowSeconds: signup.window_seconds })
      expect((await store.get(projectId, f.id))?.lastEntered).toBe(100)
    })

    it('segment_id re-sent at its current value', async () => {
      const f = await store.create(projectId, 'signup', { ...signup, segment_id: 42 })
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      await store.update(projectId, f.id, { segmentId: 42 })
      const after = await store.get(projectId, f.id)
      expect(after?.segmentId).toBe(42)
      expect(after?.lastEntered).toBe(100)
    })

    it('segment_id explicitly re-cleared to null when it was already null', async () => {
      const f = await store.create(projectId, 'signup', signup) // segment_id absent → null
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      await store.update(projectId, f.id, { segmentId: null })
      const after = await store.get(projectId, f.id)
      expect(after?.segmentId).toBeNull()
      expect(after?.lastEntered).toBe(100)
    })
  })

  describe('still clears the snapshot for a genuine definition change, echoed-back fields notwithstanding', () => {
    it('a changed event name within a step', async () => {
      const f = await store.create(projectId, 'signup', signup)
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      const changed = structuredClone(signup.steps)
      const secondStep = changed[1]
      if (!secondStep) throw new Error('fixture must have a second step')
      secondStep.event = 'signed_up_v2'
      await store.update(projectId, f.id, { steps: changed })
      expect((await store.get(projectId, f.id))?.lastEntered).toBeNull()
    })

    it('the same steps in a different order', async () => {
      const f = await store.create(projectId, 'signup', signup)
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      const reordered = [...signup.steps].reverse()
      await store.update(projectId, f.id, { steps: reordered })
      expect((await store.get(projectId, f.id))?.lastEntered).toBeNull()
    })

    it('an added where predicate', async () => {
      const f = await store.create(projectId, 'signup', signup)
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      const withExtraPredicate = structuredClone(signup.steps)
      const firstStep = withExtraPredicate[0]
      if (!firstStep) throw new Error('fixture must have a first step')
      firstStep.where = [
        ...(firstStep.where ?? []),
        { property: 'referrer', operator: '=', value: 'x' },
      ]
      await store.update(projectId, f.id, { steps: withExtraPredicate })
      expect((await store.get(projectId, f.id))?.lastEntered).toBeNull()
    })

    it('a removed where predicate', async () => {
      const f = await store.create(projectId, 'signup', signup)
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      const withoutPredicate = structuredClone(signup.steps)
      const firstStep = withoutPredicate[0]
      if (!firstStep) throw new Error('fixture must have a first step')
      firstStep.where = []
      await store.update(projectId, f.id, { steps: withoutPredicate })
      expect((await store.get(projectId, f.id))?.lastEntered).toBeNull()
    })

    it('a genuinely changed window_seconds', async () => {
      const f = await store.create(projectId, 'signup', signup)
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      await store.update(projectId, f.id, { windowSeconds: signup.window_seconds + 1 })
      expect((await store.get(projectId, f.id))?.lastEntered).toBeNull()
    })

    it('segment_id set for the first time', async () => {
      const f = await store.create(projectId, 'signup', signup)
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      await store.update(projectId, f.id, { segmentId: 99 })
      const after = await store.get(projectId, f.id)
      expect(after?.segmentId).toBe(99)
      expect(after?.lastEntered).toBeNull()
    })

    it('segment_id cleared to null having previously been set', async () => {
      const f = await store.create(projectId, 'signup', { ...signup, segment_id: 7 })
      await store.recordRun(projectId, f.id, {
        entered: 100,
        converted: 10,
        at: new Date(),
        range: RANGE,
      })
      await store.update(projectId, f.id, { segmentId: null })
      const after = await store.get(projectId, f.id)
      expect(after?.segmentId).toBeNull()
      expect(after?.lastEntered).toBeNull()
    })
  })

  it('tells a null segment_id apart from an absent one', async () => {
    // undefined leaves the restriction alone; null removes it. Collapsing the
    // two would make "remove the segment" unexpressible through PATCH.
    const f = await store.create(projectId, 'signup', { ...signup, segment_id: 7 })
    await store.update(projectId, f.id, { name: 'renamed' })
    expect((await store.get(projectId, f.id))?.segmentId).toBe(7)
    await store.update(projectId, f.id, { segmentId: null })
    expect((await store.get(projectId, f.id))?.segmentId).toBeNull()
  })

  it('surfaces an unparseable stored definition as stale in list(), not a throw', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await pg.query(`UPDATE funnels SET steps = '[{"nope": true}]'::jsonb WHERE id = $1`, [f.id])
    const listed = await store.list(projectId)
    expect(listed[0]).toMatchObject({ stale: true, steps: null, name: 'signup' })
  })

  it('does not let one bad row take down the rest of the list', async () => {
    const bad = await store.create(projectId, 'aaa-bad', signup)
    await store.create(projectId, 'zzz-good', signup)
    // A valid jsonb array — the CHECK constraint forbids anything else — whose
    // ELEMENTS no longer parse. That is the shape an older build would leave.
    await pg.query(
      `UPDATE funnels SET steps = '[{"evt": "a"}, {"evt": "b"}]'::jsonb WHERE id = $1`,
      [bad.id],
    )
    const listed = await store.list(projectId)
    expect(listed).toHaveLength(2)
    expect(listed[0]).toMatchObject({ name: 'aaa-bad', stale: true })
    expect(listed[1]).toMatchObject({ name: 'zzz-good' })
    expect(listed[1]).not.toHaveProperty('stale')
  })

  it('throws StoredDefinitionError from get() for the same row', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await pg.query(`UPDATE funnels SET steps = '[]'::jsonb WHERE id = $1`, [f.id])
    await expect(store.get(projectId, f.id)).rejects.toBeInstanceOf(StoredDefinitionError)
  })

  it('records a run snapshot', async () => {
    const f = await store.create(projectId, 'signup', signup)
    await store.recordRun(projectId, f.id, {
      entered: 51,
      converted: 7,
      at: new Date(),
      range: RANGE,
    })
    const after = await store.get(projectId, f.id)
    expect(after?.lastEntered).toBe(51)
    expect(after?.lastConverted).toBe(7)
    expect(after?.lastEvaluatedAt).not.toBeNull()
  })

  describe('audience equality', () => {
    it('treats an audience-only edit as a change, so the cached counters are cleared', async () => {
      const created = await store.create(projectId, 'audience-edit', {
        steps: [{ event: 'a' }, { event: 'b' }],
        window_seconds: 3600,
      })
      // Seed the cache the way a run does, so there is something to clear.
      // `RANGE` and this call shape are the file's own -- `recordRun` requires
      // `at` and a range (#91).
      await store.recordRun(projectId, created.id, {
        entered: 10,
        converted: 3,
        at: new Date(),
        range: RANGE,
      })

      await store.update(projectId, created.id, {
        steps: [{ event: 'a' }, { event: 'b', audience: behaviour('docs_search') }],
      })

      const after = await store.get(projectId, created.id)
      // A stored count describes the definition it was computed from. Leaving
      // it after an edit makes the funnels list render a confident number for
      // a funnel that no longer exists.
      expect(after?.lastEntered).toBeNull()
      expect(after?.lastConverted).toBeNull()
      expect(after?.lastEvaluatedAt).toBeNull()
    })

    it('treats a re-save of the same audience as no change', async () => {
      const steps = [{ event: 'a' }, { event: 'b', audience: behaviour('docs_search') }]
      const created = await store.create(projectId, 'audience-resave', {
        steps,
        window_seconds: 3600,
      })
      // `RANGE` and this call shape are the file's own -- `recordRun` requires
      // `at` and a range (#91).
      await store.recordRun(projectId, created.id, {
        entered: 10,
        converted: 3,
        at: new Date(),
        range: RANGE,
      })
      // The UI sends the whole definition on every save, so an unchanged
      // audience arriving again must not be mistaken for an edit.
      await store.update(projectId, created.id, { steps: JSON.parse(JSON.stringify(steps)) })
      const after = await store.get(projectId, created.id)
      expect(after?.lastEntered).toBe(10)
    })

    it('treats an absent `where` and an explicit empty `where` as the same behaviour node', async () => {
      // A behaviour node's `where` is optional, same as a step's own. The UI
      // form and a jsonb round-trip do not promise to agree on omitting it
      // versus sending `[]` -- both mean "no predicates" -- so the two must
      // compare equal here the same way `stepsEqual` already treats a step's
      // `where` below, or an edit that never touched the audience clears the
      // cache anyway.
      const created = await store.create(projectId, 'audience-where-probe', {
        steps: [{ event: 'a' }, { event: 'b', audience: behaviour('docs_search') }],
        window_seconds: 3600,
      })
      await store.recordRun(projectId, created.id, {
        entered: 10,
        converted: 3,
        at: new Date(),
        range: RANGE,
      })
      await store.update(projectId, created.id, {
        steps: [
          { event: 'a' },
          { event: 'b', audience: { ...behaviour('docs_search'), where: [] } },
        ],
      })
      const after = await store.get(projectId, created.id)
      expect(after?.lastEntered).toBe(10)
    })

    it('distinguishes two audiences that differ only deep in the tree', async () => {
      const tree = (n: number) => ({
        kind: 'group' as const,
        op: 'and' as const,
        children: [{ ...behaviour('docs_search'), value: n }],
      })
      const created = await store.create(projectId, 'audience-deep', {
        steps: [{ event: 'a' }, { event: 'b', audience: tree(1) }],
        window_seconds: 3600,
      })
      // `RANGE` and this call shape are the file's own -- `recordRun` requires
      // `at` and a range (#91).
      await store.recordRun(projectId, created.id, {
        entered: 10,
        converted: 3,
        at: new Date(),
        range: RANGE,
      })
      await store.update(projectId, created.id, {
        steps: [{ event: 'a' }, { event: 'b', audience: tree(2) }],
      })
      const after = await store.get(projectId, created.id)
      expect(after?.lastEntered).toBeNull()
    })
  })
})

describe('update stamps definition_version on a real steps change', () => {
  it('bumps a v1 row to the current version once an audience is patched in', async () => {
    const created = await store.create(projectId, 'stamp-version', {
      steps: [{ event: 'a' }, { event: 'b' }],
      window_seconds: 3600,
    })
    // Seed the row the way a pre-branch funnel actually looks: written before
    // step audiences existed, so it still claims version 1.
    await pg.query('UPDATE funnels SET definition_version = 1 WHERE id = $1', [created.id])
    expect((await store.get(projectId, created.id))?.definitionVersion).toBe(1)

    await store.update(projectId, created.id, {
      steps: [{ event: 'a' }, { event: 'b', audience: behaviour('docs_search') }],
    })

    const after = await store.get(projectId, created.id)
    // The row now carries an embedded, separately-versioned FilterNode. A
    // migration scanning `definition_version >= 2` must find it -- which is
    // exactly what this assertion is standing in for.
    expect(after?.definitionVersion).toBe(FUNNEL_DEFINITION_VERSION)
    expect(after?.definitionVersion).toBeGreaterThanOrEqual(2)
  })

  it('leaves the version alone on a patch that never touches steps', async () => {
    const created = await store.create(projectId, 'stamp-version-rename', {
      steps: [{ event: 'a' }, { event: 'b' }],
      window_seconds: 3600,
    })
    await pg.query('UPDATE funnels SET definition_version = 1 WHERE id = $1', [created.id])

    await store.update(projectId, created.id, { name: 'stamp-version-renamed' })

    // A rename did not change what the definition measures, so it must not
    // claim a version the stored tree was never re-parsed against.
    expect((await store.get(projectId, created.id))?.definitionVersion).toBe(1)
  })
})

describe('the cached summary records what it ran over (#91)', () => {
  const OTHER = {
    since: new Date('2026-05-10T00:00:00.000Z'),
    until: new Date('2026-08-08T00:00:00.000Z'),
  }

  it('stores the range the run used, not a default', async () => {
    const f = await store.create(projectId, 'ranged', signup)
    await store.recordRun(projectId, f.id, {
      entered: 90,
      converted: 9,
      at: new Date(),
      range: OTHER,
    })
    const after = await store.get(projectId, f.id)
    expect(after?.lastRange).toEqual({
      since: OTHER.since.toISOString(),
      until: OTHER.until.toISOString(),
    })
  })

  it('reports no range for a funnel that has never run', async () => {
    const f = await store.create(projectId, 'never-run', signup)
    expect((await store.get(projectId, f.id))?.lastRange).toBeNull()
  })

  it('clears the range with the counts when the definition changes', async () => {
    // A stored range describes the definition it was computed from exactly as
    // much as the counts do. Leaving it behind would put a precise-looking
    // window on numbers that no longer exist, which reads MORE authoritative
    // than the bare stale number the clearing already exists to prevent.
    const f = await store.create(projectId, 'edited', signup)
    await store.recordRun(projectId, f.id, {
      entered: 90,
      converted: 9,
      at: new Date(),
      range: OTHER,
    })
    await store.update(projectId, f.id, { steps: [{ event: 'x' }, { event: 'y' }] })
    const after = await store.get(projectId, f.id)
    expect(after?.lastRange).toBeNull()
    expect(after?.lastEntered).toBeNull()
  })

  it('reports NO range when only half of one survives', async () => {
    // "Both or neither" is claimed by the migration and by the API's own type,
    // so it gets a test rather than a comment. Not reachable through the app --
    // the two columns are only ever written together -- but reachable by hand,
    // by a partially applied migration, or by a restore, and the failure mode
    // is the worst kind: a range object with an empty bound renders as a real
    // window computed from a nonsense date rather than as missing data.
    const f = await store.create(projectId, 'half', signup)
    await store.recordRun(projectId, f.id, {
      entered: 90,
      converted: 9,
      at: new Date(),
      range: OTHER,
    })
    await pg.query('UPDATE funnels SET last_range_until = NULL WHERE project_id = $1 AND id = $2', [
      projectId,
      f.id,
    ])
    expect((await store.get(projectId, f.id))?.lastRange).toBeNull()
  })

  it('surfaces the range through list(), which is the screen that needed it', async () => {
    const f = await store.create(projectId, 'listed', signup)
    await store.recordRun(projectId, f.id, {
      entered: 90,
      converted: 9,
      at: new Date(),
      range: OTHER,
    })
    const row = (await store.list(projectId)).find((x) => x.id === f.id)
    expect(row?.lastRange?.since).toBe(OTHER.since.toISOString())
  })
})
