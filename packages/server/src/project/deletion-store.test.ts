import { join } from 'node:path'
import { type Pool, createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ProjectDeletionStore } from './deletion-store.js'
import { ProjectPurgeWorker } from './worker.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const store = new ProjectDeletionStore(pg)

// A prefix no other suite uses, so cleanup here can never touch another
// file's rows even though they share a live database.
const PREFIX = 'projdelstore'
let counter = 0

/**
 * Raw INSERT rather than `@lyraflow/core`'s `createProject`: that helper
 * derives the slug from `name` via `slugify`, and every test below calls
 * this with the same name ('Acme') -- `slug` is UNIQUE, so a shared slug
 * would collide across tests. `write_key` and `server_key_hash` need no
 * real key material here; nothing under test reads them.
 */
async function createProject(
  db: Pool,
  name: string,
): Promise<{ id: number; slug: string; name: string }> {
  const slug = `${PREFIX}-${Date.now()}-${counter++}`
  const r = await db.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [name, slug, `wk_${slug}`, `sk_${slug}`],
  )
  return { id: Number(r.rows[0]?.id), slug, name }
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  // Cleaned up here too, not only in afterEach: a run that died mid-suite
  // would otherwise leave rows from a previous attempt for the next run's
  // first claim() test to collide with (see the afterEach comment below for
  // why claim() makes this whole table fair game).
  await pg.query('DELETE FROM project_deletions')
  await pg.query(`DELETE FROM projects WHERE slug LIKE '${PREFIX}-%'`)
})

// `claim()` is deliberately NOT scoped to a project -- it is a global "next
// thing to do" query (see ProjectDeletionStore.claim). Wiping the whole
// table after every test, not just this file's own rows, is what keeps the
// claim tests deterministic. Safe only because vitest.config.ts sets
// `fileParallelism: false`.
afterEach(async () => {
  await pg.query('DELETE FROM project_deletions')
  await pg.query(`DELETE FROM projects WHERE slug LIKE '${PREFIX}-%'`)
})

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('ProjectDeletionStore', () => {
  it('stamps deleting_at and inserts the queue row in one transaction', async () => {
    const project = await createProject(pg, 'Acme')
    const result = await store.request(project.id)
    expect(result).toEqual({ id: expect.any(Number) })

    const row = await pg.query('SELECT deleting_at FROM projects WHERE id = $1', [project.id])
    expect(row.rows[0].deleting_at).toBeInstanceOf(Date)

    const req = await store.get((result as { id: number }).id)
    expect(req).toMatchObject({ projectId: project.id, slug: project.slug, name: 'Acme' })
  })

  it('refuses a second request and reports the first', async () => {
    const project = await createProject(pg, 'Acme')
    const first = (await store.request(project.id)) as { id: number }
    expect(await store.request(project.id)).toEqual({ alreadyDeleting: first.id })
    const rows = await pg.query('SELECT count(*) FROM project_deletions WHERE project_id = $1', [
      project.id,
    ])
    expect(Number(rows.rows[0].count)).toBe(1)
  })

  it('answers not_found for an unknown project without inserting anything', async () => {
    expect(await store.request(999_999)).toBe('not_found')
    const rows = await pg.query('SELECT count(*) FROM project_deletions')
    expect(Number(rows.rows[0].count)).toBe(0)
  })

  it('claims one request under a lease and increments attempts', async () => {
    const project = await createProject(pg, 'Acme')
    await store.request(project.id)
    const claimed = await store.claim({ leaseMs: 60_000, maxAttempts: 5, claimDelayMs: 0 })
    expect(claimed?.attempts).toBe(1)
    // A second claim inside the lease window finds nothing.
    expect(await store.claim({ leaseMs: 60_000, maxAttempts: 5, claimDelayMs: 0 })).toBeNull()
  })

  it('re-claims a request whose lease has expired', async () => {
    const project = await createProject(pg, 'Acme')
    await store.request(project.id)
    await store.claim({ leaseMs: 60_000, maxAttempts: 5, claimDelayMs: 0 })
    await pg.query(
      "UPDATE project_deletions SET claimed_at = now() - interval '2 hours' WHERE project_id = $1",
      [project.id],
    )
    const again = await store.claim({ leaseMs: 60_000, maxAttempts: 5, claimDelayMs: 0 })
    expect(again?.attempts).toBe(2)
  })

  it('stops handing out a request past maxAttempts', async () => {
    const project = await createProject(pg, 'Acme')
    await store.request(project.id)
    await pg.query(
      'UPDATE project_deletions SET attempts = 5, claimed_at = NULL WHERE project_id = $1',
      [project.id],
    )
    expect(await store.claim({ leaseMs: 60_000, maxAttempts: 5, claimDelayMs: 0 })).toBeNull()
  })

  describe('claimById', () => {
    it('claims the named request and increments attempts', async () => {
      const project = await createProject(pg, 'Acme')
      const { id } = (await store.request(project.id)) as { id: number }
      const claimed = await store.claimById(id, {
        leaseMs: 60_000,
        maxAttempts: 5,
        claimDelayMs: 0,
      })
      expect(claimed?.id).toBe(id)
      expect(claimed?.attempts).toBe(1)
    })

    it('returns null when the named request is already claimed inside the lease', async () => {
      const project = await createProject(pg, 'Acme')
      const { id } = (await store.request(project.id)) as { id: number }
      await store.claimById(id, { leaseMs: 60_000, maxAttempts: 5, claimDelayMs: 0 })
      expect(
        await store.claimById(id, { leaseMs: 60_000, maxAttempts: 5, claimDelayMs: 0 }),
      ).toBeNull()
    })

    it('returns null for the named request past maxAttempts', async () => {
      const project = await createProject(pg, 'Acme')
      const { id } = (await store.request(project.id)) as { id: number }
      await pg.query('UPDATE project_deletions SET attempts = 5, claimed_at = NULL WHERE id = $1', [
        id,
      ])
      expect(
        await store.claimById(id, { leaseMs: 60_000, maxAttempts: 5, claimDelayMs: 0 }),
      ).toBeNull()
    })

    // THE PIN: an older, unrelated, perfectly claimable request must never
    // be the one this returns -- that gap is what let `projects delete`
    // (the CLI) complete a request it never filed while purging a
    // different project's data. `claim()`'s own `ORDER BY requested_at`
    // would hand back `older` here; `claimById` must not.
    it('claims only the named request, never an older pending request from another project', async () => {
      const older = await createProject(pg, 'Older')
      const olderReq = (await store.request(older.id)) as { id: number }
      // Backdate it so it is provably the oldest claimable row in the table.
      await pg.query(
        "UPDATE project_deletions SET requested_at = now() - interval '1 hour' WHERE id = $1",
        [olderReq.id],
      )

      const target = await createProject(pg, 'Target')
      const targetReq = (await store.request(target.id)) as { id: number }

      const claimed = await store.claimById(targetReq.id, {
        leaseMs: 60_000,
        maxAttempts: 5,
        claimDelayMs: 0,
      })
      expect(claimed?.id).toBe(targetReq.id)
      expect(claimed?.projectId).toBe(target.id)

      const untouched = await store.get(olderReq.id)
      expect(untouched).toMatchObject({ claimedAt: null, attempts: 0, completedAt: null })
    })
  })

  /**
   * The cache horizon, pinned on both claim statements SEPARATELY — removing
   * the `requested_at` predicate from one of them must fail exactly the test
   * named for it. That separation is the point: `claim()` is what the
   * server's worker calls and `claimById()` is what `lyraflow projects
   * delete` calls, so a guard present in only one of them is a guard the
   * other path does not have.
   *
   * Age is simulated by backdating `requested_at` rather than by sleeping:
   * the predicate compares two Postgres timestamps, so an older row is
   * indistinguishable from a row that waited.
   *
   * Every other test in this file passes `claimDelayMs: 0` — they are about
   * the lease, the attempt count and the id scoping, and opting out of the
   * horizon keeps them fast and keeps this block the only place the horizon
   * itself is asserted.
   */
  describe('the ingest cache horizon', () => {
    const DELAY_MS = 60_000

    it('refuses a request younger than the delay, and hands it over once it is older', async () => {
      const project = await createProject(pg, 'Acme')
      await store.request(project.id)

      expect(
        await store.claim({ leaseMs: 60_000, maxAttempts: 5, claimDelayMs: DELAY_MS }),
      ).toBeNull()

      await pg.query(
        "UPDATE project_deletions SET requested_at = now() - interval '2 minutes' WHERE project_id = $1",
        [project.id],
      )
      const claimed = await store.claim({
        leaseMs: 60_000,
        maxAttempts: 5,
        claimDelayMs: DELAY_MS,
      })
      expect(claimed?.projectId).toBe(project.id)
    })

    it('refuses the same request through claimById, and hands it over once it is older', async () => {
      const project = await createProject(pg, 'Acme')
      const { id } = (await store.request(project.id)) as { id: number }

      expect(
        await store.claimById(id, { leaseMs: 60_000, maxAttempts: 5, claimDelayMs: DELAY_MS }),
      ).toBeNull()
      // Not merely unclaimed: refusing must not consume an attempt either,
      // or a CLI polling this would exhaust the budget while waiting.
      expect((await store.get(id))?.attempts).toBe(0)

      await pg.query(
        "UPDATE project_deletions SET requested_at = now() - interval '2 minutes' WHERE id = $1",
        [id],
      )
      const claimed = await store.claimById(id, {
        leaseMs: 60_000,
        maxAttempts: 5,
        claimDelayMs: DELAY_MS,
      })
      expect(claimed?.id).toBe(id)
    })
  })

  /**
   * The dead end this exists to open. `claim()` refuses a request at
   * `maxAttempts`, `request()` refuses to file a second one for a project
   * already stamped `deleting_at`, and nothing clears that stamp — so
   * without `reopen()` a five-times-failed purge is permanent, with whatever
   * survived the teardown still in ClickHouse and ingest refused forever.
   */
  describe('reopen', () => {
    it('makes an exhausted request claimable again on the next tick', async () => {
      const project = await createProject(pg, 'Acme')
      const { id } = (await store.request(project.id)) as { id: number }
      await pg.query(
        "UPDATE project_deletions SET attempts = 5, claimed_at = now(), last_error = 'boom' WHERE id = $1",
        [id],
      )
      // The dead end, proven before it is opened.
      expect(await store.claim({ leaseMs: 60_000, maxAttempts: 5, claimDelayMs: 0 })).toBeNull()

      const reopened = await store.reopen(id)
      expect(reopened).toMatchObject({ id, attempts: 0, claimedAt: null })
      expect(await store.claim({ leaseMs: 60_000, maxAttempts: 5, claimDelayMs: 0 })).not.toBeNull()
    })

    /**
     * Following `DeletionStore.reopen`'s precedent deliberately: the error is
     * the only record of why the last attempt failed, it is what the status
     * endpoint shows, and it is what the operator is acting on at the moment
     * they run this. `complete()` clears it on success anyway.
     */
    it('leaves last_error in place', async () => {
      const project = await createProject(pg, 'Acme')
      const { id } = (await store.request(project.id)) as { id: number }
      await store.fail(id, 'ClickHouse unreachable')
      expect((await store.reopen(id))?.lastError).toBe('ClickHouse unreachable')
    })

    it('refuses a completed request, which is a tombstone rather than work', async () => {
      const project = await createProject(pg, 'Acme')
      const { id } = (await store.request(project.id)) as { id: number }
      await store.complete(id)
      expect(await store.reopen(id)).toBeNull()
      expect((await store.get(id))?.completedAt).not.toBeNull()
    })

    it('answers null for an unknown id', async () => {
      expect(await store.reopen(2_147_483_000)).toBeNull()
    })
  })

  it('truncates a pathological last_error', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await store.request(project.id)) as { id: number }
    await store.fail(id, 'x'.repeat(5000))
    const req = await store.get(id)
    expect(req?.lastError).toHaveLength(2000)
  })

  it('leaves neither write behind when the transaction fails', async () => {
    const project = await createProject(pg, 'Acme')
    // Force the INSERT to fail: a NOT NULL column fed a null by a poisoned
    // name is not reachable through the API, so drop the table's NOT NULL
    // expectation by deleting the project row mid-flight instead.
    await pg.query('DROP INDEX project_deletions_pending_idx')
    await pg.query('ALTER TABLE project_deletions ADD CONSTRAINT boom CHECK (false) NOT VALID')
    await pg.query('ALTER TABLE project_deletions VALIDATE CONSTRAINT boom').catch(() => {})
    await expect(store.request(project.id)).rejects.toThrow()
    const row = await pg.query('SELECT deleting_at FROM projects WHERE id = $1', [project.id])
    expect(row.rows[0].deleting_at).toBeNull()
    await pg.query('ALTER TABLE project_deletions DROP CONSTRAINT boom')
    await pg.query(
      'CREATE INDEX project_deletions_pending_idx ON project_deletions (requested_at) WHERE completed_at IS NULL',
    )
  })
})

/**
 * THE CADENCE PIN. `purgeProject` returning `deleted: false` is documented as
 * "the next pass redoes the teardown", and the whole question is what "the
 * next pass" means in wall-clock time. Through `fail()` it means the end of
 * the lease — `projectPurgeLeaseMs`, half an hour by default — with the
 * project half-destroyed for all of it, and five such races reaching the
 * terminal `failed` state that only `reopen()` can leave. Through `defer()`
 * it means the next worker tick, with the attempt given back.
 *
 * Driven through a REAL store rather than spies: the defect was entirely in
 * what `fail()` writes (and does not write), which a mock `fail` cannot show.
 * Only `purge` is injected, because a reappearance cannot be produced on
 * demand from real ClickHouse.
 */
describe('ProjectPurgeWorker over a real ProjectDeletionStore', () => {
  function makeWorker(opts: {
    purge: (projectId: number) => Promise<{ deleted: boolean; remaining: Record<string, number> }>
  }) {
    return new ProjectPurgeWorker({
      claim: (o) => store.claim({ ...o, claimDelayMs: 0 }),
      purge: opts.purge,
      complete: (id) => store.complete(id),
      fail: (id, error) => store.fail(id, error),
      defer: (id, note) => store.defer(id, note),
      intervalMs: 60_000,
      leaseMs: 1_800_000,
      maxAttempts: 5,
      onError: () => {},
    })
  }

  it('re-claims a reappearance on the very next tick, without spending an attempt', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await store.request(project.id)) as { id: number }

    let calls = 0
    const worker = makeWorker({
      purge: async (): Promise<{ deleted: boolean; remaining: Record<string, number> }> => {
        calls++
        return calls === 1
          ? { deleted: false, remaining: { events: 2 } }
          : { deleted: true, remaining: {} }
      },
    })

    expect(await worker.runOnce()).toBe('deferred')

    // Claimable again NOW, with nothing faked about the clock: no lease left
    // to wait out, the attempt handed back, and the reason on record for the
    // status endpoint to report.
    const after = await store.get(id)
    expect(after).toMatchObject({ claimedAt: null, attempts: 0, completedAt: null })
    expect(after?.lastError).toContain('rows reappeared during purge')

    // The very next tick, with no time passing at all.
    expect(await worker.runOnce()).toBe('purged')
    expect(calls).toBe(2)
    expect((await store.get(id))?.completedAt).not.toBeNull()
  })

  /**
   * The other half of the same decision: a reappearance must not walk the
   * request towards the terminal state. Five in a row leave it exactly as
   * claimable as the first one did — which is what makes a busy project
   * safe to delete.
   */
  it('never exhausts the attempt budget on repeated reappearances', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await store.request(project.id)) as { id: number }
    const worker = makeWorker({
      purge: async () => ({ deleted: false, remaining: { events: 1 } }),
    })

    for (let i = 0; i < 6; i++) expect(await worker.runOnce()).toBe('deferred')

    const after = await store.get(id)
    expect(after?.attempts).toBe(0)
    expect(after?.completedAt).toBeNull()
    // Still claimable — the state a request past maxAttempts is NOT in.
    expect(
      await store.claim({ leaseMs: 1_800_000, maxAttempts: 5, claimDelayMs: 0 }),
    ).not.toBeNull()
  })

  /**
   * `fail()` is untouched by all of the above, and must stay that way: a
   * genuinely broken purge holds its lease so it retries slowly, rather than
   * spinning through its whole budget in a minute.
   */
  it('leaves a thrown purge on fail(), lease held and attempt spent', async () => {
    const project = await createProject(pg, 'Acme')
    const { id } = (await store.request(project.id)) as { id: number }
    const worker = makeWorker({
      purge: async () => {
        throw new Error('ClickHouse unreachable')
      },
    })

    expect(await worker.runOnce()).toBe('failed')
    const after = await store.get(id)
    expect(after?.attempts).toBe(1)
    expect(after?.claimedAt).not.toBeNull()
    expect(after?.lastError).toContain('ClickHouse unreachable')
    expect(await store.claim({ leaseMs: 1_800_000, maxAttempts: 5, claimDelayMs: 0 })).toBeNull()
  })
})
