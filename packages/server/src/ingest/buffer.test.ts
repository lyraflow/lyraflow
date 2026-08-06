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

  it('drains everything buffered before the deadline', async () => {
    const c = collector()
    const b = new IngestBuffer<Row>({
      flushRows: 1000,
      flushIntervalMs: 60_000,
      maxRows: 100,
      insert: c.insert,
    })
    for (let n = 0; n < 10; n++) b.add({ n })
    const result = await b.drain(5000)
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
    // drain()'s deadline uses a real setTimeout under the hood, which fake
    // timers intercept: a bare `await` here would never observe it fire, so
    // we drive the clock forward explicitly to exercise the timeout path.
    const draining = b.drain(50)
    await vi.advanceTimersByTimeAsync(50)
    const result = await draining
    expect(result.dropped).toBe(1)
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
})
