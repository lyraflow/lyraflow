import { describe, expect, it, vi } from 'vitest'
import type { RetentionTarget } from './store.js'
import { RetentionWorker, type RetentionWorkerOptions } from './worker.js'

const targetA: RetentionTarget = { projectId: 1, retentionMonths: 12 }
const targetB: RetentionTarget = { projectId: 2, retentionMonths: 12 }

function makeWorker(overrides: Partial<RetentionWorkerOptions> = {}): RetentionWorker {
  return new RetentionWorker({
    listProjects: async () => [targetA],
    dropExpired: async () => [],
    now: () => new Date(),
    intervalMs: 60_000,
    onError: vi.fn(),
    onRun: vi.fn(),
    ...overrides,
  })
}

describe('RetentionWorker', () => {
  it('reads the clock once per run and passes the same instant to every project', async () => {
    // A boundary recomputed per project could straddle a month rollover
    // mid-run, so two projects with identical retention would get different
    // boundaries -- and the difference would be a whole month of data.
    const seen: Date[] = []
    const worker = makeWorker({
      listProjects: async () => [targetA, targetB],
      dropExpired: async (_t, now) => {
        seen.push(now)
        return []
      },
    })
    await worker.runOnce()
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  it('continues to the next project when one throws, and reports the failure', async () => {
    // One project's bad state must not stop every other project's retention
    // -- which would be silent unbounded growth everywhere else.
    const errors: { projectId?: number }[] = []
    const seen: number[] = []
    const worker = makeWorker({
      listProjects: async () => [targetA, targetB],
      dropExpired: async (t) => {
        if (t.projectId === targetA.projectId) throw new Error('boom')
        seen.push(t.projectId)
        return []
      },
      onError: (_err, ctx) => errors.push(ctx),
    })
    await worker.runOnce()
    expect(seen).toEqual([targetB.projectId])
    expect(errors).toEqual([{ projectId: targetA.projectId }])
  })

  it('never rejects, even when listProjects throws', async () => {
    // runOnce is driven fire-and-forget from setInterval, so a rejection is
    // an unhandled rejection, which takes the process down with it.
    const worker = makeWorker({
      listProjects: async () => {
        throw new Error('postgres is down')
      },
    })
    await expect(worker.runOnce()).resolves.toBeUndefined()
  })

  it('does not start a second run while one is in flight', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const worker = makeWorker({
      dropExpired: async () => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 20))
        concurrent -= 1
        return []
      },
    })
    await Promise.all([worker.runOnce(), worker.runOnce()])
    expect(maxConcurrent).toBe(1)
  })

  it('reports the partitions dropped through onRun', async () => {
    const runs: { partitionsDropped: number }[] = []
    const worker = makeWorker({
      dropExpired: async () => [
        { projectId: 1, table: 'events', partition: 202401, dropped: true },
        { projectId: 1, table: 'events', partition: 202402, dropped: false },
      ],
      onRun: (s) => runs.push(s),
    })
    await worker.runOnce()
    // Only actual drops count. A dry-run result reported as a drop would
    // make the metric say work happened when none did.
    expect(runs).toEqual([expect.objectContaining({ partitionsDropped: 1 })])
  })

  it('stop() prevents further runs, and start() after stop() resumes', async () => {
    let calls = 0
    const worker = makeWorker({
      listProjects: async () => {
        calls += 1
        return []
      },
    })
    worker.stop()
    await worker.runOnce()
    expect(calls).toBe(0)
    worker.start()
    await worker.runOnce()
    expect(calls).toBe(1)
    worker.stop()
  })

  // --- Additional coverage beyond the brief's named tests ---

  it('reports a run-level failure with no projectId, distinct from a per-project one', async () => {
    // listProjects fails before any project is known -- the failure cannot
    // be attributed to a project, and must not be reported as if it were
    // project 1's failure or silently merged into a per-project context.
    const errors: { projectId?: number }[] = []
    const worker = makeWorker({
      listProjects: async () => {
        throw new Error('postgres is down')
      },
      onError: (_err, ctx) => errors.push(ctx),
    })
    await worker.runOnce()
    expect(errors).toEqual([{}])
  })

  it('does not abort the run when dropExpired throws synchronously', async () => {
    // p.catch() cannot absorb a synchronous throw -- a repeat defect in this
    // codebase (see PurgeWorker's equivalent test). The stub below does not
    // even return a promise: calling it throws immediately, before any
    // `await` or `.then`/`.catch` could ever attach to it.
    const seen: number[] = []
    const worker = makeWorker({
      listProjects: async () => [targetA, targetB],
      dropExpired: ((t: RetentionTarget) => {
        if (t.projectId === targetA.projectId) {
          throw new Error('sync boom')
        }
        seen.push(t.projectId)
        return Promise.resolve([])
      }) as unknown as RetentionWorkerOptions['dropExpired'],
    })
    await expect(worker.runOnce()).resolves.toBeUndefined()
    expect(seen).toEqual([targetB.projectId])
  })

  it('still reports onRun after a project failure, counting only the survivor', async () => {
    const runs: { partitionsDropped: number }[] = []
    const worker = makeWorker({
      listProjects: async () => [targetA, targetB],
      dropExpired: async (t) => {
        if (t.projectId === targetA.projectId) throw new Error('boom')
        return [{ projectId: t.projectId, table: 'events', partition: 202401, dropped: true }]
      },
      onRun: (s) => runs.push(s),
    })
    await worker.runOnce()
    expect(runs).toEqual([expect.objectContaining({ partitionsDropped: 1 })])
  })

  it('does not reject when onError itself throws', async () => {
    // Recording a per-project failure must not depend on the caller-supplied
    // onError surviving -- a broken logger must not be able to take the
    // whole run down with it, or stop the loop from reaching onRun.
    const runs: { partitionsDropped: number }[] = []
    const worker = makeWorker({
      dropExpired: async () => {
        throw new Error('boom')
      },
      onError: () => {
        throw new Error('logger exploded')
      },
      onRun: (s) => runs.push(s),
    })
    await expect(worker.runOnce()).resolves.toBeUndefined()
    expect(runs).toEqual([expect.objectContaining({ partitionsDropped: 0 })])
  })
})
