/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedEvent } from './payload.js'
import { EventQueue } from './queue.js'
import { Transport } from './transport.js'

const event = (id: string): QueuedEvent => ({
  type: 'track',
  message_id: id,
  timestamp: new Date().toISOString(),
  anonymous_id: 'anon-1',
  context: {},
  event: 'x',
})

const reply = (status: number, headers: Record<string, string> = {}) =>
  new Response('{}', { status, headers })

/**
 * `noUncheckedIndexedAccess` in this repo's tsconfig types `arr[i]` as
 * possibly `undefined`, and Biome's `noNonNullAssertion` forbids silencing
 * that with `!` — the brief's own version of these tests uses `!` and
 * satisfies neither. Throwing on a missing element is exactly as fine for a
 * test precondition and keeps both rules honoured.
 */
function nth<T>(arr: readonly T[], i: number): T {
  const v = arr[i]
  if (v === undefined) throw new Error(`expected an element at index ${i}, got none`)
  return v
}

function make(fetchImpl: typeof fetch, warn = vi.fn()) {
  const queue = new EventQueue()
  const transport = new Transport({
    host: 'https://a.test',
    writeKey: 'wk_test',
    queue,
    warn,
    fetchImpl,
  })
  return { queue, transport, warn }
}

describe('Transport', () => {
  beforeEach(() => localStorage.clear())

  it('posts a batch with the write key in a header', async () => {
    // NOT sendBeacon: it cannot set headers, which would force the ingest to
    // accept a key in the query string — a second auth path on a public
    // endpoint. keepalive survives unload AND keeps the header.
    const fetchImpl = vi.fn(async () => reply(202)) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    await transport.flush()

    const [url, init] = nth((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls, 0)
    expect(url).toBe('https://a.test/v1/batch')
    expect((init as RequestInit).keepalive).toBe(true)
    expect(
      (init as RequestInit & { headers: Record<string, string> }).headers['x-lyraflow-write-key'],
    ).toBe('wk_test')
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      batch: [expect.objectContaining({ message_id: 'm1' })],
    })
  })

  it('removes events from the queue on 202', async () => {
    const { queue, transport } = make(vi.fn(async () => reply(202)) as unknown as typeof fetch)
    queue.add(event('m1'))
    await transport.flush()
    expect(queue.size()).toBe(0)
  })

  it('keeps events on 503 and reports retry', async () => {
    const { queue, transport } = make(
      vi.fn(async () => reply(503, { 'retry-after': '5' })) as unknown as typeof fetch,
    )
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('retry')
    expect(queue.size()).toBe(1)
  })

  it('keeps events when the network fails outright', async () => {
    const { queue, transport } = make(
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }) as unknown as typeof fetch,
    )
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('retry')
    expect(queue.size()).toBe(1)
  })

  it('stops permanently on 401 and warns', async () => {
    // The key is wrong. Retrying forever hammers someone's server for nothing.
    const fetchImpl = vi.fn(async () => reply(401)) as unknown as typeof fetch
    const { queue, transport, warn } = make(fetchImpl)
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('stopped')
    expect(transport.isStopped()).toBe(true)
    expect(warn.mock.calls.join(' ')).toContain('write key')

    queue.add(event('m2'))
    await transport.flush()
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('drops the batch on 400, because retrying will not help', async () => {
    const { queue, transport } = make(vi.fn(async () => reply(400)) as unknown as typeof fetch)
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('dropped')
    expect(queue.size()).toBe(0)
  })

  it('drops a batch it cannot serialise instead of retrying it forever', async () => {
    // A poison pill. An event whose property getter throws also throws inside
    // JSON.stringify — and because that call sits in the same try as the fetch,
    // the naive handling is 'retry', which puts the SAME unserialisable event
    // back at the head of the queue on every flush. One bad event then blocks
    // every subsequent one, permanently, with nothing reporting it.
    //
    // Added after Task 4's review found validateEvent throwing on the same
    // shape. Validation warns and sends; the transport is where the event is
    // finally unsendable, so this is where it must be discarded.
    const fetchImpl = vi.fn(async () => reply(202)) as unknown as typeof fetch
    const { queue, transport, warn } = make(fetchImpl)
    const poison = event('poison')
    Object.defineProperty(poison, 'properties', {
      enumerable: true,
      get() {
        throw new Error('unserialisable')
      },
    })
    queue.add(poison)
    queue.add(event('healthy'))

    expect(await transport.flush()).toBe('dropped')
    expect(warn.mock.calls.join(' ')).toContain('could not be serialised')
    expect(fetchImpl).not.toHaveBeenCalled()

    // And the queue is not wedged: the healthy event still goes.
    expect(await transport.flush()).toBe('sent')
    expect(queue.size()).toBe(0)

    // Not just "the queue ended up empty" — that would also be true of a
    // naive implementation that drops the ENTIRE batch (poison AND healthy
    // together) on the first flush, in which case the second flush would
    // see an empty queue and return 'sent' without ever calling fetchImpl.
    // Assert the healthy event was actually delivered: this is the one call
    // fetchImpl received across both flushes, and its body carries exactly
    // the survivor, not the casualty.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const sentBody = JSON.parse(
      (nth(nth((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls, 0), 1) as RequestInit)
        .body as string,
    )
    expect(sentBody.batch).toHaveLength(1)
    expect(sentBody.batch[0].message_id).toBe('healthy')
  })

  it('never rejects, even when fetch throws synchronously', async () => {
    // A flush is fired from a timer and from pagehide; a rejection there is an
    // unhandled rejection in the customer's page.
    const { queue, transport } = make((() => {
      throw new Error('sync boom')
    }) as unknown as typeof fetch)
    queue.add(event('m1'))
    await expect(transport.flush()).resolves.toBe('retry')
  })

  it('sends at most one batch worth at a time', async () => {
    const fetchImpl = vi.fn(async () => reply(202)) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    for (let i = 0; i < 25; i += 1) queue.add(event(`m${i}`))
    await transport.flush()
    const body = JSON.parse(
      (nth(nth((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls, 0), 1) as RequestInit)
        .body as string,
    )
    expect(body.batch).toHaveLength(20)
    expect(queue.size()).toBe(5)
  })

  it('does nothing when the queue is empty', async () => {
    const fetchImpl = vi.fn(async () => reply(202)) as unknown as typeof fetch
    const { transport } = make(fetchImpl)
    await transport.flush()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  // --- Hostile responses -----------------------------------------------
  // The brief names a missing retry-after, a non-numeric one, an unexpected
  // status, a non-JSON body, and a throwing headers.get as in-scope. The
  // body is never parsed by this transport, so that one is moot by
  // construction; the rest are covered below, plus a couple more of the
  // same shape.

  it('classifies a 401 correctly even when reading its headers throws', async () => {
    const hostile = {
      status: 401,
      headers: {
        get() {
          throw new Error('boom')
        },
      },
    } as unknown as Response
    const fetchImpl = vi.fn(async () => hostile) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('stopped')
    expect(transport.isStopped()).toBe(true)
  })

  it('treats a non-numeric retry-after as no advice, without crashing', async () => {
    const fetchImpl = vi.fn(async () =>
      reply(503, { 'retry-after': 'soon' }),
    ) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('retry')
    expect(queue.size()).toBe(1)
  })

  it('treats a missing retry-after as no advice, without crashing', async () => {
    const fetchImpl = vi.fn(async () => reply(503)) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('retry')
    expect(queue.size()).toBe(1)
  })

  it('treats a status it has no rule for as a transient failure, not a crash', async () => {
    const fetchImpl = vi.fn(async () => reply(418)) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('retry')
    expect(queue.size()).toBe(1)
  })

  it('treats a non-Response resolution as a transient failure, not a crash', async () => {
    const fetchImpl = vi.fn(async () => undefined) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('retry')
    expect(queue.size()).toBe(1)
  })

  it('caps an absurd server-advised retry-after instead of honouring it for days', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () =>
        reply(503, { 'retry-after': '999999999' }),
      ) as unknown as typeof fetch
      const { queue, transport } = make(fetchImpl)
      queue.add(event('m1'))
      expect(await transport.flush()).toBe('retry')
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // A literal 999,999,999 seconds is ~11.5 days away. If it were
      // honoured verbatim, advancing 5 minutes would not be enough to
      // unblock a second attempt — the ceiling this file documents means
      // it is.
      vi.advanceTimersByTime(5 * 60_000 + 1)
      await transport.flush()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('start() is idempotent and stop() removes exactly the listeners it added', () => {
    const addSpy = vi.spyOn(globalThis, 'addEventListener')
    const removeSpy = vi.spyOn(globalThis, 'removeEventListener')
    const { transport } = make(vi.fn(async () => reply(202)) as unknown as typeof fetch)

    transport.start()
    transport.start()
    expect(addSpy).toHaveBeenCalledTimes(2) // pagehide + visibilitychange, once each

    transport.stop()
    expect(removeSpy).toHaveBeenCalledTimes(2)

    // A restart after stop() doesn't pile a second pair on top of a first
    // pair stop() failed to remove.
    transport.start()
    expect(addSpy).toHaveBeenCalledTimes(4)
    transport.stop()

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })
})
