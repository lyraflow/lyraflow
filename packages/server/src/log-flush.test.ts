import type { FastifyBaseLogger } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushLogger } from './log-flush.js'

// Fakes below only implement `flush` — the one method flushLogger actually
// calls — not the rest of FastifyBaseLogger's surface (info/error/etc).
// Cast through `unknown`, the same pattern this repo's other test harnesses
// already use for minimal fakes (e.g. counters.test.ts's fake Pool).
function asLogger(fake: { flush?: (cb?: (err?: Error) => void) => void }): FastifyBaseLogger {
  return fake as unknown as FastifyBaseLogger
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('flushLogger', () => {
  it("resolves as soon as flush's callback fires, without waiting for the timeout", async () => {
    let calls = 0
    const logger = asLogger({
      flush: (cb) => {
        calls++
        cb?.()
      },
    })
    const done = vi.fn()
    void flushLogger(logger, 10_000).then(done)

    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('resolves once the timeout elapses if flush never calls back, so a stalled destination cannot hang shutdown', async () => {
    const logger = asLogger({ flush: () => {} }) // never invokes its callback
    const done = vi.fn()
    void flushLogger(logger, 1000).then(done)

    await vi.advanceTimersByTimeAsync(999)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(done).toHaveBeenCalledTimes(1)
  })

  it('never rejects when flush throws synchronously', async () => {
    const logger = asLogger({
      flush: () => {
        throw new Error('boom')
      },
    })
    await expect(flushLogger(logger, 1000)).resolves.toBeUndefined()
  })

  it('resolves immediately, without waiting for the timeout, when the logger has no flush method', async () => {
    const logger = asLogger({}) // e.g. Fastify({ logger: false })'s no-op logger
    const done = vi.fn()
    void flushLogger(logger, 10_000).then(done)

    await vi.advanceTimersByTimeAsync(0)
    expect(done).toHaveBeenCalledTimes(1)
  })
})
