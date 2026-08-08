/** @vitest-environment happy-dom */
// Test files run in Node and are never bundled, so importing core here is
// free — unlike runtime code, where a value import from core fails the
// bundle outright.
import { MAX_CLOCK_SKEW_MS } from '@lyraflow/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { QueuedEvent } from './payload.js'
import { EventQueue, MAX_EVENT_AGE_MS, MAX_QUEUE_EVENTS, STORAGE_KEY } from './queue.js'

const at = (iso: string, id = iso): QueuedEvent => ({
  type: 'track',
  message_id: id,
  timestamp: iso,
  anonymous_id: 'anon-1',
  context: {},
  event: 'x',
})
const nowIso = () => new Date().toISOString()
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
const hoursAhead = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

describe('EventQueue', () => {
  beforeEach(() => localStorage.clear())

  it('survives a reload through localStorage', () => {
    new EventQueue().add(at(nowIso(), 'm1'))
    expect(new EventQueue().peek(10).map((e) => e.message_id)).toEqual(['m1'])
  })

  it('drops events older than the age cap rather than sending them', () => {
    // Past 24h the ingest clamps every retry to a DIFFERENT instant, so the
    // replays never collapse, land as permanent extra rows, and are misdated to
    // the clamp boundary — with nothing reporting it. 23h leaves margin so an
    // event cannot cross the line while in flight.
    const q = new EventQueue()
    q.add(at(hoursAgo(24), 'old'))
    q.add(at(hoursAgo(1), 'fresh'))
    expect(q.peek(10).map((e) => e.message_id)).toEqual(['fresh'])
    expect(q.expiredCount()).toBe(1)
  })

  it('drops an aged event that expires while sitting in the queue', () => {
    const q = new EventQueue()
    q.add(at(hoursAgo(22.9), 'edge'))
    expect(q.peek(10)).toHaveLength(1)
    // Re-read from storage with the clock effectively advanced past the cap.
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...at(hoursAgo(23.5), 'edge') }]))
    expect(new EventQueue().peek(10)).toHaveLength(0)
  })

  it('drops events timestamped implausibly far in the future, not only stale ones', () => {
    // The age cap is symmetric with the ingest's clamp, which clamps a
    // client timestamp too far AHEAD of server time exactly as readily as
    // one too far behind it — and the future side is worse to miss: a
    // future-dated event's timestamp never "ages into" validity on its own
    // (real time has to catch up days of drift), so an unfiltered one would
    // sit at the head of the queue for the life of the queue, get clamped
    // to a different instant on every retry, and land as a permanent extra
    // row each time. A device clock running days fast, later corrected by
    // NTP, is the ordinary way here — nothing exotic.
    localStorage.setItem(STORAGE_KEY, JSON.stringify([at(hoursAhead(5 * 24), 'from-the-future')]))
    const q = new EventQueue()
    expect(q.peek(10)).toHaveLength(0)
    expect(q.expiredCount()).toBe(1)
  })

  it('pins the margin to exactly one hour under the ingest clock-skew clamp', () => {
    // The two boundary tests above only pin MAX_EVENT_AGE_MS to a
    // 36-minute-wide range (22.9h passes, 23.5h fails) — a value like
    // 23.4h leaves both, and every other test in this file, green. The "one
    // hour of margin so an event can't cross the clamp line in flight"
    // rationale otherwise lives only in a comment. This is the house
    // pattern from validate.test.ts: duplicate the constant (runtime code
    // can't import core as a value — see MAX_EVENT_AGE_MS's own comment),
    // and assert the two stay related here, where importing core is free.
    expect(MAX_CLOCK_SKEW_MS - MAX_EVENT_AGE_MS).toBe(60 * 60 * 1000)
  })

  it('bounds the queue, dropping oldest first', () => {
    const q = new EventQueue()
    for (let i = 0; i < MAX_QUEUE_EVENTS + 10; i += 1) q.add(at(nowIso(), `m${i}`))
    expect(q.size()).toBe(MAX_QUEUE_EVENTS)
    expect(q.peek(1)[0]?.message_id).toBe('m10')
  })

  it('removes only what was sent', () => {
    const q = new EventQueue()
    q.add(at(nowIso(), 'a'))
    q.add(at(nowIso(), 'b'))
    q.remove(['a'])
    expect(q.peek(10).map((e) => e.message_id)).toEqual(['b'])
  })

  it('keeps working when localStorage throws on write', () => {
    // Quota exceeded, private modes, storage disabled by policy. A tracking
    // library that breaks the host app is worse than one that loses data.
    //
    // Patches the `localStorage` INSTANCE, not `Storage.prototype`. The
    // brief's own text patches the prototype, and that reads as the more
    // natural mock — but in happy-dom it silently stops taking effect the
    // moment any earlier test in this file has already called the real
    // `setItem` once: this file's own tests 1-5 all do, so by the time this
    // test runs, `Storage.prototype.setItem = () => { throw }` no longer
    // reaches the calls `writeStore` makes. The assertion still passes
    // either way (a working try/catch tolerates a mock that never fires, as
    // much as one that does), so the test looked green and proven with the
    // brief's exact code while actually asserting nothing — proven by
    // deliberately deleting writeStore's try/catch and watching this
    // version of the test (and only this one) go red for it, where the
    // prototype-patched version stayed green. See the report for the
    // reproduction.
    const original = localStorage.setItem
    Object.defineProperty(localStorage, 'setItem', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('QuotaExceededError')
      },
    })
    try {
      const q = new EventQueue()
      expect(() => q.add(at(nowIso(), 'm1'))).not.toThrow()
      expect(q.peek(10)).toHaveLength(1)
    } finally {
      Object.defineProperty(localStorage, 'setItem', {
        configurable: true,
        writable: true,
        value: original,
      })
    }
  })

  it('ignores corrupt stored data instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, 'not json{')
    expect(() => new EventQueue()).not.toThrow()
    expect(new EventQueue().peek(10)).toHaveLength(0)
  })

  // Everything below goes beyond the brief: localStorage is adversarial, not
  // merely unreliable, and nothing it returns — or does — may crash the SDK.

  it('keeps working when localStorage throws on read', () => {
    // The brief's throw-on-write test doesn't cover getItem, but readStore
    // wraps `localStorage.getItem(...)` in the same try/catch — a private
    // mode or hardened-policy browser can refuse a read just as easily as a
    // write, and construction must not raise for it. Same instance-patch
    // reasoning as the write test above.
    const original = localStorage.getItem
    Object.defineProperty(localStorage, 'getItem', {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('SecurityError')
      },
    })
    try {
      expect(() => new EventQueue()).not.toThrow()
      expect(new EventQueue().peek(10)).toHaveLength(0)
    } finally {
      Object.defineProperty(localStorage, 'getItem', {
        configurable: true,
        writable: true,
        value: original,
      })
    }
  })

  it('keeps working when localStorage is unavailable entirely', () => {
    // Storage disabled by embedder policy, or absent in the global scope
    // altogether — referencing the identifier itself throws, not just a
    // method call on it. That reference sits inside readStore's own try
    // block, so this should behave exactly like a throwing getItem.
    vi.stubGlobal('localStorage', undefined)
    try {
      expect(() => new EventQueue()).not.toThrow()
      const q = new EventQueue()
      expect(() => q.add(at(nowIso(), 'm1'))).not.toThrow()
      expect(q.peek(10).map((e) => e.message_id)).toEqual(['m1'])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ignores valid JSON that is not an array instead of throwing', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }))
    expect(() => new EventQueue()).not.toThrow()
    expect(new EventQueue().peek(10)).toHaveLength(0)
  })

  it('ignores an array of nulls instead of crashing', () => {
    // A null array element is the case the reference readStore in the brief
    // misses: #prune reads `.timestamp` off every element, and property
    // access on null always throws — so an unfiltered null here would crash
    // the constructor outright rather than degrade gracefully.
    localStorage.setItem(STORAGE_KEY, JSON.stringify([null, null, null]))
    expect(() => new EventQueue()).not.toThrow()
    expect(new EventQueue().peek(10)).toHaveLength(0)
  })

  it('ignores an array mixing primitives, nulls, and a real event', () => {
    const good = at(nowIso(), 'ok')
    localStorage.setItem(STORAGE_KEY, JSON.stringify([null, 'garbage', 42, true, good]))
    const q = new EventQueue()
    expect(q.peek(10).map((e) => e.message_id)).toEqual(['ok'])
  })

  it('drops a stored event whose timestamp is not a valid date', () => {
    // A non-string or unparsable timestamp must not throw. readStore's shape
    // filter rejects it at the door — it never reaches #prune's Date.parse
    // at all — so this pins the observable behaviour (gone, no crash)
    // rather than which layer does the dropping.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ ...at(nowIso(), 'bad'), timestamp: 'not-a-date' }]),
    )
    expect(() => new EventQueue()).not.toThrow()
    expect(new EventQueue().peek(10)).toHaveLength(0)
  })

  it('ignores a stored event with no message_id instead of returning something unremovable', () => {
    // peek() guarantees "will not throw", not "is a real event" — a filter
    // that only checked object-and-non-null let this kind of entry through:
    // indistinguishable from a real event to a caller, and `remove()` can
    // never clear it (Set.has needs the exact message_id it was given).
    // JSON.stringify drops the key outright, but a hand-edited or
    // partially-written storage value is exactly the adversarial case this
    // queue has to assume.
    const { message_id: _drop, ...rest } = at(nowIso(), 'x')
    localStorage.setItem(STORAGE_KEY, JSON.stringify([rest]))
    expect(new EventQueue().peek(10)).toHaveLength(0)
  })

  it('ignores a stored event whose message_id is not a string', () => {
    // An object message_id would never equal a string a real caller passes
    // to remove() — same unremovable failure mode as a missing one.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ ...at(nowIso(), 'x'), message_id: { evil: 1 } }]),
    )
    expect(new EventQueue().peek(10)).toHaveLength(0)
  })

  it('ignores a stored event with an empty string message_id', () => {
    // typeof '' === 'string' passes a check that only tests the type, not
    // the value — and an empty id is exactly the failure class the
    // non-empty rule exists to close: real ids are never empty, so nothing
    // in the normal flow can ever match one to remove it.
    const good = at(nowIso(), 'ok')
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ ...at(nowIso(), ''), event: 'ghost' }, good]),
    )
    expect(new EventQueue().peek(10).map((e) => e.message_id)).toEqual(['ok'])
  })

  it('does not let two distinct events colliding on an empty message_id survive to be removed as one', () => {
    // The sharper edge: message_id: '' isn't just unremovable, it's
    // ambiguous. Two different corrupt entries that both land on '' would
    // be indistinguishable to remove() — a single remove(['']) would clear
    // both as though they were the same event. Requiring non-empty keeps
    // either from ever entering the queue, so there's nothing left for one
    // remove() call to (mis)match against.
    const first = { ...at(nowIso(), ''), event: 'first' }
    const second = { ...at(nowIso(), ''), event: 'second' }
    localStorage.setItem(STORAGE_KEY, JSON.stringify([first, second]))
    const q = new EventQueue()
    expect(q.size()).toBe(0)
    q.remove([''])
    expect(q.size()).toBe(0)
  })

  it('counts an unparseable timestamp added at runtime as corrupt, not as expired', () => {
    // readStore's shape filter keeps this out of storage-sourced data, but
    // `add()` takes its argument on trust — `timestamp` is typed `string`,
    // which "not-a-date" satisfies, so nothing in the type system stops a
    // caller (or a bug upstream in this SDK) handing it an unparseable one
    // directly. #prune still has to not crash on it, and the debug counters
    // need to say which failure it was.
    const q = new EventQueue()
    q.add({ ...at(nowIso(), 'bad'), timestamp: 'not-a-date' })
    expect(q.peek(10)).toHaveLength(0)
    expect(q.corruptCount()).toBe(1)
    expect(q.expiredCount()).toBe(0)
  })
})
