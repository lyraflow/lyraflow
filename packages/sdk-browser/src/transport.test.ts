/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedEvent } from './payload.js'
import { EventQueue } from './queue.js'
import { QUOTA_NOTICE, Transport } from './transport.js'

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

  it('warns when a 202 says it rejected part of the batch', async () => {
    // `/v1/batch` answers 202 whatever happens to the individual events and
    // reports the split in its BODY. The transport used to remove the whole
    // batch on the status alone and never read that body — so the one signal
    // the server does send about malformed events was discarded on arrival,
    // and a page could deliver nothing at all, forever, in silence.
    const body = JSON.stringify({ accepted: 1, rejected: 1, throttled: 0 })
    const { queue, transport, warn } = make(
      vi.fn(async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
    )
    queue.add(event('m1'))
    queue.add(event('m2'))
    expect(await transport.flush()).toBe('sent')
    expect(warn.mock.calls.join(' ')).toContain('rejected 1')
    // Still removed: `rejected` means a retry would be rejected too, and
    // holding them would wedge every healthy event behind them.
    expect(queue.size()).toBe(0)
  })

  it('says nothing when a 202 rejected nothing', async () => {
    const body = JSON.stringify({ accepted: 1, rejected: 0, throttled: 0 })
    const { queue, transport, warn } = make(
      vi.fn(async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
    )
    queue.add(event('m1'))
    await transport.flush()
    expect(warn).not.toHaveBeenCalled()
  })

  it('treats a 202 with an unreadable body as a plain success', async () => {
    // A response with no body, a `json()` that throws, or a shimmed fetch
    // handing back a bare object must not turn a delivered batch into a
    // failure — this read is a feedback channel, not part of the contract.
    const hostile = {
      status: 202,
      headers: { get: () => null },
      json: () => {
        throw new Error('boom')
      },
    }
    const { queue, transport, warn } = make(vi.fn(async () => hostile) as unknown as typeof fetch)
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('sent')
    expect(queue.size()).toBe(0)
    expect(warn).not.toHaveBeenCalled()
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

  // --- A success clears the backoff -------------------------------------
  // Found on review of this task: `transport.ts`'s 202 branch resets both
  // `#failures` and `#nextAttemptAt`, and NOTHING in the package pinned
  // either. Every backoff test above arms a backoff and asserts that it
  // BLOCKS; none asserted that it ever stops blocking. Deleting both resets
  // passed the entire suite — and the consequence is not subtle: a single
  // 503 during a blip would leave the SDK in a permanent 1s -> 30s cadence
  // for the life of the tab, recovering never, with the suite green.

  it('resets the failure count on a success, so the next failure starts the backoff over', async () => {
    // #failures drives the exponential, so a lost reset shows up not on the
    // successful send but on the NEXT failure after it: a client that has
    // recovered would still be backing off as though it never had.
    vi.useFakeTimers()
    try {
      let status = 503
      const fetchImpl = vi.fn(async () => reply(status)) as unknown as typeof fetch
      const { queue, transport } = make(fetchImpl)

      // Five failures: the exponential reaches min(1000 * 2^4, 30000) = 16s.
      for (let i = 0; i < 5; i += 1) {
        queue.add(event(`f${i}`))
        expect(await transport.flush()).toBe('retry')
        // Comfortably past the longest possible delay plus its 20% jitter.
        vi.advanceTimersByTime(40_000)
      }
      expect(fetchImpl).toHaveBeenCalledTimes(5)

      // One success. This is the call that must put #failures back to zero.
      status = 202
      expect(await transport.flush()).toBe('sent')

      // Then one more failure. With the reset, this is failure #1 again and
      // the delay is BACKOFF_BASE_MS plus up to 20% jitter — under 1200ms.
      // Without it, it is failure #6: min(1000 * 2^5, 30000) = 30s, and the
      // 1300ms advance below is nowhere near enough to unblock it.
      status = 503
      queue.add(event('after'))
      expect(await transport.flush()).toBe('retry')
      expect(fetchImpl).toHaveBeenCalledTimes(7)

      vi.advanceTimersByTime(1_300)
      queue.add(event('recovered'))
      await transport.flush()
      expect(fetchImpl).toHaveBeenCalledTimes(8)
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears an armed backoff when a pagehide flush succeeds through it', async () => {
    // The other half of the reset, and the only path that reaches it with a
    // backoff window still in the FUTURE: an ordinary flush cannot succeed
    // during a backoff because the backoff short-circuits it, but a pagehide
    // flush bypasses that check by design. If `#nextAttemptAt = 0` were
    // dropped, this transport would have just delivered a batch successfully
    // and would still refuse to send anything for the remaining 30 seconds.
    let status = 503
    const fetchImpl = vi.fn(async () =>
      reply(status, { 'retry-after': '30' }),
    ) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    transport.start()
    try {
      expect(await transport.flush()).toBe('retry')
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // The unload flush bypasses the 30s window and succeeds.
      status = 202
      dispatchEvent(new Event('pagehide'))
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      // Let that fire-and-forget run settle, including its body read.
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(queue.size()).toBe(0)

      // An ORDINARY flush now reaches the network: the window the 503 armed
      // was cleared by the success, not merely bypassed once.
      queue.add(event('m2'))
      expect(await transport.flush()).toBe('sent')
      expect(fetchImpl).toHaveBeenCalledTimes(3)
    } finally {
      transport.stop()
    }
  })

  // --- Quota refusals, and the status code that is NOT one --------------
  //
  // `/v1/batch` is the ONLY URL this transport posts to (see #attempt), and
  // it never answers 429: its contract is a 202 carrying a tally, with quota
  // refusals counted in the body's `over_quota` field. The ingest's only 429
  // lives on the single-event routes, which nothing in this package calls.
  //
  // So the quota reaches the browser through a 202 BODY, never through a
  // status code. The first test below pins what a 429 therefore means here —
  // a middlebox, retried — and everything after it works the body channel.

  it('the quota notice says what the condition is and when it clears', () => {
    // Every other quota assertion in this file matches on QUOTA_NOTICE itself,
    // so without this one the whole set is satisfied by the constant being the
    // literal string 'quota' — the message could be reduced to a word and the
    // package would stay green. What the message must actually carry is the
    // two facts a developer can act on: WHICH limit was hit, and that it will
    // not clear on a retry.
    expect(QUOTA_NOTICE).toMatch(/monthly event quota/i)
    expect(QUOTA_NOTICE).toMatch(/until the month rolls over/i)
  })

  it('retries a 429 and keeps the batch, because only a middlebox can send one', async () => {
    // Load-bearing since the 429 drop branch was removed. This transport
    // posts to /v1/batch alone, and /v1/batch never answers 429 — the ingest's
    // only 429 is on the single-event routes, which nothing here calls. A 429
    // reaching this client is therefore always something in FRONT of the
    // server rate limiting the browser, which is transient and must be
    // retried.
    //
    // A revision of this file dropped it instead and blamed the project's
    // monthly quota. Both halves were wrong, and the damage was not
    // hypothetical: twelve flush cycles against a persistent 429 destroyed
    // twenty-four events and warned twelve times about a limit the project
    // was nowhere near, at full cadence, because the drop path returns before
    // reaching a backoff.
    const fetchImpl = vi.fn(async () =>
      reply(429, { 'retry-after': '5' }),
    ) as unknown as typeof fetch
    const { queue, transport, warn } = make(fetchImpl)
    queue.add(event('m1'))
    queue.add(event('m2'))

    expect(await transport.flush()).toBe('retry')
    // Kept. These events are still deliverable once the limit lifts.
    expect(queue.size()).toBe(2)
    // And not blamed on a quota this project may be nowhere near.
    expect(warn).not.toHaveBeenCalled()

    // A backoff was armed, exactly as for a 503 — the second half of the
    // damage a drop caused was that nothing throttled the retry cadence.
    expect(await transport.flush()).toBe('retry')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('warns when a 202 body says events were over quota, and still drains them', async () => {
    // THE path the real server produces. Before this, #reportBody read only
    // `rejected`: an entirely-refused batch came back 202, every event was
    // removed from the queue, and the developer was told nothing whatsoever —
    // the identical failure the `rejected` handling was added to fix, one
    // field over.
    const body = JSON.stringify({ accepted: 0, rejected: 0, throttled: 0, over_quota: 2 })
    const { queue, transport, warn } = make(
      vi.fn(async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
    )
    queue.add(event('m1'))
    queue.add(event('m2'))
    expect(await transport.flush()).toBe('sent')
    expect(warn.mock.calls.join(' ')).toContain(QUOTA_NOTICE)
    // The count, so a developer can tell "2 of 20" from "20 of 20".
    expect(warn.mock.calls.join(' ')).toContain('2 event(s)')
    // Still removed: next month is not a retry window this queue can wait
    // out, and holding them would wedge every healthy event behind them.
    expect(queue.size()).toBe(0)
  })

  it('reports over_quota on the batch that CROSSES the limit, where accepted is not zero', async () => {
    // THE shape a project is guaranteed to meet, and the one every other
    // fixture here misses. `routes.ts` walks a batch item by item and checks
    // the quota per item, so the batch that crosses the limit stores the
    // events before the crossing point and refuses the ones after it: it
    // comes back with `accepted` AND `over_quota` both non-zero. Every batch
    // afterwards is the all-refused shape, but this one comes first, and a
    // guard of `over_quota > 0 && accepted === 0` — which every other test in
    // this file would accept — would stay silent on precisely the response
    // that announces the project has run out.
    const body = JSON.stringify({ accepted: 3, rejected: 0, throttled: 0, over_quota: 2 })
    const { queue, transport, warn } = make(
      vi.fn(async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
    )
    for (let i = 0; i < 5; i += 1) queue.add(event(`m${i}`))
    expect(await transport.flush()).toBe('sent')
    expect(warn.mock.calls.join(' ')).toContain(QUOTA_NOTICE)
    expect(warn.mock.calls.join(' ')).toContain('2 event(s)')
    // The three that were stored are gone too — the whole batch leaves the
    // queue on a 202, and the report is about what happened to it, not a
    // partial retry instruction.
    expect(queue.size()).toBe(0)
  })

  it('reports a batch that is partly accepted, partly rejected and partly over quota', async () => {
    // All three at once, which the ingest can produce in a single pass: a
    // malformed event, a good one stored, and a good one refused for the
    // quota. Both reports fire, and neither swallows the other.
    const body = JSON.stringify({ accepted: 1, rejected: 1, throttled: 0, over_quota: 1 })
    const { queue, transport, warn } = make(
      vi.fn(async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
    )
    for (let i = 0; i < 3; i += 1) queue.add(event(`m${i}`))
    expect(await transport.flush()).toBe('sent')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.join(' ')).toContain('rejected 1')
    expect(warn.mock.calls.join(' ')).toContain(QUOTA_NOTICE)
    expect(queue.size()).toBe(0)
  })

  it('says nothing when a 202 reports over_quota: 0', async () => {
    // The field is ALWAYS present, even at zero (routes.ts sends a stable
    // shape on purpose). A presence check rather than a `> 0` check would
    // therefore warn about the quota on every single successful flush.
    const body = JSON.stringify({ accepted: 1, rejected: 0, throttled: 0, over_quota: 0 })
    const { queue, transport, warn } = make(
      vi.fn(async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
    )
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('sent')
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports both halves of a partly-rejected, partly-over-quota batch', async () => {
    // Invented beyond the brief: a batch can carry malformed events AND cross
    // the quota, and the two are counted separately by the ingest for exactly
    // the reason they must be reported separately here — one is the sender's
    // bug to fix, the other is their operator's limit to raise. An
    // if/else-if, or an early return after the first warn, reports one and
    // silently loses the other.
    const body = JSON.stringify({ accepted: 0, rejected: 1, throttled: 0, over_quota: 1 })
    const { queue, transport, warn } = make(
      vi.fn(async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
    )
    queue.add(event('m1'))
    queue.add(event('m2'))
    expect(await transport.flush()).toBe('sent')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.join(' ')).toContain('rejected 1')
    expect(warn.mock.calls.join(' ')).toContain(QUOTA_NOTICE)
    expect(queue.size()).toBe(0)
  })

  it('still reports over_quota when the host warn throws on the rejection report', async () => {
    // The two reports are about different events and must be independent in
    // BOTH directions. Sharing one try/catch made them serially dependent:
    // a host console handler that throws on the first message — an
    // over-eager wrapper, a logger that rejects unknown formats — took the
    // quota notice down with it, and the developer never learned the one
    // thing only their operator can fix.
    const body = JSON.stringify({ accepted: 0, rejected: 1, throttled: 0, over_quota: 1 })
    const seen: string[] = []
    const throwsOnFirst = vi.fn((message: string) => {
      seen.push(message)
      if (seen.length === 1) throw new Error('console handler blew up')
    })
    const { queue, transport } = make(
      vi.fn(async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
      throwsOnFirst,
    )
    queue.add(event('m1'))
    queue.add(event('m2'))
    expect(await transport.flush()).toBe('sent')
    expect(seen).toHaveLength(2)
    expect(seen.join(' ')).toContain(QUOTA_NOTICE)
    expect(queue.size()).toBe(0)
  })

  it('ignores a non-numeric over_quota instead of warning about it', async () => {
    // Invented beyond the brief: the body comes off the network, so a proxy
    // injecting a string, or an older server that predates the field, must
    // not produce a scary quota warning on a perfectly delivered batch.
    // `typeof === 'number'` holds this; a truthiness check does not.
    const body = JSON.stringify({ accepted: 1, rejected: 0, throttled: 0, over_quota: 'lots' })
    const { queue, transport, warn } = make(
      vi.fn(async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
    )
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('sent')
    expect(warn).not.toHaveBeenCalled()
  })

  it('still counts a 202 with over_quota as a full success and clears the backoff', async () => {
    // Invented beyond the brief: `over_quota` is REPORTED, never acted on as
    // a failure. An implementation that returned 'dropped' or entered a
    // backoff here would stop the next healthy flush — the events already
    // left the queue, and next month's traffic has to keep flowing.
    const overQuota = JSON.stringify({ accepted: 0, rejected: 0, throttled: 0, over_quota: 1 })
    let first = true
    const fetchImpl = vi.fn(async () => {
      if (first) {
        first = false
        return new Response(overQuota, { status: 202 })
      }
      return reply(202)
    }) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('sent')

    queue.add(event('m2'))
    expect(await transport.flush()).toBe('sent')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('never rejects when warn throws on the over_quota report', async () => {
    // Invented beyond the brief: #reportBody now calls warn twice, and the
    // host-supplied callback can throw. A throwing warn must not turn a
    // delivered batch into a failure — this read is a feedback channel, not
    // part of the contract.
    const body = JSON.stringify({ accepted: 0, rejected: 0, throttled: 0, over_quota: 1 })
    const { queue, transport } = make(
      vi.fn(async () => new Response(body, { status: 202 })) as unknown as typeof fetch,
      vi.fn(() => {
        throw new Error('warn blew up')
      }),
    )
    queue.add(event('m1'))
    await expect(transport.flush()).resolves.toBe('sent')
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

  it('applies backoff even on a synchronous fetch throw, not just a bare retry', async () => {
    // The outer catch added in #run (see "never rejects even when
    // queue.peek throws" etc. below) also absorbs a synchronous fetchImpl
    // throw, which means the ORIGINAL "never rejects" test above no longer
    // discriminates the try/catch-around-fetchImpl → .catch() mutation on
    // its own — that mutation still passes every test above it once the
    // outer catch exists. What it still gets wrong: replacing the try/catch
    // with `.catch()` means `.catch()` never attaches (the throw happens
    // before fetchImpl returns anything to attach it to), so `#backoff()`
    // never runs, and an immediate next flush hits the network again
    // instead of being held off. This test pins that.
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(() => {
        throw new Error('sync boom')
      }) as unknown as typeof fetch
      const { queue, transport } = make(fetchImpl)
      queue.add(event('m1'))
      expect(await transport.flush()).toBe('retry')
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // An immediate second flush must be held off by backoff, not hit the
      // network again.
      expect(await transport.flush()).toBe('retry')
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // BACKOFF_BASE_MS (1_000ms) plus up to 20% jitter — advance past the
      // worst case rather than the bare minimum, so this isn't flaky on the
      // random jitter draw.
      vi.advanceTimersByTime(1_300)
      await transport.flush()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
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

  it('backs off a 503 whose headers cannot be read, rather than hot-looping', async () => {
    // The retry-after read has its own try/catch, and only the 401 case
    // pinned it — a hostile headers object on a RETRYABLE status reaches that
    // read by a different route and nothing covered it.
    //
    // The first version of this test was dead against its own mutation.
    // Deleting the try/catch still returns 'retry' with the batch intact,
    // because #run's outer catch absorbs the throw — identical to the two
    // obvious assertions. What differs is invisible from the return value:
    // the outer catch never reaches #backoff, so NO backoff is armed and the
    // client hammers a saturated server at full cadence. The third assertion
    // below is the whole test.
    const hostile = {
      status: 503,
      headers: {
        get() {
          throw new Error('boom')
        },
      },
    } as unknown as Response
    const fetchImpl = vi.fn(async () => hostile) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    expect(await transport.flush()).toBe('retry')
    expect(queue.size()).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Held off. Without the guard this second flush reaches the network.
    expect(await transport.flush()).toBe('retry')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
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

  it('caps an absurd retry-after on a 429 too, not only on a 503', async () => {
    // The floor is pinned on both statuses; the ceiling was pinned only on
    // 503. They reach #backoff by the same call now, but "the same call now"
    // is exactly the kind of thing a later change quietly separates — and a
    // middlebox is a far more likely source of a hostile retry-after than the
    // ingest, which only ever sends `5`. A single rate limiter answering
    // `retry-after: 999999999` would otherwise switch this client off for
    // eleven days.
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () =>
        reply(429, { 'retry-after': '999999999' }),
      ) as unknown as typeof fetch
      const { queue, transport } = make(fetchImpl)
      queue.add(event('m1'))
      expect(await transport.flush()).toBe('retry')
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      vi.advanceTimersByTime(5 * 60_000 + 1)
      await transport.flush()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(queue.size()).toBe(1)
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

  // --- The guarantee covers the whole call, not only fetchImpl ----------
  // Found on review: the original try/catch only wrapped the fetchImpl call
  // and the two reads off its response. queue.peek, all three queue.remove
  // call sites, and the host-supplied `warn` callback could each throw
  // synchronously and reject flush() — an unhandled rejection on the
  // pagehide path, in the customer's page. `warn` in particular isn't
  // hypothetical: it's wired by the caller (Task 8), and `message_id` is
  // read off events this file has already established can carry throwing
  // getters on other properties.

  it('never rejects even when queue.peek throws', async () => {
    const rogueQueue = {
      peek: () => {
        throw new Error('peek exploded')
      },
      remove: () => {},
    } as unknown as EventQueue
    const transport = new Transport({
      host: 'https://a.test',
      writeKey: 'wk_test',
      queue: rogueQueue,
      warn: vi.fn(),
      fetchImpl: vi.fn(async () => reply(202)) as unknown as typeof fetch,
    })
    await expect(transport.flush()).resolves.toBe('retry')
  })

  it('never rejects even when queue.remove throws', async () => {
    // Exercises the queue.remove call on the 202 path specifically.
    const rogueQueue = {
      peek: () => [event('m1')],
      remove: () => {
        throw new Error('storage exploded')
      },
    } as unknown as EventQueue
    const transport = new Transport({
      host: 'https://a.test',
      writeKey: 'wk_test',
      queue: rogueQueue,
      warn: vi.fn(),
      fetchImpl: vi.fn(async () => reply(202)) as unknown as typeof fetch,
    })
    await expect(transport.flush()).resolves.toBe('retry')
  })

  it('never rejects even when the host-supplied warn callback throws', async () => {
    // Exercises the 400 path's warn call, after queue.remove has already
    // run — a throwing warn must not turn an already-decided drop into a
    // rejected promise.
    const throwingWarn = vi.fn(() => {
      throw new Error('warn blew up')
    })
    const { queue, transport } = make(
      vi.fn(async () => reply(400)) as unknown as typeof fetch,
      throwingWarn,
    )
    queue.add(event('m1'))
    await expect(transport.flush()).resolves.toBe('retry')
  })

  // --- In-flight guard ----------------------------------------------------
  // Found on review: queue.remove only runs after the response comes back,
  // so a second flush() arriving while one is still awaiting fetchImpl
  // would peek the same unremoved batch and send it again. Reachable
  // whenever a keepalive POST outlives the 5s interval, or a pagehide flush
  // races the timer.

  it('does not send the same batch twice when a flush is still in flight', async () => {
    const gate: { resolve?: (r: Response) => void } = {}
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          gate.resolve = resolve
        }),
    ) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))

    const first = transport.flush()
    const second = transport.flush() // races the still-pending first

    expect(await second).toBe('retry')
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    gate.resolve?.(reply(202))
    expect(await first).toBe('sent')
    expect(queue.size()).toBe(0)
  })

  // --- Backoff floor -------------------------------------------------------
  // Found on review: Math.min(Math.max(advisedMs, 0), MAX) lets an advised
  // retry-after of 0 (or negative) set the next attempt to "now", switching
  // the client's own throttle off entirely.

  it('floors an advised retry-after so a server cannot disable the client throttle', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = vi.fn(async () =>
        reply(503, { 'retry-after': '0' }),
      ) as unknown as typeof fetch
      const { queue, transport } = make(fetchImpl)
      queue.add(event('m1'))
      expect(await transport.flush()).toBe('retry')
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // Without a floor, retry-after: 0 would set the next attempt to
      // "now", and this immediate second call would hit the network again.
      expect(await transport.flush()).toBe('retry')
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // 1_000ms matches BACKOFF_BASE_MS, the floor transport.ts documents.
      vi.advanceTimersByTime(1_000)
      await transport.flush()
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // --- pagehide bypasses an active backoff; visibilitychange does not ----
  // Found on review: after one 503, the backoff short-circuits the very
  // next flush with no network attempt at all — including an unload flush,
  // the final delivery chance for a visitor who never returns. pagehide
  // gets one bypass; visibilitychange (fired on every tab switch, not only
  // real unloads) does not, or a visitor backgrounding the tab during an
  // outage would re-hammer the server on every switch.
  //
  // Both assertions below happen synchronously, with no waiting: the
  // backoff check runs before any `await` in #run/#attempt, so if the
  // dispatched event's handler is going to call fetchImpl, it already has
  // by the time dispatchEvent returns.

  it('lets a pagehide flush bypass an active backoff, since it may be the final chance to deliver', async () => {
    const fetchImpl = vi.fn(async () =>
      reply(503, { 'retry-after': '30' }),
    ) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    transport.start()
    try {
      await transport.flush() // fails, enters a 30s backoff
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // A normal flush() inside the backoff window is still blocked...
      expect(await transport.flush()).toBe('retry')
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      // ...but pagehide bypasses it and attempts the network once more.
      dispatchEvent(new Event('pagehide'))
      expect(fetchImpl).toHaveBeenCalledTimes(2)
    } finally {
      transport.stop()
    }
  })

  it('does not bypass backoff for a visibilitychange flush, only for pagehide', async () => {
    const fetchImpl = vi.fn(async () =>
      reply(503, { 'retry-after': '30' }),
    ) as unknown as typeof fetch
    const { queue, transport } = make(fetchImpl)
    queue.add(event('m1'))
    transport.start()
    try {
      await transport.flush()
      expect(fetchImpl).toHaveBeenCalledTimes(1)

      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      })
      dispatchEvent(new Event('visibilitychange'))
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    } finally {
      transport.stop()
    }
  })
})
