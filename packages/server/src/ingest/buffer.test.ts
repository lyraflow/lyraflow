import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IngestBuffer } from './buffer.js'

interface Row {
  n: number
}

function collector() {
  const inserted: Row[][] = []
  return {
    inserted,
    insert: async (rows: Row[]) => {
      inserted.push(rows)
    },
  }
}

/**
 * Like `collector()`, but each `insert()` call returns a promise that only
 * settles when the test explicitly calls `resolveNext()`. This is what makes
 * it possible to prove that a caller (e.g. `drain`) is actually waiting for
 * the insert to finish, rather than just moving on because the collector
 * happened to resolve synchronously.
 */
function deferredCollector() {
  const inserted: Row[][] = []
  const pending: Array<() => void> = []
  return {
    inserted,
    insert: (rows: Row[]) =>
      new Promise<void>((resolve) => {
        pending.push(() => {
          inserted.push(rows)
          resolve()
        })
      }),
    resolveNext: () => {
      const next = pending.shift()
      if (!next) throw new Error('no pending insert to resolve')
      next()
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('IngestBuffer', () => {
  it('flushes when the row threshold is reached', async () => {
    const c = collector()
    const b = new IngestBuffer<Row>({
      flushRows: 3,
      flushIntervalMs: 1000,
      maxRows: 100,
      insert: c.insert,
    })
    b.add({ n: 1 })
    b.add({ n: 2 })
    expect(c.inserted).toHaveLength(0)
    b.add({ n: 3 })
    await vi.waitFor(() => expect(c.inserted).toHaveLength(1))
    expect(c.inserted[0]).toHaveLength(3)
  })

  it('flushes on the interval even when the batch is small', async () => {
    const c = collector()
    const b = new IngestBuffer<Row>({
      flushRows: 100,
      flushIntervalMs: 1000,
      maxRows: 100,
      insert: c.insert,
    })
    b.add({ n: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.inserted).toEqual([[{ n: 1 }]])
  })

  it('reports overloaded rather than growing past maxRows', () => {
    const b = new IngestBuffer<Row>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 2,
      insert: async () => {},
    })
    expect(b.add({ n: 1 })).toBe('accepted')
    expect(b.add({ n: 2 })).toBe('accepted')
    expect(b.add({ n: 3 })).toBe('overloaded')
    expect(b.depth).toBe(2)
  })

  it('reports overloaded once in-flight rows plus queued rows reach maxRows', () => {
    // flushRows sits well below maxRows, unlike the test above — the one
    // arrangement where a buffer that only checks #rows.length against
    // maxRows would never reach 'overloaded' at all, because rows keep
    // detaching into (unbounded, in this buggy version) in-flight batches
    // before #rows itself gets big enough.
    const b = new IngestBuffer<Row>({
      flushRows: 2,
      flushIntervalMs: 60_000,
      maxRows: 4,
      insert: () => new Promise(() => {}), // never resolves — a stuck ClickHouse
    })
    expect(b.add({ n: 1 })).toBe('accepted')
    expect(b.add({ n: 2 })).toBe('accepted') // hits flushRows; batch detaches into #inFlight
    expect(b.depth).toBe(2) // still held in memory — must still count
    expect(b.add({ n: 3 })).toBe('accepted')
    expect(b.add({ n: 4 })).toBe('accepted') // second batch also detaches into #inFlight
    expect(b.depth).toBe(4)
    expect(b.add({ n: 5 })).toBe('overloaded')
    expect(b.depth).toBe(4)
  })

  it('drains everything buffered before the deadline, waiting for the insert to actually settle', async () => {
    const c = deferredCollector()
    const b = new IngestBuffer<Row>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: c.insert,
    })
    for (let n = 0; n < 10; n++) b.add({ n })

    let settled = false
    const draining = b.drain(5000).then((result) => {
      settled = true
      return result
    })

    // Nothing else is pending, so if drain() resolved without truly waiting
    // for the insert to finish, `settled` would already be true here.
    await Promise.resolve()
    expect(settled).toBe(false)

    c.resolveNext()
    const result = await draining

    expect(settled).toBe(true)
    expect(result).toEqual({ flushed: 10, dropped: 0 })
    expect(c.inserted.flat()).toHaveLength(10)
    expect(b.depth).toBe(0)
  })

  it('rejects new rows once draining has started', async () => {
    const b = new IngestBuffer<Row>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: async () => {},
    })
    b.add({ n: 1 })
    const draining = b.drain(5000)
    expect(b.add({ n: 2 })).toBe('overloaded')
    await draining
  })

  it('reports rows it could not flush before the deadline instead of hanging', async () => {
    const b = new IngestBuffer<Row>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: () => new Promise(() => {}), // never resolves
    })
    b.add({ n: 1 })
    // drain()'s deadline is itself driven by a setTimeout, so fake timers
    // intercept it too: a bare `await` here would never observe it fire, so
    // we drive the clock forward explicitly to exercise the timeout path.
    const draining = b.drain(50)
    await vi.advanceTimersByTimeAsync(50)
    const result = await draining
    expect(result.dropped).toBe(1)
  })

  it('accounts for rows already in flight when draining, not just rows still queued', async () => {
    const b = new IngestBuffer<Row>({
      flushRows: 3,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: () => new Promise(() => {}), // never resolves
    })
    b.add({ n: 1 })
    b.add({ n: 2 })
    b.add({ n: 3 }) // hits flushRows; this batch of 3 is now in-flight, hung forever
    b.add({ n: 4 })
    b.add({ n: 5 }) // still queued when drain() is called

    const draining = b.drain(1000)
    await vi.advanceTimersByTimeAsync(1000)
    const result = await draining

    // A buffer that only snapshots #rows.length before draining would report
    // dropped: 2 here (just rows 4 and 5) and silently lose the 3 rows that
    // had already detached into an in-flight batch.
    expect(result).toEqual({ flushed: 0, dropped: 5 })
  })

  it('drain correctly totals flushed rows across a batch already in flight and the final batch', async () => {
    const c = deferredCollector()
    const b = new IngestBuffer<Row>({
      flushRows: 3,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: c.insert,
    })
    b.add({ n: 1 })
    b.add({ n: 2 })
    b.add({ n: 3 }) // hits flushRows; this batch of 3 is now in-flight
    b.add({ n: 4 })
    b.add({ n: 5 }) // still queued when drain() is called

    const draining = b.drain(5000)
    // Two inserts are now pending: the batch of 3 that was already in
    // flight, and the batch of 2 that drain() flushed on entry. A buffer
    // that mis-derives `flushed` from the pre-drain #rows.length snapshot
    // (2, not 5) would report the wrong total even though every row made it.
    c.resolveNext()
    c.resolveNext()
    const result = await draining

    expect(result).toEqual({ flushed: 5, dropped: 0 })
    expect(c.inserted.flat()).toHaveLength(5)
  })

  it('keeps accepting after an insert failure and reports it', async () => {
    const errors: unknown[] = []
    const b = new IngestBuffer<Row>({
      flushRows: 1,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: async () => {
        throw new Error('clickhouse down')
      },
      onError: (e) => errors.push(e),
    })
    b.add({ n: 1 })
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(b.add({ n: 2 })).toBe('accepted')
  })

  it('keeps accepting after insert throws synchronously instead of returning a rejected promise', async () => {
    const errors: unknown[] = []
    const b = new IngestBuffer<Row>({
      flushRows: 1,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: (_rows: Row[]): Promise<void> => {
        throw new Error('client not connected') // synchronous throw, not a rejected promise
      },
      onError: (e) => errors.push(e),
    })
    b.add({ n: 1 })
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(b.add({ n: 2 })).toBe('accepted')
  })

  it('flush waits for a batch that already detached into #inFlight via the row threshold', async () => {
    // With flushRows: 1, add() itself triggers the flush synchronously —
    // by the time add() returns, the row has already moved out of #rows and
    // into #inFlight, with its insert() call started. A flush() that only
    // re-checks #rows (and finds it empty) would resolve immediately without
    // ever waiting for that insert to actually land — exactly the bug this
    // proves against, using a real integration path: an ingest route
    // configured with flushRows: 1, POST an event, then call flush() and
    // expect the row to be queryable.
    let resolveInsertStarted!: () => void
    const insertStarted = new Promise<void>((resolve) => {
      resolveInsertStarted = resolve
    })
    let resolveGate!: () => void
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve
    })

    const b = new IngestBuffer<Row>({
      flushRows: 1,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: async () => {
        resolveInsertStarted()
        await gate
      },
    })

    b.add({ n: 1 }) // hits flushRows immediately; detaches into #inFlight, insert() begins
    await insertStarted // insert() has started and is now blocked on `gate`

    let settled = false
    const flushing = b.flush().then(() => {
      settled = true
    })

    // Pump far more microtask ticks than a buggy flush() (which resolves in
    // a handful of chained promise ticks with no dependency on `gate`) would
    // ever need, so this isn't a race against the fix — it's conclusive.
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(settled).toBe(false)

    resolveGate()
    await flushing
    expect(settled).toBe(true)
  })

  it('flush settles normally even if onError itself throws', async () => {
    const b = new IngestBuffer<Row>({
      flushRows: 1000, // call flush() ourselves instead of relying on the trigger
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: async () => {
        throw new Error('clickhouse down')
      },
      onError: () => {
        throw new Error('logging backend also down')
      },
    })
    b.add({ n: 1 })
    await expect(b.flush()).resolves.toBeUndefined()
  })

  it('drain still returns a result even if onError itself throws', async () => {
    const b = new IngestBuffer<Row>({
      flushRows: 1,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: async () => {
        throw new Error('clickhouse down')
      },
      onError: () => {
        throw new Error('logging backend also down')
      },
    })
    b.add({ n: 1 })
    const result = await b.drain(1000)
    expect(result).toEqual({ flushed: 0, dropped: 1 })
  })

  it('drops in-flight rows from depth once their insert settles', async () => {
    const c = deferredCollector()
    const b = new IngestBuffer<Row>({
      flushRows: 1,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: c.insert,
    })
    b.add({ n: 1 }) // hits flushRows immediately; batch detaches into #inFlight
    expect(b.depth).toBe(1)
    c.resolveNext()
    await vi.waitFor(() => expect(b.depth).toBe(0))
  })
})
