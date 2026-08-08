/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AID_COOKIE,
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
})
