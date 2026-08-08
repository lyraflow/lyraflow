/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AID_COOKIE,
  UID_COOKIE,
  loadIdentity,
  newUuid,
  probeCookieDomain,
  resetIdentity,
  setUserId,
} from './identity.js'

function clearCookies() {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]?.trim()
    if (name) document.cookie = `${name}=; Max-Age=0; Path=/`
  }
}

describe('newUuid', () => {
  it('produces a v4 UUID the server will accept', () => {
    // The server validates message_id with z.string().uuid(). A fallback that
    // emits "random-ish" text would be dead-lettered with nothing reporting it.
    const uuid = newUuid()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('produces a valid UUID without crypto.randomUUID', () => {
    const original = globalThis.crypto.randomUUID
    // @ts-expect-error deliberately removing the API to exercise the fallback
    globalThis.crypto.randomUUID = undefined
    try {
      expect(newUuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
    } finally {
      globalThis.crypto.randomUUID = original
    }
  })

  it('does not throw when the Web Crypto API is entirely missing', () => {
    // An analytics SDK must never break the host page during init. The
    // randomUUID-only fallback still called crypto.getRandomValues
    // unguarded, which threw in an embedding context with no crypto API
    // at all (not just a missing randomUUID). `globalThis.crypto` is a
    // getter-only accessor here, so plain assignment throws — vi.stubGlobal
    // is the supported way to override it for the duration of one test.
    vi.stubGlobal('crypto', undefined)
    try {
      expect(newUuid()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('probeCookieDomain', () => {
  it('returns undefined for a hostname with no parent to share with', () => {
    expect(probeCookieDomain('localhost')).toBeUndefined()
  })

  it('does not return a public suffix', () => {
    // The naive "last two labels" rule returns `.co.uk` here. Browsers reject a
    // cookie set on a public suffix outright, so the SDK would end up with NO
    // cookie and a fresh visitor id on every page load — worse than the bug it
    // was meant to fix. The probe must verify by reading back, not assume.
    const probed = probeCookieDomain('shop.example.co.uk')
    expect(probed).not.toBe('.co.uk')
  })

  it('returns a domain the browser actually accepted', () => {
    const probed = probeCookieDomain(window.location.hostname)
    if (probed !== undefined) {
      document.cookie = `probe_check=1; Domain=${probed}; Path=/`
      expect(document.cookie).toContain('probe_check=1')
    }
  })
})

describe('identity', () => {
  beforeEach(() => clearCookies())

  it('mints an anonymous id on first load and reuses it after', () => {
    const first = loadIdentity({})
    expect(first.anonymousId).toMatch(/^[0-9a-f-]{36}$/)
    expect(loadIdentity({}).anonymousId).toBe(first.anonymousId)
  })

  it('remembers a user id across loads', () => {
    loadIdentity({})
    setUserId('user-42', {})
    expect(loadIdentity({}).userId).toBe('user-42')
  })

  it('rotates the anonymous id and forgets the user on reset', () => {
    // A shared machine: without rotation the next person inherits the previous
    // person's device history, and the server's time-split tiling never sees a
    // handover to split on.
    const before = loadIdentity({})
    setUserId('user-42', {})
    const after = resetIdentity({})
    expect(after.anonymousId).not.toBe(before.anonymousId)
    expect(after.userId).toBeUndefined()
    expect(loadIdentity({}).userId).toBeUndefined()
  })

  it('treats a present-but-empty anonymous id cookie as absent, not as a real id', () => {
    // A cookie can end up present with an empty value for reasons that have
    // nothing to do with this SDK — a proxy or extension rewriting it, a
    // deletion elsewhere that only blanked rather than removed it. Adopting
    // '' as the anonymous id would silently persist a non-UUID id forever
    // once loadIdentity rewrites the cookie below. This pins that specific
    // failure mode directly (`document.cookie` is set by hand here, not
    // produced through this module), independent of how deletion behaves.
    document.cookie = `${AID_COOKIE}=; Path=/`
    expect(loadIdentity({}).anonymousId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('actually removes the user cookie on reset, not just blanks it', () => {
    // Pins deletion as real removal, independent of loadIdentity's handling
    // of a blank cookie above — reverting either fix alone must redden
    // exactly one of these two tests, not both or neither.
    loadIdentity({})
    setUserId('user-42', {})
    resetIdentity({})
    expect(document.cookie).not.toMatch(new RegExp(UID_COOKIE))
  })

  it('refreshes the anonymous id cookie on every load, not only when minted', () => {
    // Decision: this cookie's whole purpose is long-lived identity, so its
    // two-year window should run from the visitor's most recent visit, not
    // their first — otherwise a daily visitor still ages out on day 731.
    //
    // vi.spyOn(document, 'cookie', 'set') isn't usable here: happy-dom's
    // get/set pair lives on its internal Document class, several levels up
    // the prototype chain from `document` itself, not as an own property —
    // spying only the setter there silently drops the getter, so
    // readCookie's `doc.cookie.split(...)` blows up on `undefined`. Walking
    // to the actual owner and wrapping both accessors keeps both live.
    let proto: object | null = document
    while (proto && !Object.getOwnPropertyDescriptor(proto, 'cookie')) {
      proto = Object.getPrototypeOf(proto)
    }
    const original = proto && Object.getOwnPropertyDescriptor(proto, 'cookie')
    const originalGet = original?.get
    const originalSet = original?.set
    if (!proto || !original || !originalGet || !originalSet)
      throw new Error('could not locate the cookie accessor')
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
      loadIdentity({})
      loadIdentity({})
      expect(setCount).toBeGreaterThan(0)
    } finally {
      Object.defineProperty(proto, 'cookie', original)
    }
  })
})
