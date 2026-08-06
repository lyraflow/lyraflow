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
  const app = Fastify()
  return { readiness, buffer, counters, app }
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
      drainDeadlineMs: 5000,
      onExit: () => {},
    })

    h.buffer.add({ n: 1 })
    await shutdown()

    expect(h.readiness.draining).toBe(true)
    expect(inserted.flat()).toHaveLength(1)
    expect(h.counters.flush).toHaveBeenCalled()
  })

  it('exits non-zero when the drain deadline passes with rows still buffered', async () => {
    const h = harness(() => new Promise(() => {}))
    const exits: number[] = []
    const shutdown = installShutdownHandlers({
      app: h.app,
      readiness: h.readiness,
      buffer: asEventBuffer(h.buffer),
      counters: h.counters,
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
      drainDeadlineMs: 5000,
      onExit: () => {},
    })

    h.buffer.add({ n: 1 })
    await Promise.all([shutdown(), shutdown()])
    expect(inserted.flat()).toHaveLength(1)
  })
})
