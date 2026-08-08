import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { PersonScope } from '../identity/scope.js'
import { DeletionStore } from './deletion-store.js'
import { SuppressionStore } from './suppression-store.js'
import { PurgeWorker, type PurgeWorkerOptions } from './worker.js'

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
  await pg.query("DELETE FROM projects WHERE slug = 'purge-worker-a'")
}

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  // Cleaned up here too, not only in afterAll — see deletion-store.test.ts's
  // identical note. `claim()` is not project-scoped (deliberately — see
  // DeletionStore.claim), so a row left behind by any earlier crashed run of
  // ANY test file is fair game for every `claim()` call below. This is only
  // safe because vitest.config.ts sets `fileParallelism: false`.
  await cleanupProjects()
  await pg.query('DELETE FROM deletion_requests')
  const a = await pg.query<{ id: string }>(
    `INSERT INTO projects (name, slug, write_key, server_key_hash)
     VALUES ('Purge Worker', 'purge-worker-a', 'wk_purge_worker_a', 'h') RETURNING id`,
  )
  projectId = Number(a.rows[0]?.id)
})

afterAll(async () => {
  await cleanupProjects()
  await pg.end()
  await ch.close()
})

// Every claim() below reaches across every project in the database (see
// DeletionStore.claim), so a leftover pending row from one test would be
// silently picked up by the next. Draining after every test, not only in
// afterAll, is what keeps the tests independent.
afterEach(async () => {
  await pg.query('DELETE FROM deletion_requests')
})

/** A minimal, self-consistent scope for a person with no real identity graph. */
function scopeFor(personId: string): PersonScope {
  return { canonical: personId, group: [personId], devices: [], ids: [personId], windows: [] }
}

const stubResolve = async (_projectId: number, personId: string): Promise<PersonScope> =>
  scopeFor(personId)

const DEFAULT_OPTS = {
  intervalMs: 60_000,
  leaseMs: 300_000,
  maxAttempts: 5,
} as const

function makeWorker(overrides: Partial<PurgeWorkerOptions> = {}): PurgeWorker {
  return new PurgeWorker({
    deletions: store,
    resolve: stubResolve,
    purge: async () => {},
    onError: vi.fn(),
    ...DEFAULT_OPTS,
    ...overrides,
  })
}

describe('PurgeWorker', () => {
  it('claims a pending request, purges it, and marks it complete', async () => {
    const { id } = await store.request(projectId, 'happy-path-1', ['happy-path-1'], new Date())
    const purgeCalls: { projectId: number; scope: PersonScope }[] = []
    const worker = makeWorker({
      purge: async (pid, scope) => {
        purgeCalls.push({ projectId: pid, scope })
      },
    })

    expect(await worker.runOnce()).toBe('purged')

    expect(purgeCalls).toHaveLength(1)
    expect(purgeCalls[0]?.projectId).toBe(projectId)
    expect(purgeCalls[0]?.scope.canonical).toBe('happy-path-1')

    const row = await store.get(projectId, id)
    expect(row?.completedAt).not.toBeNull()
    expect(row?.lastError).toBeNull()

    // A SECOND, independent request, claimed and purged by the SAME worker
    // instance on a second call: this is what catches `#inFlight` never
    // being reset in `finally` — a bug the first call alone cannot reveal,
    // since #inFlight starts false regardless of whether the reset exists.
    const { id: secondId } = await store.request(
      projectId,
      'happy-path-2',
      ['happy-path-2'],
      new Date(),
    )
    expect(await worker.runOnce()).toBe('purged')
    expect(purgeCalls).toHaveLength(2)
    expect(purgeCalls[1]?.scope.canonical).toBe('happy-path-2')
    const secondRow = await store.get(projectId, secondId)
    expect(secondRow?.completedAt).not.toBeNull()
  })

  it('returns "idle" with nothing to do', async () => {
    const resolve = vi.fn(stubResolve)
    const purge = vi.fn(async () => {})
    const worker = makeWorker({ resolve, purge })

    expect(await worker.runOnce()).toBe('idle')
    expect(resolve).not.toHaveBeenCalled()
    expect(purge).not.toHaveBeenCalled()
  })

  it('NEVER rejects when a step throws', async () => {
    // The single most important property of this loop: it runs unattended,
    // fire-and-forget from a timer, and an unhandled rejection here takes
    // the whole server down long after the deletion it was processing.
    const { id } = await store.request(projectId, 'async-throw-1', ['async-throw-1'], new Date())
    const worker = makeWorker({
      purge: async () => {
        throw new Error('boom')
      },
    })

    await expect(worker.runOnce()).resolves.toBe('failed')

    const row = await store.get(projectId, id)
    expect(row?.lastError).toContain('boom')
    expect(row?.completedAt).toBeNull()
  })

  it('NEVER rejects when a step throws SYNCHRONOUSLY', async () => {
    // p.catch() cannot absorb a synchronous throw — this is a repeat defect
    // in this codebase, which is why it gets its own test rather than being
    // folded into the async-throw test above. The stub below does not even
    // return a promise: calling it throws immediately, before any `await`
    // or `.then`/`.catch` could ever attach to it.
    await store.request(projectId, 'sync-throw-1', ['sync-throw-1'], new Date())
    const worker = makeWorker({
      purge: (() => {
        throw new Error('sync boom')
      }) as unknown as PurgeWorkerOptions['purge'],
    })

    await expect(worker.runOnce()).resolves.toBe('failed')
  })

  it('reports the failure through onError as well as last_error', async () => {
    const { id } = await store.request(projectId, 'on-error-1', ['on-error-1'], new Date())
    const onError = vi.fn()
    const worker = makeWorker({
      purge: async () => {
        throw new Error('reported boom')
      },
      onError,
    })

    expect(await worker.runOnce()).toBe('failed')

    expect(onError).toHaveBeenCalledTimes(1)
    const [err, context] = onError.mock.calls[0] as [unknown, { requestId?: number }]
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toBe('reported boom')
    expect(context.requestId).toBe(id)

    const row = await store.get(projectId, id)
    expect(row?.lastError).toContain('reported boom')
  })

  it('resumes a request abandoned by a crashed process', async () => {
    // Claim it, do nothing (the crash), age claimed_at past the lease, then
    // run a fresh worker: it must claim the SAME request, purge it, and
    // complete it. Ageing the column, not sleeping — a test that sleeps for
    // a lease is a test nobody runs.
    const { id } = await store.request(projectId, 'crash-resume-1', ['crash-resume-1'], new Date())
    const crashed = await store.claim(DEFAULT_OPTS)
    expect(crashed?.id).toBe(id)

    await pg.query(
      "UPDATE deletion_requests SET claimed_at = now() - interval '1 hour' WHERE id = $1",
      [id],
    )

    const purgeCalls: string[] = []
    const worker = makeWorker({
      purge: async (_pid, scope) => {
        purgeCalls.push(scope.canonical)
      },
    })

    expect(await worker.runOnce()).toBe('purged')
    expect(purgeCalls).toEqual(['crash-resume-1'])

    const row = await store.get(projectId, id)
    expect(row?.completedAt).not.toBeNull()
  })

  it('stops claiming once the attempt cap is reached, leaving last_error set', async () => {
    await store.request(projectId, 'attempt-cap-1', ['attempt-cap-1'], new Date())
    // leaseMs: 0 stands in for a lease that has always already expired, so
    // the ONLY thing that can stop a re-claim is the attempts cap — the
    // same trick deletion-store.test.ts uses to isolate this property from
    // the lease.
    const worker = makeWorker({
      leaseMs: 0,
      maxAttempts: 1,
      purge: async () => {
        throw new Error('always fails')
      },
    })

    expect(await worker.runOnce()).toBe('failed')
    expect(await worker.runOnce()).toBe('idle')

    const rows = await pg.query<{ last_error: string | null; completed_at: Date | null }>(
      "SELECT last_error, completed_at FROM deletion_requests WHERE project_id = $1 AND person_id = 'attempt-cap-1'",
      [projectId],
    )
    expect(rows.rows[0]?.last_error).toContain('always fails')
    expect(rows.rows[0]?.completed_at).toBeNull()
  })

  it('does not start a second purge while one is in flight', async () => {
    // Two pending requests, not one: if the #inFlight guard were missing, a
    // second concurrent runOnce() would find a second row to claim and this
    // test would still see the guard-free implementation return 'idle' for
    // the wrong reason (nothing left to claim) rather than the right one
    // (the guard). Two rows makes the guard the ONLY thing that can produce
    // the assertions below.
    await store.request(projectId, 'inflight-a', ['inflight-a'], new Date())
    await store.request(projectId, 'inflight-b', ['inflight-b'], new Date())

    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let purgeStarted: () => void = () => {}
    const purgeStartedPromise = new Promise<void>((resolve) => {
      purgeStarted = resolve
    })
    let purgeStarts = 0
    const claimSpy = vi.spyOn(store, 'claim')
    const worker = makeWorker({
      purge: async () => {
        purgeStarts++
        purgeStarted()
        await held
      },
    })

    try {
      // The timer fires on a fixed interval; a purge that outlives the
      // interval must not stack. Calling runOnce() a second time while the
      // first is genuinely in flight is exactly what a second tick does —
      // the production `start()` path is `void this.runOnce()` on every
      // tick, so invoking runOnce() directly exercises the identical guard.
      // p1 is awaited up to (and including) the point its purge has
      // actually started and is blocked on `held`, so p2 below is issued
      // deterministically while #inFlight is true — not racing it.
      const p1 = worker.runOnce()
      await purgeStartedPromise
      const p2 = worker.runOnce()

      expect(await p2).toBe('idle')
      expect(claimSpy).toHaveBeenCalledTimes(1)
      expect(purgeStarts).toBe(1)

      release()
      expect(await p1).toBe('purged')
    } finally {
      claimSpy.mockRestore()
      release()
    }

    // The second request was never touched.
    const remaining = await pg.query(
      "SELECT claimed_at FROM deletion_requests WHERE project_id = $1 AND person_id = 'inflight-b'",
      [projectId],
    )
    expect(remaining.rows[0]?.claimed_at).toBeNull()
  })

  it('stops claiming new work after stop()', async () => {
    // #inFlight is false throughout this test (no purge is ever started) —
    // deliberately, so that this proves the #stopped guard alone, not a
    // mix of the two. See the single-flight test above for the #inFlight
    // guard proven on its own.
    await store.request(projectId, 'stopped-1', ['stopped-1'], new Date())
    const worker = makeWorker()
    worker.stop()

    expect(await worker.runOnce()).toBe('idle')

    const row = await pg.query(
      "SELECT claimed_at FROM deletion_requests WHERE project_id = $1 AND person_id = 'stopped-1'",
      [projectId],
    )
    expect(row.rows[0]?.claimed_at).toBeNull()
  })

  it('stop() does not await an in-flight purge', async () => {
    // A ClickHouse mutation completes server-side whether or not this
    // process is still watching, and completed_at is only written on
    // confirmation — so stop() must return immediately, and the purge that
    // was already running must be left alone to finish (or not) on its own.
    const { id } = await store.request(
      projectId,
      'stop-inflight-1',
      ['stop-inflight-1'],
      new Date(),
    )
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const worker = makeWorker({ purge: async () => held })

    const p1 = worker.runOnce()
    // stop() is synchronous (`stop(): void`) and must return without
    // waiting on `held`, which is not resolved until after this call.
    worker.stop()

    // No new work is taken post-stop, proven independently above; here the
    // point is that the ALREADY-in-flight purge is unaffected by stop().
    release()
    expect(await p1).toBe('purged')
    const row = await store.get(projectId, id)
    expect(row?.completedAt).not.toBeNull()
  })
})
