import { describe, expect, it, vi } from 'vitest'
import { SessionSweeper, type SessionSweeperOptions } from './sweeper.js'

function makeSweeper(overrides: Partial<SessionSweeperOptions> = {}): SessionSweeper {
  return new SessionSweeper({
    sweep: async () => 0,
    intervalMs: 60_000,
    onError: vi.fn(),
    ...overrides,
  })
}

describe('SessionSweeper', () => {
  it('returns the number of rows swept', async () => {
    const sweeper = makeSweeper({ sweep: async () => 3 })
    await expect(sweeper.runOnce()).resolves.toBe(3)
  })

  it('does not start a second run while one is in flight', async () => {
    let concurrent = 0
    let maxConcurrent = 0
    const sweeper = makeSweeper({
      sweep: async () => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 20))
        concurrent -= 1
        return 0
      },
    })
    await Promise.all([sweeper.runOnce(), sweeper.runOnce()])
    expect(maxConcurrent).toBe(1)
  })

  // --- sweep() failing: runOnce is driven fire-and-forget from setInterval,
  // so a rejection here becomes an unhandled rejection and takes the process
  // down. Both stubs below are caught by the SAME try/catch in runOnce (the
  // one wrapping `await this.opts.sweep()`) -- unlike the onError cases
  // below, there is only one guard here, not two, so a mutation that removes
  // it fails both of the next two tests together. See the report for the
  // mutation-testing note on this.

  it('never rejects, and reports the error through onError, when sweep() throws synchronously', async () => {
    const errors: unknown[] = []
    const sweeper = makeSweeper({
      // Not even `async` -- calling this throws immediately, before any
      // `await`/`.then`/`.catch` could ever attach to it. `p.catch()` cannot
      // absorb a throw like this; only a `try` around the call can.
      sweep: (() => {
        throw new Error('sync boom')
      }) as unknown as SessionSweeperOptions['sweep'],
      onError: (err) => errors.push(err),
    })
    await expect(sweeper.runOnce()).resolves.toBe(0)
    expect(errors).toEqual([expect.objectContaining({ message: 'sync boom' })])
  })

  it('never rejects, and reports the error through onError, when sweep() returns a rejected promise', async () => {
    const errors: unknown[] = []
    const sweeper = makeSweeper({
      sweep: async () => {
        throw new Error('async boom')
      },
      onError: (err) => errors.push(err),
    })
    await expect(sweeper.runOnce()).resolves.toBe(0)
    expect(errors).toEqual([expect.objectContaining({ message: 'async boom' })])
  })

  // --- onError itself misbehaving: the case worker.ts's docstring records
  // as having been got wrong before (a synchronous throw) and the case it
  // says was only ever found live (an async rejection after the handler's
  // own await). These two are independent guards inside #invokeHandler --
  // see the mutation-testing note in the report for why each is verified in
  // isolation.

  it('does not reject when onError itself throws synchronously', async () => {
    // A broken error handler must not be able to take runOnce() down with
    // it -- the same "logger exploded" case RetentionWorker pins.
    const sweeper = makeSweeper({
      sweep: async () => {
        throw new Error('boom')
      },
      onError: () => {
        throw new Error('logger exploded')
      },
    })
    await expect(sweeper.runOnce()).resolves.toBe(0)
  })

  it('never lets an async onError rejection (after its own await) become an unhandledRejection', async () => {
    // onError is typed `(err: unknown) => void`, but that is a structural
    // TypeScript type -- an `async` function satisfies it fine, and nothing
    // stops a caller from passing one. A plain `try { onError(err) } catch
    // {}` only catches a throw that happens BEFORE the handler's first
    // `await`; a rejection raised after that point arrives on a promise
    // nobody is holding, and surfaces as `unhandledRejection` instead --
    // `runOnce()` resolving cleanly is not proof of safety here, since that
    // is exactly what the unguarded code already did while leaking.
    const unhandled: unknown[] = []
    const onUnhandledRejection = (err: unknown) => unhandled.push(err)
    process.on('unhandledRejection', onUnhandledRejection)
    try {
      const sweeper = makeSweeper({
        sweep: async () => {
          throw new Error('boom')
        },
        onError: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          throw new Error('onError async handler blew up after its own await')
        },
      })
      await expect(sweeper.runOnce()).resolves.toBe(0)
      // The handler's own await is 5ms; give the rejection room to actually
      // fire and, if unguarded, surface as an unhandledRejection before
      // asserting it never did.
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandledRejection)
    }
  })

  // --- The rest of the contract, mirrored from retention/worker.test.ts ---

  it('running reflects whether a live timer is installed', () => {
    const sweeper = makeSweeper()
    expect(sweeper.running).toBe(false)
    sweeper.start()
    expect(sweeper.running).toBe(true)
    sweeper.stop()
    expect(sweeper.running).toBe(false)
  })

  it('stop() prevents further runs, and start() after stop() resumes', async () => {
    let calls = 0
    const sweeper = makeSweeper({
      sweep: async () => {
        calls += 1
        return 0
      },
    })
    sweeper.stop()
    await sweeper.runOnce()
    expect(calls).toBe(0)
    sweeper.start()
    await sweeper.runOnce()
    expect(calls).toBe(1)
    sweeper.stop()
  })

  it('start() drives runOnce on its own interval, not merely installs a timer', async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const sweeper = makeSweeper({
        sweep: async () => {
          calls += 1
          return 0
        },
      })
      sweeper.start()
      // No leading-edge run: setInterval fires first at intervalMs.
      expect(calls).toBe(0)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(1)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(2)

      sweeper.stop()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(calls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

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

    const sweeper = makeSweeper()
    try {
      sweeper.start()
      expect(unrefCalled).toBe(true)
    } finally {
      sweeper.stop()
      setIntervalSpy.mockRestore()
    }
  })

  it('start() is idempotent: a second call does not install a second interval', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const sweeper = makeSweeper()
    try {
      sweeper.start()
      sweeper.start()
      expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    } finally {
      sweeper.stop()
      setIntervalSpy.mockRestore()
    }
  })
})
