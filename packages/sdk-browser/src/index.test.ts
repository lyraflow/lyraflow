/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as identityModule from './identity.js'
import * as sdk from './index.js'
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

  it('probes the cookie domain once, at init, and reuses it across track calls', () => {
    // A three-label host so the probe walk actually runs candidates instead
    // of short-circuiting immediately (a single-label host like the default
    // "localhost" returns undefined with zero cookie writes, which would
    // make this test pass trivially regardless of caching).
    ;(window as unknown as { happyDOM: { setURL: (u: string) => void } }).happyDOM.setURL(
      'https://sub.example.com/',
    )
    const setCount = countCookieSets(() => {
      const f = setup()
      sdk.track('one')
      sdk.track('two')
      // Cookies are written synchronously by init/identify/track; the
      // network flush isn't relevant to this count, so it's deliberately
      // not awaited here.
      void f
    })
    // init(): the probe accepts the broadest candidate, .example.com, on its
    // first try for this host, so the walk is one write-then-delete (2
    // setter calls) plus loadIdentity's own single write of the
    // anonymous-id cookie: 3 total. The two track() calls that follow reuse
    // the already-loaded, in-memory identity and the cached cookie domain,
    // so they must not add any further cookie writes at all — if the probe
    // re-ran on every call instead of being cached, this would be well into
    // double digits.
    expect(setCount).toBe(3)
  })
})
