import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { Readiness } from './health.js'
import { IngestBuffer } from './ingest/buffer.js'
import type { IngestCounters } from './ingest/counters.js'
import type { EventRow } from './ingest/row.js'
import { installShutdownHandlers } from './shutdown.js'

function harness(insert: (rows: unknown[]) => Promise<void>) {
  const readiness = new Readiness()
  readiness.markReady()
  const buffer = new IngestBuffer<{ n: number }>({
    flushRows: 1000,
    flushIntervalMs: 60_000,
    maxRows: 100,
    insert: insert as (rows: { n: number }[]) => Promise<void>,
  })
  const counters = { flush: vi.fn(async () => {}) } as unknown as IngestCounters
  const purge = { stop: vi.fn() }
  const retention = { stop: vi.fn() }
  const sessionSweeper = { stop: vi.fn() }
  const app = Fastify()
  return { readiness, buffer, counters, purge, retention, sessionSweeper, app }
}

// installShutdownHandlers only calls buffer.add()/drain() generically — it
// never inspects row shape — so this simplified `{ n: number }` test row is
// behaviorally safe to hand it. The cast is required because IngestBuffer's
// private fields make it nominally typed per type parameter: TypeScript
// won't structurally unify IngestBuffer<{ n: number }> with
// IngestBuffer<EventRow> even though nothing here relies on EventRow's
// shape. Mirrors the `insert` cast already used in harness() above.
function asEventBuffer(buffer: IngestBuffer<{ n: number }>): IngestBuffer<EventRow> {
  return buffer as unknown as IngestBuffer<EventRow>
}

describe('installShutdownHandlers', () => {
  it('marks draining, flushes the buffer, and closes the server', async () => {
    const inserted: unknown[][] = []
    const h = harness(async (rows) => {
      inserted.push(rows)
    })
    const shutdown = installShutdownHandlers({
      app: h.app,
      readiness: h.readiness,
      buffer: asEventBuffer(h.buffer),
      counters: h.counters,
      purge: h.purge,
      retention: h.retention,
      sessionSweeper: h.sessionSweeper,
      drainDeadlineMs: 5000,
      onExit: () => {},
    })

    h.buffer.add({ n: 1 })
    await shutdown()

    expect(h.readiness.draining).toBe(true)
    expect(inserted.flat()).toHaveLength(1)
    expect(h.counters.flush).toHaveBeenCalled()
    expect(h.purge.stop).toHaveBeenCalled()
    expect(h.retention.stop).toHaveBeenCalled()
    expect(h.sessionSweeper.stop).toHaveBeenCalled()
  })

  it('stops the retention worker beside the purge worker, before the drain completes', async () => {
    // Mirrors the purge test directly below: retention.stop() (Important 1
    // of the Task 4 fix round) must fire at the same point in shutdown that
    // purge.stop() already does, for the reason its own docstring gives —
    // bounding how much of a still-running project's drops can complete
    // with no Guard 5 log line at all.
    let releaseInsert: () => void = () => {}
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve
    })
    const h = harness(async () => {
      await insertGate
    })
    const shutdown = installShutdownHandlers({
      app: h.app,
      readiness: h.readiness,
      buffer: asEventBuffer(h.buffer),
      counters: h.counters,
      purge: h.purge,
      retention: h.retention,
      sessionSweeper: h.sessionSweeper,
      drainDeadlineMs: 5000,
      onExit: () => {},
    })

    h.buffer.add({ n: 1 })
    const shutdownPromise = shutdown()

    await Promise.resolve()
    await Promise.resolve()

    expect(h.retention.stop).toHaveBeenCalledTimes(1)
    const stillDraining = await Promise.race([
      shutdownPromise.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])
    expect(stillDraining).toBe('pending')

    releaseInsert()
    await shutdownPromise
  })

  it('stops the purge worker before the drain completes', async () => {
    // A stub worker whose stop() records when it was called, and an insert
    // that blocks on a gate this test controls — so `buffer.drain()` cannot
    // complete until the test says so. If `purge.stop()` were called AFTER
    // the drain (or not at all), the assertion below — taken while drain is
    // still genuinely in flight — would fail.
    let releaseInsert: () => void = () => {}
    const insertGate = new Promise<void>((resolve) => {
      releaseInsert = resolve
    })
    const h = harness(async () => {
      await insertGate
    })
    const shutdown = installShutdownHandlers({
      app: h.app,
      readiness: h.readiness,
      buffer: asEventBuffer(h.buffer),
      counters: h.counters,
      purge: h.purge,
      retention: h.retention,
      sessionSweeper: h.sessionSweeper,
      drainDeadlineMs: 5000,
      onExit: () => {},
    })

    h.buffer.add({ n: 1 })
    const shutdownPromise = shutdown()

    // Drain the microtask queue so shutdown() has run everything up to (and
    // including) `readiness.markDraining()`/`purge.stop()` and started
    // draining the buffer — without this, checking `purge.stop` here would
    // race the async function body rather than observe it deterministically.
    await Promise.resolve()
    await Promise.resolve()

    expect(h.purge.stop).toHaveBeenCalledTimes(1)
    // The drain is still genuinely unresolved at this point — proof that the
    // assertion above observed `purge.stop()` BEFORE the drain completed,
    // not merely before the whole shutdown() settled.
    const stillDraining = await Promise.race([
      shutdownPromise.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])
    expect(stillDraining).toBe('pending')

    releaseInsert()
    await shutdownPromise
  })

  it('exits non-zero when the drain deadline passes with rows still buffered', async () => {
    const h = harness(() => new Promise(() => {}))
    const exits: number[] = []
    const shutdown = installShutdownHandlers({
      app: h.app,
      readiness: h.readiness,
      buffer: asEventBuffer(h.buffer),
      counters: h.counters,
      purge: h.purge,
      retention: h.retention,
      sessionSweeper: h.sessionSweeper,
      drainDeadlineMs: 50,
      onExit: (code) => exits.push(code),
    })

    h.buffer.add({ n: 1 })
    await shutdown()
    expect(exits).toEqual([1])
  })

  it('is idempotent when a second signal arrives mid-drain', async () => {
    const inserted: unknown[][] = []
    const h = harness(async (rows) => {
      inserted.push(rows)
    })
    const shutdown = installShutdownHandlers({
      app: h.app,
      readiness: h.readiness,
      buffer: asEventBuffer(h.buffer),
      counters: h.counters,
      purge: h.purge,
      retention: h.retention,
      sessionSweeper: h.sessionSweeper,
      drainDeadlineMs: 5000,
      onExit: () => {},
    })

    h.buffer.add({ n: 1 })
    await Promise.all([shutdown(), shutdown()])
    expect(inserted.flat()).toHaveLength(1)
    // The row-count assertion above holds even without the memoization guard
    // in this harness — IngestBuffer.drain() is itself a no-op once its
    // queue is empty, so a second, un-memoized drain doesn't re-flush
    // anything to duplicate. This assertion is the one that actually pins
    // idempotency: counters.flush() is a plain spy with no such internal
    // idempotency of its own, so a second, un-memoized shutdown() run calls
    // it a second time and this fails at 2.
    expect(h.counters.flush).toHaveBeenCalledTimes(1)
  })
})
