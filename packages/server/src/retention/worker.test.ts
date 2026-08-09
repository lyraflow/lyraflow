import { describe, expect, it, vi } from 'vitest'
import type { RetentionTarget } from './store.js'
import { RetentionWorker, type RetentionWorkerOptions } from './worker.js'

const targetA: RetentionTarget = { projectId: 1, retentionMonths: 12 }
const targetB: RetentionTarget = { projectId: 2, retentionMonths: 12 }
const targetC: RetentionTarget = { projectId: 3, retentionMonths: 12 }

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

  it('pins onRun to once per run, summed across every project -- not once per project', async () => {
    // A single successful project cannot distinguish "once per run, summed"
    // from "once per project": with only one project, both readings produce
    // exactly one onRun call carrying that project's own count. TWO
    // successful projects, each dropping a non-zero count, is what actually
    // pins the cardinality -- "once per project" would push two entries onto
    // `runs`, not one, and the summed total would be split across them
    // instead of combined. This is the semantics Task 4 wires to a counter,
    // so it needs to be pinned directly, not incidentally covered by a test
    // aimed at something else.
    const runs: { partitionsDropped: number }[] = []
    const worker = makeWorker({
      listProjects: async () => [targetA, targetB],
      dropExpired: async (t) => [
        { projectId: t.projectId, table: 'events', partition: 202401, dropped: true },
        ...(t.projectId === targetA.projectId
          ? [{ projectId: t.projectId, table: 'events', partition: 202402, dropped: true }]
          : []),
      ],
      onRun: (s) => runs.push(s),
    })
    await worker.runOnce()
    expect(runs).toEqual([expect.objectContaining({ partitionsDropped: 3 })])
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

  // shutdown.ts now calls `retention.stop()` mid-drain, which can land while
  // a `runOnce()` this same tick started is still in flight — see that
  // file's own comment on why. `stop()`'s own docstring claims it does not
  // await the in-flight run; this proves that claim rather than trusting
  // the prose: `dropExpired` blocks on a gate this test controls, `stop()`
  // is called and must return before the gate is ever released (raced
  // against a timer, not merely called and hoped for), and the in-flight
  // run is then let through and still resolves normally, unaffected by
  // having been "stopped" underneath it.
  it('stop() returns immediately even while a run is in flight, and the in-flight run still completes', async () => {
    let releaseDrop: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseDrop = resolve
    })
    const runs: number[] = []
    const worker = makeWorker({
      dropExpired: async (t) => {
        await gate
        runs.push(t.projectId)
        return []
      },
    })

    const runOncePromise = worker.runOnce()
    // Let the run actually start and reach the gate before stop() is called
    // — otherwise this would only prove stop() is fast when called before
    // any work began, which stop()'s existing test above already covers.
    await Promise.resolve()
    await Promise.resolve()

    const stillPending = await Promise.race([
      (async () => {
        worker.stop()
        return 'stop-returned' as const
      })(),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 50)),
    ])
    expect(stillPending).toBe('stop-returned')

    // The run itself has not been affected by stop() — it is still
    // genuinely blocked on the gate, not silently abandoned.
    const raceWithGate = await Promise.race([
      runOncePromise.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])
    expect(raceWithGate).toBe('pending')

    releaseDrop()
    await runOncePromise
    expect(runs).toEqual([targetA.projectId])
  })

  // Round-2 fix-round test: the mid-run `stop()` case immediately above
  // uses a single-project `listProjects`, which genuinely proves `stop()`
  // is non-blocking and does not abandon the in-flight project, but
  // STRUCTURALLY cannot probe whether a sweep still visits every OTHER
  // project after `stop()` is called — with only one project, there is no
  // "next project" to wrongly sweep. This uses three: project A blocks on
  // a gate this test controls, `stop()` is called while A is still in
  // flight, and only once A is released does the run proceed — proving
  // whether it stops there or goes on to sweep B and C regardless.
  it('stop() called mid-run prevents any project not yet started from being swept', async () => {
    let releaseFirst: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const swept: number[] = []
    const worker = makeWorker({
      listProjects: async () => [targetA, targetB, targetC],
      dropExpired: async (t) => {
        if (t.projectId === targetA.projectId) {
          await gate
        }
        swept.push(t.projectId)
        return []
      },
    })

    const runOncePromise = worker.runOnce()
    // Let the run actually start and reach project A's gate before stop()
    // is called — otherwise this would only prove stop() works before any
    // project has started, which the single-project test above covers.
    await Promise.resolve()
    await Promise.resolve()

    worker.stop()
    releaseFirst()
    await runOncePromise

    // Without the between-project `#stopped` check in `#runAllProjects`,
    // this swept [1, 2, 3] -- `stop()` only ever blocked the NEXT timer
    // tick, never a sweep already in flight, so B and C got processed
    // exactly as if `stop()` had never been called at all.
    expect(swept).toEqual([targetA.projectId])
  })

  // --- The activation path itself: start() actually driving runOnce ---
  //
  // Every test above calls `runOnce()` by hand, and the two live files that
  // drive the real wiring (retention/wiring.test.ts) do the same. Nothing
  // executed the interval callback, so `setInterval(() => {}, ...)` in
  // `start()` — retention never running in production, forever — passed the
  // entire suite, with `/metrics` unable to tell a worker that never runs
  // from a healthy one with nothing left to expire.

  it('start() drives runOnce on its own interval, not merely installs a timer', async () => {
    vi.useFakeTimers()
    try {
      let listCalls = 0
      const worker = makeWorker({
        listProjects: async () => {
          listCalls += 1
          return []
        },
      })
      worker.start()
      // No leading-edge run: setInterval fires first at intervalMs, and
      // asserting that here is what stops this test from passing on a
      // start() that ran once and then never again.
      expect(listCalls).toBe(0)

      // Async advance: the callback is `void this.runOnce()`, so the work it
      // starts settles on microtasks the synchronous advance would not flush.
      await vi.advanceTimersByTimeAsync(60_000)
      expect(listCalls).toBe(1)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(listCalls).toBe(2)

      worker.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(listCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // Parity with PurgeWorker, the class this one models itself on and whose
  // equivalents live in privacy/worker.test.ts — both properties are already
  // claimed in comments in worker.ts and were asserted nowhere.
  it('start() unrefs its timer so a pending tick cannot keep the process alive', () => {
    const originalSetInterval = globalThis.setInterval
    let unrefCalled = false
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: () => void,
      timeout?: number,
    ) => {
      const t = originalSetInterval(handler, timeout)
      const originalUnref = t.unref.bind(t)
      t.unref = () => {
        unrefCalled = true
        return originalUnref()
      }
      return t
    }) as typeof setInterval)

    const worker = makeWorker()
    try {
      worker.start()
      expect(unrefCalled).toBe(true)
    } finally {
      worker.stop()
      setIntervalSpy.mockRestore()
    }
  })

  it('start() is idempotent: a second call does not install a second interval', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const worker = makeWorker()
    try {
      worker.start()
      worker.start()
      expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    } finally {
      worker.stop()
      setIntervalSpy.mockRestore()
    }
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

  // --- Fix round: an async onError/onRun that rejects after its own await ---
  //
  // RetentionWorkerOptions types both handlers `=> void`, but TypeScript
  // accepts an `async` function there too (it structurally returns
  // `Promise<void>`). A plain `try { handler() } catch {}` only catches a
  // throw that happens BEFORE the handler's first `await` -- a rejection
  // raised after that point arrives on a promise nobody is holding, and
  // surfaces as an `unhandledRejection` instead: `runOnce()` resolving
  // cleanly is not proof of safety here, since that is exactly what the
  // unguarded code already did while leaking. `process.on('unhandledRejection', ...)`
  // is what actually distinguishes "swallowed" from "resolved this promise,
  // rejected a different one nobody awaited."

  it('does not reject when onRun itself throws synchronously', async () => {
    await expect(
      makeWorker({
        onRun: () => {
          throw new Error('onRun exploded')
        },
      }).runOnce(),
    ).resolves.toBeUndefined()
  })

  it('a throwing onRun does not propagate to the run-level onError path', async () => {
    // If onRun's own guard were removed, its throw would propagate out of
    // the per-run body and land in runOnce's OUTER catch instead -- the same
    // one that handles listProjects failing -- which calls
    // onError(err, {}) as if this were a run-level failure. Asserting only
    // that runOnce() resolves would pass either way; asserting onError was
    // never called is what actually proves onRun's own guard caught it,
    // rather than the outer catch catching it by accident.
    const errors: { projectId?: number }[] = []
    const worker = makeWorker({
      onRun: () => {
        throw new Error('onRun exploded')
      },
      onError: (_err, ctx) => errors.push(ctx),
    })
    await expect(worker.runOnce()).resolves.toBeUndefined()
    expect(errors).toEqual([])
  })

  it('never lets an async onRun rejection (after its own await) become an unhandledRejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandledRejection = (err: unknown) => unhandled.push(err)
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const worker = makeWorker({
        onRun: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          throw new Error('onRun async handler blew up after its own await')
        },
      })
      await expect(worker.runOnce()).resolves.toBeUndefined()
      // The handler's own await is 5ms; give the rejection room to actually
      // fire and, if unguarded, surface as an unhandledRejection before
      // asserting it never did.
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('never lets an async onError rejection (after its own await) become an unhandledRejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandledRejection = (err: unknown) => unhandled.push(err)
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const worker = makeWorker({
        dropExpired: async () => {
          throw new Error('boom')
        },
        onError: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          throw new Error('onError async handler blew up after its own await')
        },
      })
      await expect(worker.runOnce()).resolves.toBeUndefined()
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })
})
