/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as identityModule from './identity.js'
import * as sdk from './index.js'
import { STORAGE_KEY } from './queue.js'
import { Transport } from './transport.js'

const ok = async () => new Response('{}', { status: 202 })

function setup(over: Partial<sdk.InitOptions> = {}) {
  const fetchImpl = vi.fn(ok) as unknown as typeof fetch
  sdk.init({ host: 'https://a.test', writeKey: 'wk_test', autoPageView: false, fetchImpl, ...over })
  return fetchImpl
}
const sent = (f: typeof fetch) =>
  (f as unknown as ReturnType<typeof vi.fn>).mock.calls.flatMap(
    (c) => JSON.parse((c[1] as RequestInit).body as string).batch,
  )

/**
 * Counts every `document.cookie` setter invocation. happy-dom's get/set pair
 * lives on its internal Document class, several levels up the prototype
 * chain from `document` itself, not as an own property — spying only the
 * setter there silently drops the getter, so any code that reads
 * `document.cookie` afterwards blows up on `undefined`. Walking to the
 * actual owner and wrapping both accessors keeps both live. (Same pattern as
 * identity.test.ts's "refreshes the anonymous id cookie on every load" case.)
 */
function countCookieSets(run: () => void): number {
  let proto: object | null = document
  while (proto && !Object.getOwnPropertyDescriptor(proto, 'cookie')) {
    proto = Object.getPrototypeOf(proto)
  }
  const original = proto && Object.getOwnPropertyDescriptor(proto, 'cookie')
  const originalGet = original?.get
  const originalSet = original?.set
  if (!proto || !original || !originalGet || !originalSet) {
    throw new Error('could not locate the cookie accessor')
  }
  let setCount = 0
  Object.defineProperty(proto, 'cookie', {
    configurable: true,
    get(this: Document) {
      return originalGet.call(this)
    },
    set(this: Document, value: string) {
      setCount += 1
      originalSet.call(this, value)
    },
  })
  try {
    run()
  } finally {
    Object.defineProperty(proto, 'cookie', original)
  }
  return setCount
}

describe('public surface', () => {
  beforeEach(() => {
    localStorage.clear()
    // `Max-Age=0`, as given in the brief's literal snippet, does not clear a
    // cookie under happy-dom — it leaves an empty-value cookie behind
    // (`identity.ts` documents this exact failure mode and uses `Expires` in
    // the past instead). Left as `Max-Age=0`, the "sends nothing before
    // consent" test below is order-dependent: it fails whenever an earlier
    // test in this file has already set `lyraflow_aid`, because the blanked
    // cookie persists and still contains the string "lyraflow_aid". Using
    // `Expires` here, matching identity.ts's own deletion, actually removes
    // it.
    for (const c of document.cookie.split(';')) {
      const n = c.split('=')[0]?.trim()
      if (n) document.cookie = `${n}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`
    }
  })

  it('sends a track event with its name and properties', async () => {
    const f = setup()
    sdk.track('signed_up', { plan: 'pro' })
    await sdk.flush()
    expect(sent(f)[0]).toMatchObject({
      type: 'track',
      event: 'signed_up',
      properties: { plan: 'pro' },
    })
  })

  it('fires one page view on init when autoPageView is on', async () => {
    const f = setup({ autoPageView: true })
    await sdk.flush()
    expect(sent(f).filter((e) => e.type === 'page')).toHaveLength(1)
  })

  it('attaches the user id to events after identify', async () => {
    const f = setup()
    sdk.identify('user-42', { plan: 'pro' })
    sdk.track('did_thing')
    await sdk.flush()
    const events = sent(f)
    expect(events.find((e) => e.type === 'identify')).toMatchObject({ user_id: 'user-42' })
    expect(events.find((e) => e.type === 'track')).toMatchObject({ user_id: 'user-42' })
  })

  it('flushes before reset, so queued events keep the old identity', async () => {
    const f = setup()
    sdk.identify('user-42')
    sdk.track('before_logout')
    sdk.reset()
    await sdk.flush()
    const before = sent(f).find((e) => e.event === 'before_logout')
    expect(before?.user_id).toBe('user-42')

    sdk.track('after_logout')
    await sdk.flush()
    const after = sent(f).find((e) => e.event === 'after_logout')
    expect(after?.user_id).toBeUndefined()
    expect(after?.anonymous_id).not.toBe(before?.anonymous_id)
  })

  it('warns about a bad property but still sends the event', async () => {
    // The ingest answers 202 for malformed events by design, so this warning is
    // the only feedback a developer will ever get.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const f = setup()
    sdk.track('x', { nested: { a: 1 } })
    await sdk.flush()
    expect(warn.mock.calls.join(' ')).toContain('nested')
    expect(sent(f)).toHaveLength(1)
    warn.mockRestore()
  })

  it('sends nothing before consent when the gate is on', async () => {
    const f = setup({ requireConsent: true })
    sdk.track('early')
    await sdk.flush()
    expect(f).not.toHaveBeenCalled()
    expect(document.cookie).not.toContain('lyraflow_aid')

    sdk.consent(true)
    await sdk.flush()
    expect(sent(f).map((e) => e.event)).toContain('early')
  })

  it('guard actually swallows an internal error, and still warns', () => {
    // The given "never throws" test below calls track()/identify()/reset()
    // with entirely well-formed inputs, so it never actually exercises an
    // internal throw — removing the guard() wrapper from track() leaves it
    // green. `Object.keys()` inside validate.ts's checkBag is the one call
    // in the properties-validation path that ISN'T wrapped in a try/catch
    // (only individual property reads are), so a `properties` bag whose
    // `ownKeys` trap throws forces a real internal exception to reach
    // track()'s own body — this is what actually pins the guard.
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('hostile ownKeys')
        },
      },
    )
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setup()
    expect(() => sdk.track('x', hostile as Record<string, unknown>)).not.toThrow()
    expect(warnSpy.mock.calls.join(' ')).toContain('swallowed an internal error')
    warnSpy.mockRestore()
  })

  it('never throws out of a public method', async () => {
    // A tracking library that breaks the host app is worse than one that loses
    // data. Calling before init is the likeliest way a host hits this.
    expect(() => sdk.track('before_init')).not.toThrow()
    expect(() => sdk.identify('user-42')).not.toThrow()
    expect(() => sdk.reset()).not.toThrow()
    await expect(sdk.flush()).resolves.toBeUndefined()
  })

  it('drains calls queued by the snippet stub before the script loaded', async () => {
    // The script loads async; the call most likely to happen early is the
    // signup you least want to lose.
    ;(globalThis as unknown as { lyraflow?: { q?: unknown[] } }).lyraflow = {
      q: [['track', 'queued_before_load', { a: 1 }]],
    }
    const f = setup()
    await sdk.flush()
    expect(sent(f).map((e) => e.event)).toContain('queued_before_load')
  })

  it('reset() calls flush before resetIdentity', () => {
    // The given "flushes before reset" test above cannot observe this
    // ordering directly: buildEvent() bakes identity into a QueuedEvent at
    // enqueue time (payload.ts: "stamped at ENQUEUE, never at send"), so an
    // already-queued event's fields can't change no matter when identity
    // later rotates — reversing the two calls inside reset() leaves that
    // test green. This test pins the ordering itself, as a call sequence,
    // which is what the brief's implementation note actually asks for.
    setup()
    const order: string[] = []
    const flushSpy = vi.spyOn(Transport.prototype, 'flush').mockImplementation(async () => {
      order.push('flush')
      return 'sent'
    })
    const resetIdentitySpy = vi.spyOn(identityModule, 'resetIdentity').mockImplementation(() => {
      order.push('resetIdentity')
      return { anonymousId: 'mock-anon' }
    })
    try {
      sdk.reset()
      expect(order).toEqual(['flush', 'resetIdentity'])
    } finally {
      flushSpy.mockRestore()
      resetIdentitySpy.mockRestore()
    }
  })

  it('produces no console.debug output when debug is off', async () => {
    // A library that chatters into a customer's console by default is a
    // library people remove.
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const f = setup({ debug: false })
    sdk.track('quiet')
    await sdk.flush()
    expect(sent(f)).toHaveLength(1)
    expect(debug).not.toHaveBeenCalled()
    debug.mockRestore()
  })

  it('never re-probes the cookie domain across repeated identity-touching calls', () => {
    // track()/page() never touch a cookie at all in this implementation (see
    // the next test), so they can't exercise a caching bug in
    // resolveCookieDomain() — only identify()/consent()/reset() call it.
    // This spies on probeCookieDomain directly and drives two identify()
    // calls (each of which writes a cookie) to pin that the probe itself
    // still only ever runs the once, at init.
    //
    // Weaker than the count-based test below: this only sees calls made
    // through index.ts's own imported binding. identity.ts's internal
    // domainFor() calls probeCookieDomain through a module-internal
    // reference this spy cannot intercept, so a regression that re-probes
    // *inside* identity.ts (rather than in index.ts) would pass this test
    // and only be caught by counting real `document.cookie` writes — see
    // the next test, which is the one that actually pins the requirement.
    ;(window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(
      'https://sub.example.com/',
    )
    const probeSpy = vi.spyOn(identityModule, 'probeCookieDomain')
    try {
      setup()
      sdk.identify('user-1')
      sdk.identify('user-2')
      expect(probeSpy).toHaveBeenCalledTimes(1)
    } finally {
      probeSpy.mockRestore()
    }
  })

  it('probes the cookie domain once, at init, and reuses it across track and identify calls', () => {
    // A three-label host so the probe walk actually runs candidates instead
    // of short-circuiting immediately (a single-label host like the default
    // "localhost" returns undefined with zero cookie writes, which would
    // make this test pass trivially regardless of caching).
    //
    // Includes identify() calls, not just track(): track()/page() never
    // touch a cookie at all in this implementation, so on their own they
    // can't exercise resolveCookieDomain()'s cache at all, let alone a
    // regression inside identity.ts's own domainFor() (see the previous
    // test's note). Counting real `document.cookie` setter invocations
    // across calls that DO touch identity is what actually proves the
    // probe only ever runs once.
    ;(window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(
      'https://sub.example.com/',
    )
    const setCount = countCookieSets(() => {
      const f = setup()
      sdk.track('one')
      sdk.track('two')
      sdk.identify('user-1')
      sdk.identify('user-2')
      // Cookies are written synchronously by init/identify/track; the
      // network flush isn't relevant to this count, so it's deliberately
      // not awaited here.
      void f
    })
    // init(): the probe accepts the broadest candidate, .example.com, on its
    // first try for this host, so the walk is one write-then-delete (2
    // setter calls) plus loadIdentity's own single write of the
    // anonymous-id cookie: 3 total. The two track() calls add nothing (see
    // above). Each identify() call writes the user-id cookie once (1 each,
    // no re-probe): 2 more. Total: 5. If the probe re-ran on every
    // identity-touching call instead of being cached, this would be well
    // into double digits.
    expect(setCount).toBe(5)
  })

  it('does not transmit a queue persisted by a previous, consented session while the gate is closed', () => {
    // The ordinary path this guards: consent granted on visit 1, the server
    // briefly down, an event survives in localStorage; on visit 2 the gate
    // is 'pending' again (a refusal — and, per this SDK's own design, even
    // a grant — cannot be remembered across a fresh init). Nothing may drain
    // that leftover queue until this new session's gate says so.
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          type: 'track',
          message_id: 'seed-1',
          timestamp: new Date().toISOString(),
          anonymous_id: 'prev-anon',
          context: {},
          event: 'from_a_previous_session',
        },
      ]),
    )
    vi.useFakeTimers()
    try {
      const f = setup({ requireConsent: true })
      vi.advanceTimersByTime(5_100)
      expect(f).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops sending immediately on refusal, even with events already queued', () => {
    vi.useFakeTimers()
    try {
      const f = setup()
      sdk.track('queued_before_refusal')
      sdk.consent(false)
      vi.advanceTimersByTime(5_100)
      expect(f).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush() is a no-op after an explicit refusal', async () => {
    const f = setup()
    sdk.track('x')
    sdk.consent(false)
    await sdk.flush()
    expect(f).not.toHaveBeenCalled()
  })

  it('persists a user id set before consent once consent is granted', async () => {
    const f = setup({ requireConsent: true })
    sdk.identify('user-99')
    sdk.consent(true)
    await sdk.flush()
    const identifyEvent = sent(f).find((e) => e.type === 'identify')
    expect(identifyEvent?.user_id).toBe('user-99')
    // And actually persisted, not just present on the wire once — the whole
    // point is that a page reload afterwards must still know this visitor.
    expect(document.cookie).toContain('lyraflow_uid=user-99')
  })

  it('reset() forgets a user id captured while consent was still pending', async () => {
    // Without this, a logout is silently undone the moment a LATER
    // consent(true) arrives: identify() before consent stashes the id in
    // state.pendingUserId, and only a successful activateSending() ever
    // clears that field — reset() rebuilding identity is not the same
    // thing as reset() forgetting what was pending.
    //
    // The already-held 'identify' event itself is deliberately NOT part of
    // this assertion: identify('user-42') genuinely happened before the
    // reset, so that event legitimately keeps user_id: 'user-42' on
    // release — the same "stamped at enqueue, never retro-stamped"
    // principle the anonymous_id re-stamping fix protects. The bug is
    // specifically that the id leaks into the PERSISTED cookie and into
    // events recorded AFTER the reset, neither of which should ever have
    // known about a user id a logout was supposed to erase.
    const f = setup({ requireConsent: true })
    sdk.identify('user-42')
    sdk.reset()
    sdk.consent(true)
    sdk.track('after_reset_and_grant')
    await sdk.flush()
    expect(document.cookie).not.toContain('lyraflow_uid=user-42')
    const events = sent(f)
    expect(events.find((e) => e.event === 'after_reset_and_grant')?.user_id).toBeUndefined()
  })

  it('a refusal discards a user id captured while consent was still pending', async () => {
    // The same field, the other clearing path: identify() while pending,
    // then an explicit refusal — not a reset — must ALSO forget it, so a
    // later grant doesn't persist an id gathered during a window the
    // visitor declined.
    const f = setup({ requireConsent: true })
    sdk.identify('user-refused')
    sdk.consent(false)
    sdk.consent(true)
    await sdk.flush()
    expect(document.cookie).not.toContain('lyraflow_uid=user-refused')
    const events = sent(f)
    expect(events.every((e) => e.user_id !== 'user-refused')).toBe(true)
  })

  it('does not warn about a missing user_id for an identify() call that is about to be dropped by a refusal', () => {
    // enqueueOrHold checks the gate BEFORE calling validateEvent — a
    // refused gate never sets identity.userId, so identify()'s own
    // "requires a user_id" rule is guaranteed to fire on every call during
    // a refusal unless the drop happens first, producing a warning about a
    // problem nobody could ever act on.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      setup({ requireConsent: true })
      sdk.consent(false)
      sdk.identify('user-x')
      expect(warnSpy.mock.calls.join(' ')).not.toContain('requires a user_id')
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('re-stamps held events with the real, cookie-backed anonymous id on consent — not the ephemeral one', async () => {
    const f = setup({ requireConsent: true })
    sdk.track('held_1')
    sdk.track('held_2')
    sdk.consent(true)
    await sdk.flush()
    const events = sent(f)
    const ids = new Set(events.map((e) => e.anonymous_id))
    expect(ids.size).toBe(1)
    const [id] = [...ids]
    expect(document.cookie).toContain(`lyraflow_aid=${id}`)
  })

  it('does not collect events after an explicit refusal, and a later grant does not resurrect them', async () => {
    const f = setup({ requireConsent: true })
    sdk.consent(false)
    sdk.track('after_refusal')
    sdk.consent(true)
    await sdk.flush()
    expect(sent(f).map((e) => e.event)).not.toContain('after_refusal')
  })

  it('collects nothing while Do Not Track has already refused, even once consent is granted later', async () => {
    // `doNotTrack` lives on Navigator's prototype in happy-dom, not as an
    // own property of `navigator` itself — restoring only an own-property
    // descriptor (a natural first attempt) silently no-ops, permanently
    // stubbing every later test's `navigator.doNotTrack` at '1' via the own
    // property this defineProperty call below leaves behind. `delete`
    // removes that own property outright and lets the prototype's getter
    // show through again, which is what actually restores it.
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true })
    try {
      const f = setup({ requireConsent: true })
      sdk.track('during_dnt')
      sdk.consent(true)
      await sdk.flush()
      expect(sent(f).map((e) => e.event)).not.toContain('during_dnt')
    } finally {
      // Reflect.deleteProperty, not `= undefined`: an own property set to
      // `undefined` still shadows the prototype getter this is trying to
      // restore — it has to be actually removed.
      Reflect.deleteProperty(navigator, 'doNotTrack')
    }
  })

  it('does not read localStorage before consent', () => {
    // happy-dom's Storage implementation cannot be intercepted directly —
    // vi.spyOn(Storage.prototype, 'getItem') and even a manual prototype
    // monkey-patch both silently stop working the moment ANY earlier test
    // in the file has already touched localStorage once (confirmed with a
    // minimal repro; happy-dom's storage access bypasses the prototype
    // after first use). JSON.parse is a real global, not a happy-dom host
    // object, and EventQueue's readStore() is the only code path in this
    // whole call graph that ever parses the stored queue — so seeding a
    // parseable queue and watching whether JSON.parse ever sees it is a
    // reliable proxy for "was the persisted queue actually read."
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        {
          type: 'track',
          message_id: 'seed-2',
          timestamp: new Date().toISOString(),
          anonymous_id: 'prev-anon',
          context: {},
          event: 'seed',
        },
      ]),
    )
    const parseSpy = vi.spyOn(JSON, 'parse')
    try {
      setup({ requireConsent: true })
      sdk.track('x')
      expect(parseSpy).not.toHaveBeenCalled()
    } finally {
      parseSpy.mockRestore()
    }
  })

  it('a second init() stops the first transport, not merely orphans it', () => {
    // Deliberately never flushed explicitly: the periodic interval is the
    // ONLY thing that could ever send 'one', so a first Transport left
    // running after a second init() is directly observable by advancing
    // past its 5-second tick.
    vi.useFakeTimers()
    try {
      const f1 = setup()
      sdk.track('one')
      setup({ writeKey: 'wk_test_2' })
      vi.advanceTimersByTime(5_100)
      expect(f1).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a second init() fully reconfigures the SDK — the new config is what actually sends', async () => {
    const f1 = setup()
    sdk.track('one')
    await sdk.flush()
    expect(sent(f1)).toHaveLength(1)

    const f2 = setup({ writeKey: 'wk_test_2' })
    sdk.track('two')
    await sdk.flush()
    expect(sent(f2)).toHaveLength(1)

    // The proof this guards: if the first Transport's interval/listeners
    // were still live, they would still be able to drain the (shared,
    // persisted) queue through the FIRST fetchImpl mock too.
    expect(sent(f1)).toHaveLength(1)
  })

  it('does not lose held events if loadIdentity throws while consent is being granted', () => {
    setup({ requireConsent: true })
    sdk.track('important_signup')
    const loadIdentitySpy = vi.spyOn(identityModule, 'loadIdentity').mockImplementation(() => {
      throw new Error('boom')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => sdk.consent(true)).not.toThrow()
    } finally {
      loadIdentitySpy.mockRestore()
      warnSpy.mockRestore()
    }
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).toContain('important_signup')
  })

  it('retries activation from the send path after a failed grant, instead of stalling forever', async () => {
    // After the failed consent(true) below, the gate is 'granted' but no
    // Transport was ever built — activateSending() is only ever called
    // from init() and consent(), and neither runs again on its own, so
    // without a retry this event would sit in storage for the rest of the
    // page's life. flush() is the send path that has to notice a missing
    // transport and try activateSending() again.
    const f = setup({ requireConsent: true })
    sdk.track('important_signup')
    const loadIdentitySpy = vi.spyOn(identityModule, 'loadIdentity').mockImplementation(() => {
      throw new Error('boom')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      sdk.consent(true)
    } finally {
      loadIdentitySpy.mockRestore()
      warnSpy.mockRestore()
    }
    await sdk.flush()
    expect(sent(f).map((e) => e.event)).toContain('important_signup')
  })

  it('retries activation on the next track() too, not only on an explicit flush()', async () => {
    const f = setup({ requireConsent: true })
    sdk.track('stranded')
    const loadIdentitySpy = vi.spyOn(identityModule, 'loadIdentity').mockImplementation(() => {
      throw new Error('boom')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      sdk.consent(true)
    } finally {
      loadIdentitySpy.mockRestore()
      warnSpy.mockRestore()
    }
    sdk.track('after_recovery')
    await sdk.flush()
    const events = sent(f).map((e) => e.event)
    expect(events).toContain('stranded')
    expect(events).toContain('after_recovery')
  })

  it('warns when a method is called before init() has ever run', async () => {
    vi.resetModules()
    const fresh = (await import('./index.js')) as typeof sdk
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      fresh.track('too_early')
      expect(warnSpy.mock.calls.join(' ')).toContain('before init()')
    } finally {
      warnSpy.mockRestore()
    }
  })
})
