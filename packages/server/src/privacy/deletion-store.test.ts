import { join } from 'node:path'
import { type Pool, createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { type DeletionRequest, DeletionStore } from './deletion-store.js'
import { SuppressionStore } from './suppression-store.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})
const suppression = new SuppressionStore(pg)
const store = new DeletionStore(pg, suppression)
let projectId: number

async function cleanupProjects(): Promise<void> {
  for (const slug of ['delstore-a', 'delstore-b']) {
    await pg.query('DELETE FROM projects WHERE slug = $1', [slug])
  }
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  // Cleaned up here too, not only in afterAll: tests share these live
  // databases across files, and a run that died mid-suite would otherwise
  // leave rows from a previous attempt for the next run to collide with.
  await cleanupProjects()
  // `claim()` is deliberately NOT scoped to a project (see DeletionStore.claim
  // for why) — it is a global "next thing to do" query. That means a row left
  // behind anywhere in this table, by any project, from any earlier crashed
  // run, is fair game for every `claim()` call below. Wiping the whole table,
  // not just rows tied to this file's own projects, is what makes the claim
  // tests below deterministic rather than dependent on what else happens to
  // be sitting in it. This is only safe because vitest.config.ts sets
  // `fileParallelism: false` — no other test file's `deletion_requests` rows
  // are ever live at the same time as this file's. Tasks 6 and 7 will add
  // route tests that touch this same table; if either ever needs to run
  // concurrently with this file, this wipe needs to be scoped down first.
  await pg.query('DELETE FROM deletion_requests')
  const a = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('A', 'delstore-a', 'wk_delstore_a', 'h') RETURNING id`,
  )
  projectId = Number(a.rows[0]?.id)
})

afterAll(async () => {
  await cleanupProjects()
  await pg.end()
  await ch.close()
})

// Every test in this file that touches `claim()` needs to know exactly what
// is claimable at the moment it calls it, and `claim()` reaches across every
// project in the database (see DeletionStore.claim). Draining the table after
// every test — not only in afterAll — is what keeps one test's leftover
// pending row from being silently picked up by the next test's claim() call.
afterEach(async () => {
  await pg.query('DELETE FROM deletion_requests')
})

const opts = { leaseMs: 300_000, maxAttempts: 5 }

describe('DeletionStore', () => {
  it('writes the suppression row and the request in one transaction', async () => {
    const { id, suppressedAt } = await store.request(projectId, 'atomic-1', new Date())
    expect(id).toBeGreaterThan(0)
    const sup = await pg.query(
      'SELECT suppressed_at FROM suppressed_persons WHERE project_id=$1 AND person_id=$2',
      [projectId, 'atomic-1'],
    )
    expect(sup.rows[0].suppressed_at.getTime()).toBe(suppressedAt.getTime())
  })

  it('lands NEITHER row when the second write fails', async () => {
    // The brief's own version of this test tries to force the failure with a
    // project_id that has no `projects` row. That does not exercise this
    // scenario against this schema: `suppressed_persons.project_id` carries
    // the exact same FK to `projects` that `deletion_requests.project_id`
    // does (005_suppression.sql and 008_deletion_requests.sql), so a
    // nonexistent project id fails the FIRST write — the suppression upsert
    // — before the deletion_requests insert is ever attempted. A
    // first-statement failure can't leave an orphan row with or without
    // BEGIN/COMMIT/ROLLBACK, so that version of the test cannot tell the two
    // implementations apart. Confirmed by hand: run against the code with
    // BEGIN/COMMIT/ROLLBACK removed, the ghost-project version of this test
    // still passed.
    //
    // Testing the real scenario — the SECOND write failing after the FIRST
    // has genuinely succeeded — needs a project id that suppression accepts,
    // with only the deletion_requests statement forced to fail. That can't
    // be done by choosing bad input (this store always sends the exact same
    // project_id/person_id to both statements, and the two tables enforce
    // the same constraints on both), so the failure is injected at the
    // connection: `client.query` is wrapped to reject only the statement
    // that targets `deletion_requests`, leaving the suppression statement
    // untouched.
    const client = await pg.connect()
    const originalQuery = client.query.bind(client)
    const spy = vi.spyOn(client, 'query').mockImplementation(((...args: unknown[]) => {
      const first = args[0]
      const text =
        typeof first === 'string' ? first : (first as { text?: string } | undefined)?.text
      if (typeof text === 'string' && text.includes('INSERT INTO deletion_requests')) {
        return Promise.reject(new Error('deliberate failure injected for this test'))
      }
      return originalQuery(...(args as Parameters<typeof originalQuery>))
    }) as typeof client.query)

    try {
      // A pool stand-in whose only job is to hand back this one already-
      // spied-on client, so `request()`'s internal `pool.connect()` gets the
      // wrapped `query` without any other part of the store changing.
      const spiedPool = { connect: async () => client } as unknown as Pool
      const storeWithInjectedFailure = new DeletionStore(spiedPool, suppression)

      await expect(
        storeWithInjectedFailure.request(projectId, 'orphan-1', new Date()),
      ).rejects.toThrow('deliberate failure injected for this test')
      const sup = await pg.query(
        'SELECT 1 FROM suppressed_persons WHERE project_id=$1 AND person_id=$2',
        [projectId, 'orphan-1'],
      )
      expect(sup.rowCount).toBe(0)
    } finally {
      // `request()` already released `client` back to the real pool in its
      // own `finally`; undo the spy before it can serve any other query.
      spy.mockRestore()
    }
  })

  it('destroys the connection, rather than recycling it, when ROLLBACK itself fails', async () => {
    // `client.release()` with no argument returns the connection to the
    // pool's IDLE list unconditionally — it does not check whether the
    // transaction on it was ever rolled back. A connection released that
    // way after a failed ROLLBACK goes back into circulation still inside
    // an aborted transaction, and every later query anyone sends over it
    // fails with "current transaction is aborted, commands ignored until
    // end of transaction block" — permanently. Only `client.release(err)`,
    // called with a truthy argument, makes the pool DESTROY the connection
    // instead of recycling it.
    //
    // A fully synthetic client/pool, rather than a real `pg.connect()`
    // client: reproducing a genuine ROLLBACK failure against live Postgres
    // needs the connection itself to be broken (e.g. killing the backend
    // mid-transaction), which is exactly the kind of thing that can't be
    // done deterministically from here. What this test pins is
    // `DeletionStore.request`'s own control flow — that a rollback failure
    // is captured and reaches `release` — which a fake client observes
    // exactly as well as a real one would, without needing a live
    // connection to clean up afterwards.
    const releaseCalls: unknown[] = []
    const fakeClient = {
      query: vi.fn((text: string, params?: unknown[]) => {
        if (text === 'BEGIN' || text === 'COMMIT') return Promise.resolve({ rows: [] })
        if (text.includes('INSERT INTO suppressed_persons')) {
          return Promise.resolve({ rows: [{ suppressed_at: params?.[2] }] })
        }
        if (text.includes('INSERT INTO deletion_requests')) {
          return Promise.reject(new Error('deliberate insert failure'))
        }
        if (text === 'ROLLBACK') {
          return Promise.reject(new Error('deliberate rollback failure'))
        }
        throw new Error(`unexpected query in this test: ${text}`)
      }),
      release: vi.fn((err?: unknown) => {
        releaseCalls.push(err)
      }),
    }
    const fakePool = { connect: async () => fakeClient } as unknown as Pool
    const storeWithFakeConnection = new DeletionStore(fakePool, suppression)

    // The ORIGINAL error — the insert failure, not the rollback failure —
    // is what must reach the caller; the rollback failure is dealt with
    // separately, via `release`, below.
    await expect(
      storeWithFakeConnection.request(projectId, 'rollback-fails-1', new Date()),
    ).rejects.toThrow('deliberate insert failure')

    expect(releaseCalls).toHaveLength(1)
    expect(releaseCalls[0]).toBeInstanceOf(Error)
    expect((releaseCalls[0] as Error).message).toBe('deliberate rollback failure')
  })

  it('advances the boundary on a repeat request and files a second request', async () => {
    // A person who resumed using the product and asks again: the second
    // request must move the boundary forward AND schedule its own purge, not
    // fail on a duplicate key and erase nothing new.
    const first = new Date(Date.now() - 5 * 3_600_000)
    const second = new Date(Date.now() - 2 * 3_600_000)
    const a = await store.request(projectId, 'repeat-1', first)
    const b = await store.request(projectId, 'repeat-1', second)
    expect(b.id).not.toBe(a.id)
    expect(b.suppressedAt.getTime()).toBe(second.getTime())

    const boundary = await suppression.boundaryFor(projectId, ['repeat-1'])
    expect(boundary?.getTime()).toBe(second.getTime())

    const rows = await pg.query<{ id: string }>(
      'SELECT id FROM deletion_requests WHERE project_id=$1 AND person_id=$2 ORDER BY requested_at',
      [projectId, 'repeat-1'],
    )
    expect(rows.rows.map((r) => Number(r.id))).toEqual([a.id, b.id])
  })

  it('claims exactly one request, and never the same one twice, under genuine concurrency', async () => {
    await store.request(projectId, 'concurrent-1', new Date())
    await store.request(projectId, 'concurrent-2', new Date())

    // Promise.all over a single pooled connection would serialise these two
    // claims, which would make this test pass even without SKIP LOCKED — see
    // clients.ts: the pool is created with `max: 10`, so two queries issued
    // without an intervening `await` really can run on two separate physical
    // connections at once. Rather than trust that, watch the pool itself:
    // both calls below increment `inFlight` before either can decrement it,
    // because `store.claim`'s synchronous prefix (the call into
    // `pool.query`) runs for both promises before the event loop gets a
    // chance to resolve either — so `observedConcurrency` reaching 2 is
    // proof, not an assumption, that the two claims were genuinely in flight
    // together at the connection-pool level.
    //
    // That said: this test alone is NOT proof that SKIP LOCKED specifically
    // is what keeps the two ids distinct. Confirmed by hand, run five times
    // in a row against a build with `FOR UPDATE SKIP LOCKED` deleted: it
    // passed every time. These are single-row index lookups that complete in
    // well under a millisecond, and the two claims usually don't land inside
    // each other's brief lock window even when genuinely concurrent at the
    // connection level — so a real collision, which is what SKIP LOCKED
    // actually prevents, is rare enough that this test cannot be trusted to
    // catch its absence. See the next test for a deterministic version of
    // that proof, which is the one that mutation actually falsifies.
    //
    // `maxAttempts: 1` rather than the shared `opts` deliberately: with
    // `maxAttempts: 5`, once one claim commits and its lock releases, the
    // ONLY thing stopping the other claim from picking that same
    // now-unlocked row is the lease/claimed_at check — so this test would
    // also (correctly, but unhelpfully) redden under the lease mutation
    // below, entangling two independent properties in one test. Capping
    // attempts at 1 means the attempts guard alone — untouched by that
    // mutation — already excludes a row the instant it has been claimed
    // once, so this test stays a clean, single-purpose proof that two
    // genuinely concurrent claims never return the same id.
    const claimOnce = { leaseMs: 300_000, maxAttempts: 1 }
    let inFlight = 0
    let observedConcurrency = 0
    // biome-ignore lint/suspicious/noExplicitAny: forwarding to the real, fully-overloaded pg.query
    const originalQuery = pg.query.bind(pg) as (...args: any[]) => Promise<unknown>
    const spy = vi.spyOn(pg, 'query').mockImplementation(((...args: unknown[]) => {
      inFlight++
      observedConcurrency = Math.max(observedConcurrency, inFlight)
      return Promise.resolve(originalQuery(...args)).finally(() => {
        inFlight--
      })
    }) as typeof pg.query)

    try {
      const [a, b] = await Promise.all([store.claim(claimOnce), store.claim(claimOnce)])
      expect(a?.id).not.toBe(b?.id)
      expect(new Set([a?.id, b?.id]).size).toBe(2)
      expect(observedConcurrency).toBeGreaterThanOrEqual(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('skips a row it cannot lock instead of blocking on it', async () => {
    const locked = await store.request(projectId, 'locked-row-1', new Date())
    await store.request(projectId, 'locked-row-2', new Date())

    // Hold an explicit row lock on the FIRST (oldest, so ORDER BY would pick
    // it first) pending request from a second, independent connection, and
    // never commit it for the duration of this test. A correct claim() must
    // skip straight past a row it cannot lock and take the other pending one
    // instead — that is exactly what FOR UPDATE SKIP LOCKED buys. Without
    // it, the inner SELECT still reads the row's last-committed state (a
    // bare SELECT never blocks on a row lock), picks the SAME row this
    // connection is holding, and the outer UPDATE then blocks on that exact
    // lock — deterministically, not by chance — until this test's timeout
    // turns the hang into a failing assertion instead of leaving the whole
    // suite stuck.
    const locker = await pg.connect()
    await locker.query('BEGIN')
    await locker.query('SELECT id FROM deletion_requests WHERE id = $1 FOR UPDATE', [locked.id])

    try {
      const TIMEOUT = Symbol('timeout')
      const claimed = await Promise.race([
        store.claim(opts),
        new Promise<typeof TIMEOUT>((resolve) => setTimeout(() => resolve(TIMEOUT), 2_000)),
      ])
      expect(claimed).not.toBe(TIMEOUT)
      expect((claimed as DeletionRequest | null)?.id).not.toBe(locked.id)
    } finally {
      await locker.query('ROLLBACK')
      locker.release()
    }
  })

  it('does not re-claim a request whose lease is still live', async () => {
    // The brief's own sketch of this test calls `claim` twice with nothing
    // ever inserted first. With an empty table the first claim already
    // returns null, so the second call would return null regardless of
    // whether the lease clause exists at all — the test would pass against a
    // store with no lease logic whatsoever. A live row has to exist before
    // the first claim for this to test anything.
    await store.request(projectId, 'live-lease-1', new Date())
    await store.claim(opts)
    expect(await store.claim(opts)).toBeNull()
  })

  it('re-claims a request whose lease expired, and counts the attempt', async () => {
    await store.request(projectId, 'expired-lease-1', new Date())
    const first = await store.claim(opts)
    if (!first) throw new Error('expected a claimable request')
    // Expire it by ageing claimed_at rather than by sleeping.
    await pg.query(
      "UPDATE deletion_requests SET claimed_at = now() - interval '1 hour' WHERE id=$1",
      [first.id],
    )
    const again = await store.claim(opts)
    expect(again?.id).toBe(first.id)
    expect(again?.attempts).toBe(2)
  })

  it('stops claiming a request that has exhausted its attempts', async () => {
    // attempts = maxAttempts → never returned again, and `last_error` explains
    // why. A poisoned request must not spin forever.
    await store.request(projectId, 'exhausted-1', new Date())
    // leaseMs: 0 stands in for a lease that has always already expired, so
    // each claim below is immediately eligible again without sleeping or
    // hand-editing claimed_at — the same trick as the previous test, applied
    // repeatedly to drive `attempts` up to the cap.
    const exhaustible = { leaseMs: 0, maxAttempts: 2 }

    const first = await store.claim(exhaustible)
    if (!first) throw new Error('expected a claimable request')
    expect(first.attempts).toBe(1)
    await store.fail(first.id, 'first failure')

    const second = await store.claim(exhaustible)
    expect(second?.id).toBe(first.id)
    expect(second?.attempts).toBe(2)
    if (!second) throw new Error('expected the same request to be re-claimable')
    await store.fail(second.id, 'second failure, attempts now at the cap')

    expect(await store.claim(exhaustible)).toBeNull()
    const row = await store.get(projectId, first.id)
    expect(row?.attempts).toBe(2)
    expect(row?.lastError).toBe('second failure, attempts now at the cap')
  })

  it('never claims a completed request', async () => {
    const { id } = await store.request(projectId, 'completed-1', new Date())
    const claimed = await store.claim(opts)
    expect(claimed?.id).toBe(id)
    await store.complete(id)
    expect(await store.claim(opts)).toBeNull()
    const row = await store.get(projectId, id)
    expect(row?.completedAt).not.toBeNull()
    expect(row?.lastError).toBeNull()
  })

  it('truncates an oversized error before it reaches the row', async () => {
    const { id } = await store.request(projectId, 'oversized-error-1', new Date())
    await store.fail(id, 'x'.repeat(5_000))
    const row = await store.get(projectId, id)
    expect(row?.lastError?.length).toBeLessThan(2_100)
    expect(row?.lastError?.startsWith('x'.repeat(100))).toBe(true)
  })

  it('does not return another project request from get', async () => {
    const b = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('B', 'delstore-b', 'wk_delstore_b', 'h') RETURNING id`,
    )
    const otherProjectId = Number(b.rows[0]?.id)
    try {
      const { id } = await store.request(projectId, 'scoped-1', new Date())
      expect(await store.get(otherProjectId, id)).toBeNull()
      expect(await store.get(projectId, id)).not.toBeNull()
    } finally {
      await pg.query('DELETE FROM projects WHERE slug = $1', ['delstore-b'])
    }
  })
})
