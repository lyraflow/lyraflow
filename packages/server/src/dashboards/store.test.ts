import { join } from 'node:path'
import { type Pool, createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DashboardStore, DuplicateDashboardNameError, type Tile, Tiles } from './store.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

let projectA: number
let projectB: number
const store = new DashboardStore(pg)

const tile = (report_id: number, width: Tile['width'] = 'half'): Tile => ({
  kind: 'trend',
  report_id,
  width,
})

async function project(slug: string): Promise<number> {
  await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  const r = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $1, $2, $3) RETURNING id`,
    [slug, `wk_${slug}`, `hash_${slug}`],
  )
  return Number(r.rows[0]?.id)
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  projectA = await project('dash-store-a')
  projectB = await project('dash-store-b')
})

beforeEach(async () => {
  await pg.query('DELETE FROM dashboards WHERE project_id = ANY($1)', [[projectA, projectB]])
})

afterAll(async () => {
  await pg.query('DELETE FROM projects WHERE slug = ANY($1)', [['dash-store-a', 'dash-store-b']])
  await pg.end()
  await ch.close()
})

describe('DashboardStore', () => {
  it('round-trips a layout, tiles in order', async () => {
    const made = await store.create(projectA, {
      name: 'Overview',
      tiles: [tile(3), tile(1, 'full')],
    })
    const read = await store.get(projectA, made.id)
    expect(read).toMatchObject({
      name: 'Overview',
      tiles: [tile(3), tile(1, 'full')],
      is_home: false,
      definition_version: 1,
      stale: false,
    })
  })

  it('refuses a duplicate name in one project, and allows it across two', async () => {
    await store.create(projectA, { name: 'Same', tiles: [] })
    await expect(store.create(projectA, { name: 'Same', tiles: [] })).rejects.toBeInstanceOf(
      DuplicateDashboardNameError,
    )
    await expect(store.create(projectB, { name: 'Same', tiles: [] })).resolves.toMatchObject({
      name: 'Same',
    })
  })

  it('refuses a rename onto an existing name', async () => {
    await store.create(projectA, { name: 'One', tiles: [] })
    const two = await store.create(projectA, { name: 'Two', tiles: [] })
    await expect(store.update(projectA, two.id, { name: 'One' })).rejects.toBeInstanceOf(
      DuplicateDashboardNameError,
    )
  })

  it('scopes get, update and remove to the project', async () => {
    const made = await store.create(projectA, { name: 'Mine', tiles: [] })
    expect(await store.get(projectB, made.id)).toBeNull()
    expect(await store.update(projectB, made.id, { name: 'Theirs' })).toBeNull()
    expect(await store.remove(projectB, made.id)).toBe(false)
    expect((await store.get(projectA, made.id))?.name).toBe('Mine')
  })

  it('replaces the whole layout on a tiles patch and re-stamps the version', async () => {
    const made = await store.create(projectA, { name: 'L', tiles: [tile(1), tile(2)] })
    await pg.query('UPDATE dashboards SET definition_version = 0 WHERE id = $1', [made.id])
    const updated = await store.update(projectA, made.id, { tiles: [tile(2, 'full')] })
    expect(updated?.tiles).toEqual([tile(2, 'full')])
    expect(updated?.definition_version).toBe(1)
  })

  it('a rename alone leaves the version alone', async () => {
    const made = await store.create(projectA, { name: 'R', tiles: [tile(1)] })
    await pg.query('UPDATE dashboards SET definition_version = 0 WHERE id = $1', [made.id])
    const updated = await store.update(projectA, made.id, { name: 'R2' })
    expect(updated?.definition_version).toBe(0)
    expect(updated?.tiles).toEqual([tile(1)])
  })

  it('setting home moves it: the previous home is cleared in the same transaction', async () => {
    const a = await store.create(projectA, { name: 'A', tiles: [] })
    const b = await store.create(projectA, { name: 'B', tiles: [] })
    await store.update(projectA, a.id, { is_home: true })
    await store.update(projectA, b.id, { is_home: true })
    const list = await store.list(projectA)
    expect(list.filter((d) => d.is_home).map((d) => d.name)).toEqual(['B'])
  })

  it('two concurrent set-home patches end with exactly one home', async () => {
    const a = await store.create(projectA, { name: 'A', tiles: [] })
    const b = await store.create(projectA, { name: 'B', tiles: [] })
    await Promise.all([
      store.update(projectA, a.id, { is_home: true }),
      store.update(projectA, b.id, { is_home: true }),
    ])
    const list = await store.list(projectA)
    expect(list.filter((d) => d.is_home)).toHaveLength(1)
  })

  it('home is per project: two projects each keep their own', async () => {
    const a = await store.create(projectA, { name: 'A', tiles: [] })
    const b = await store.create(projectB, { name: 'B', tiles: [] })
    await store.update(projectA, a.id, { is_home: true })
    await store.update(projectB, b.id, { is_home: true })
    expect((await store.get(projectA, a.id))?.is_home).toBe(true)
    expect((await store.get(projectB, b.id))?.is_home).toBe(true)
  })

  it('is_home: false clears it, and deleting the home leaves none', async () => {
    const a = await store.create(projectA, { name: 'A', tiles: [] })
    await store.update(projectA, a.id, { is_home: true })
    await store.update(projectA, a.id, { is_home: false })
    expect((await store.get(projectA, a.id))?.is_home).toBe(false)
    await store.update(projectA, a.id, { is_home: true })
    await store.remove(projectA, a.id)
    expect((await store.list(projectA)).some((d) => d.is_home)).toBe(false)
  })

  // I1 from the Task 4 review: `#setHome` clears the caller's current home
  // BEFORE it knows the target row exists, because setting the new home
  // first would collide with itself on `dashboards_one_home_per_project`.
  // A `null` result -- another project's id, or no such id at all -- must
  // therefore roll the clear back rather than commit it: a 404 must not
  // silently move the caller's home.
  it("is_home: true on another project's id returns null and leaves the caller's home alone", async () => {
    const home = await store.create(projectA, { name: 'Home', tiles: [] })
    await store.update(projectA, home.id, { is_home: true })
    const theirs = await store.create(projectB, { name: 'Theirs', tiles: [] })

    expect(await store.update(projectA, theirs.id, { is_home: true })).toBeNull()

    expect((await store.get(projectA, home.id))?.is_home).toBe(true)
    expect((await store.get(projectB, theirs.id))?.is_home).toBe(false)
  })

  it("is_home: true on a nonexistent id returns null and leaves the caller's home alone", async () => {
    const home = await store.create(projectA, { name: 'Home', tiles: [] })
    await store.update(projectA, home.id, { is_home: true })

    expect(await store.update(projectA, home.id + 999_999, { is_home: true })).toBeNull()

    expect((await store.get(projectA, home.id))?.is_home).toBe(true)
  })

  it('a row whose tiles no longer parse reads back stale, with no tiles, and does not fail the list', async () => {
    await pg.query(
      `INSERT INTO dashboards (project_id, name, definition_version, tiles)
       VALUES ($1, 'Broken', 1, '[{"kind":"pie","report_id":1,"width":"half"}]'::jsonb)`,
      [projectA],
    )
    await store.create(projectA, { name: 'Fine', tiles: [tile(1)] })
    const list = await store.list(projectA)
    expect(list.find((d) => d.name === 'Broken')).toMatchObject({ stale: true, tiles: [] })
    expect(list.find((d) => d.name === 'Fine')).toMatchObject({ stale: false })
  })

  it('definition_version is a column, queryable without parsing tiles', async () => {
    const made = await store.create(projectA, { name: 'V', tiles: [tile(1)] })
    const r = await pg.query<{ definition_version: number }>(
      'SELECT definition_version FROM dashboards WHERE id = $1',
      [made.id],
    )
    expect(r.rows[0]?.definition_version).toBe(1)
  })

  describe('sharing', () => {
    it('share mints a 43-character base64url token once, and returns the same one again', async () => {
      const d = await store.create(projectA, { name: 'shareable', tiles: [] })
      const first = await store.share(projectA, d.id)
      expect(first?.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(Number.isNaN(new Date(first?.shared_at as never).getTime())).toBe(false)
      const second = await store.share(projectA, d.id)
      expect(second).toEqual(first)
      const read = await store.get(projectA, d.id)
      expect(read?.shared).toBe(true)
      expect(read?.share).toEqual(first)
    })

    it('share is null for an id in another project', async () => {
      const d = await store.create(projectA, { name: 'mine', tiles: [] })
      expect(await store.share(projectB, d.id)).toBeNull()
      expect((await store.get(projectA, d.id))?.share).toBeNull()
    })

    it('unshare is not_found for an id in another project, and leaves it shared', async () => {
      const d = await store.create(projectA, { name: 'theirs', tiles: [] })
      await store.share(projectA, d.id)
      expect(await store.unshare(projectB, d.id)).toBe('not_found')
      expect((await store.get(projectA, d.id))?.share).not.toBeNull()
    })

    it('unshare clears both columns and reports what it found', async () => {
      const d = await store.create(projectA, { name: 'revocable', tiles: [] })
      expect(await store.unshare(projectA, d.id)).toBe('not_shared')
      await store.share(projectA, d.id)
      expect(await store.unshare(projectA, d.id)).toBe('revoked')
      const row = await pg.query('SELECT share_token, shared_at FROM dashboards WHERE id = $1', [
        d.id,
      ])
      expect(row.rows[0]).toEqual({ share_token: null, shared_at: null })
      expect(await store.unshare(projectA, 999_999)).toBe('not_found')
    })

    it('share after unshare mints a different token', async () => {
      const d = await store.create(projectA, { name: 'rotated', tiles: [] })
      const a = await store.share(projectA, d.id)
      await store.unshare(projectA, d.id)
      const b = await store.share(projectA, d.id)
      expect(b?.token).not.toBe(a?.token)
    })

    it('byShareToken resolves the row and its project, and nothing for a revoked or unknown token', async () => {
      const d = await store.create(projectA, { name: 'lookup', tiles: [] })
      const s = await store.share(projectA, d.id)
      if (!s) throw new Error('unreachable')
      const found = await store.byShareToken(s.token)
      expect(found?.projectId).toBe(projectA)
      expect(found?.dashboard.id).toBe(d.id)
      expect(found?.dashboard.share).toEqual(s)
      expect(await store.byShareToken('A'.repeat(43))).toBeNull()
      await store.unshare(projectA, d.id)
      expect(await store.byShareToken(s.token)).toBeNull()
    })

    it('list says shared and never carries the token', async () => {
      const d = await store.create(projectA, { name: 'listed', tiles: [] })
      await store.share(projectA, d.id)
      const rows = await store.list(projectA)
      const row = rows.find((r) => r.id === d.id)
      expect(row?.shared).toBe(true)
      expect(row?.share).toBeNull()
      expect(JSON.stringify(rows)).not.toContain('share_token')
    })
  })
})

/**
 * `#setHome`'s failure paths, tested against a fake pool/client rather than
 * real Postgres -- same split as `PersonAliases.alias`'s retry loop
 * (`packages/server/src/identity/aliases.test.ts`) and
 * `ProjectDeletionStore.request`'s rollback-failure test
 * (`packages/server/src/privacy/deletion-store.test.ts`): the real
 * database proves the transaction WORKS (the "setting home moves it" and
 * "two concurrent" tests above), but reproducing a genuine second
 * concurrent 23505 collision, or a broken connection whose ROLLBACK itself
 * fails, deterministically from a test is not practical against a live
 * server. A fake client whose `query` is scripted to fail on a chosen
 * statement pins `#setHome`'s own control flow -- which errors retry, how
 * many times, what reaches `client.release()` -- independent of winning a
 * race.
 *
 * `dashboards_project_id_name_key` and `dashboards_one_home_per_project`
 * are the real names confirmed against `pg_constraint`/`pg_indexes` on the
 * test database, not guessed.
 */

function fakeError(
  code: string,
  constraint?: string,
): Error & { code: string; constraint?: string } {
  return Object.assign(new Error(`SQLSTATE ${code}`), { code, constraint })
}

const SUCCESS_ROW = {
  id: '1',
  name: 'B',
  tiles: [],
  is_home: true,
  definition_version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

/**
 * A fake `Pool` whose one `connect()` hands back one fake client, scripted
 * around `#setHome`'s exact statement sequence: BEGIN, the clear ("SET
 * is_home = false"), the set (`#updateRow`'s UPDATE, matched on a
 * substring unique to it), COMMIT, ROLLBACK. `setFailures[n]` is thrown by
 * the (n+1)th "set" call; a call past the end of the array succeeds.
 */
function fakeHomeClient(opts: { setFailures: Array<Error | null>; rollbackError?: Error }) {
  const calls = { begin: 0, clear: 0, set: 0, commit: 0, rollback: 0 }
  let setCallIndex = 0
  const releaseCalls: unknown[] = []
  const client = {
    query: async (text: string) => {
      if (text === 'BEGIN') {
        calls.begin++
        return { rows: [] }
      }
      if (text.includes('is_home = false')) {
        calls.clear++
        return { rows: [], rowCount: 0 }
      }
      if (text.includes('COALESCE($3, name)')) {
        calls.set++
        const failure = opts.setFailures[setCallIndex++]
        if (failure) throw failure
        return { rows: [SUCCESS_ROW] }
      }
      if (text === 'COMMIT') {
        calls.commit++
        return { rows: [] }
      }
      if (text === 'ROLLBACK') {
        calls.rollback++
        if (opts.rollbackError) throw opts.rollbackError
        return { rows: [] }
      }
      throw new Error(`unexpected query in fake client: ${text}`)
    },
    release: (err?: unknown) => {
      releaseCalls.push(err)
    },
  }
  const pool = { connect: async () => client } as unknown as Pool
  return { pool, calls, releaseCalls }
}

describe('Tiles', () => {
  it('a report is on a dashboard at most once, keyed by kind AND id', () => {
    // `2` names a trend and a funnel at once -- ids are per table -- so the
    // key is the pair, or a trend would block the funnel that shares its id.
    const trend2 = { kind: 'trend', report_id: 2, width: 'half' } as const
    const funnel2 = { kind: 'funnel', report_id: 2, width: 'half' } as const
    expect(Tiles.safeParse([trend2, funnel2]).success).toBe(true)

    const twice = Tiles.safeParse([trend2, funnel2, { ...trend2, width: 'full' }])
    expect(twice.success).toBe(false)
    if (twice.success) throw new Error('unreachable')
    expect(twice.error.issues.map((i) => i.path)).toEqual([[2]])
  })
})

describe('DashboardStore#setHome failure paths (fake pool/client)', () => {
  it('retries exactly once on a partial-index violation, and the second attempt wins', async () => {
    const { pool, calls } = fakeHomeClient({
      setFailures: [fakeError('23505', 'dashboards_one_home_per_project'), null],
    })
    const store = new DashboardStore(pool)
    const result = await store.update(1, 1, { is_home: true })
    expect(result).toMatchObject({ id: 1, name: 'B', is_home: true })
    expect(calls.clear).toBe(2)
    expect(calls.set).toBe(2)
    expect(calls.begin).toBe(2)
    expect(calls.commit).toBe(1)
  })

  it('a second partial-index violation propagates raw, not as DuplicateDashboardNameError', async () => {
    const { pool, calls } = fakeHomeClient({
      setFailures: [
        fakeError('23505', 'dashboards_one_home_per_project'),
        fakeError('23505', 'dashboards_one_home_per_project'),
      ],
    })
    const store = new DashboardStore(pool)
    let caught: unknown
    try {
      await store.update(1, 1, { is_home: true })
    } catch (err) {
      caught = err
    }
    expect(caught).not.toBeInstanceOf(DuplicateDashboardNameError)
    expect((caught as { code?: string } | undefined)?.code).toBe('23505')
    expect(calls.begin).toBe(2)
    expect(calls.set).toBe(2)
    expect(calls.commit).toBe(0)
  })

  it('a name violation inside the transaction propagates as DuplicateDashboardNameError, with no retry', async () => {
    const { pool, calls } = fakeHomeClient({
      setFailures: [fakeError('23505', 'dashboards_project_id_name_key')],
    })
    const store = new DashboardStore(pool)
    await expect(store.update(1, 1, { is_home: true, name: 'Taken' })).rejects.toBeInstanceOf(
      DuplicateDashboardNameError,
    )
    expect(calls.begin).toBe(1)
    expect(calls.set).toBe(1)
  })

  it('destroys the connection, not recycling it, when ROLLBACK itself fails, and surfaces the original error', async () => {
    const { pool, calls, releaseCalls } = fakeHomeClient({
      setFailures: [new Error('deliberate set failure')],
      rollbackError: new Error('deliberate rollback failure'),
    })
    const store = new DashboardStore(pool)
    await expect(store.update(1, 1, { is_home: true })).rejects.toThrow('deliberate set failure')
    // Not a home-index violation, so no retry -- one attempt only.
    expect(calls.begin).toBe(1)
    expect(releaseCalls).toHaveLength(1)
    expect(releaseCalls[0]).toBeInstanceOf(Error)
    expect((releaseCalls[0] as Error).message).toBe('deliberate rollback failure')
  })

  it('releases the connection with no error argument on success', async () => {
    const { pool, releaseCalls } = fakeHomeClient({ setFailures: [null] })
    const store = new DashboardStore(pool)
    await store.update(1, 1, { is_home: true })
    expect(releaseCalls).toHaveLength(1)
    expect(releaseCalls[0]).toBeUndefined()
  })
})
