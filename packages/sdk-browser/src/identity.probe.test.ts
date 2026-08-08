import { describe, expect, it } from 'vitest'
import { probeCookieDomain } from './identity.js'

/**
 * `probeCookieDomain` takes an optional `doc` — the only function in this
 * module that does — specifically so its walk can be pinned without a real
 * multi-label browser origin. This fake models the two rules that decide
 * whether a browser accepts a `Set-Cookie`'s `Domain` attribute:
 *
 *  - domain-match: the value must equal the current host, or be a
 *    superdomain of it (a host may always scope a cookie to itself).
 *  - public suffix: even a domain-matching value is rejected if it is a
 *    public suffix (this repo ships no PSL, so the fixture below only
 *    needs the one entry the tests exercise).
 *
 * A write that fails either rule is silently dropped, mirroring a real
 * browser — nothing is stored and nothing throws.
 */
function createFakeDocument(
  host: string,
  publicSuffixes: ReadonlySet<string> = new Set(['co.uk']),
) {
  const store = new Map<string, string>()
  const attemptedDomains: string[] = []

  function isAccepted(bareDomain: string): boolean {
    if (publicSuffixes.has(bareDomain)) return false
    return host === bareDomain || host.endsWith(`.${bareDomain}`)
  }

  const doc = {
    get cookie(): string {
      return Array.from(store.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ')
    },
    set cookie(raw: string) {
      const attrs = raw.split(';').map((p) => p.trim())
      const nameValue = attrs[0] ?? ''
      const eq = nameValue.indexOf('=')
      const name = eq >= 0 ? nameValue.slice(0, eq) : nameValue
      const value = eq >= 0 ? nameValue.slice(eq + 1) : ''
      if (!name) return

      const domainAttr = attrs.find((a) => a.toLowerCase().startsWith('domain='))
      const expiresAttr = attrs.find((a) => a.toLowerCase().startsWith('expires='))
      const isDeletion =
        expiresAttr !== undefined && new Date(expiresAttr.slice(8)).getTime() < Date.now()

      if (domainAttr) {
        const bareDomain = domainAttr.slice(7).replace(/^\./, '')
        if (!isDeletion) attemptedDomains.push(`.${bareDomain}`)
        if (!isAccepted(bareDomain)) return // a real browser drops the whole write, silently
      }

      if (isDeletion) {
        store.delete(name)
        return
      }
      store.set(name, value)
    },
  }

  return { doc: doc as unknown as Document, store, attemptedDomains }
}

describe('probeCookieDomain ordering', () => {
  it('walks broadest-first and keeps the first candidate the browser actually accepts', () => {
    const { doc, store, attemptedDomains } = createFakeDocument('shop.example.co.uk')

    const result = probeCookieDomain('shop.example.co.uk', doc)

    expect(result).toBe('.example.co.uk')
    // .co.uk is a public suffix and must be tried (and rejected) before the
    // working candidate is found — proves the walk starts broad, not narrow.
    expect(attemptedDomains).toEqual(['.co.uk', '.example.co.uk'])
    // The winning probe cookie is cleaned up too, not just the rejected ones —
    // the function returns the candidate string, never a live cookie.
    expect(store.size).toBe(0)
  })

  it('a host may always scope a cookie to itself', () => {
    // Calibration case, not a bug: example.com has only two labels, so the
    // loop's only candidate is .example.com, which trivially equals the host.
    const { doc } = createFakeDocument('example.com')
    expect(probeCookieDomain('example.com', doc)).toBe('.example.com')
  })

  it('prefers the shared parent over scoping to the host itself', () => {
    // This is the case a narrowest-first walk gets wrong: .www.example.net
    // (the host itself) would be accepted immediately, but .example.net is
    // the broader domain that actually lets app.example.net share identity —
    // and broadest-first must reach it without ever trying the narrower one.
    const { doc, attemptedDomains } = createFakeDocument('www.example.net')

    const result = probeCookieDomain('www.example.net', doc)

    expect(result).toBe('.example.net')
    expect(attemptedDomains).toEqual(['.example.net'])
  })

  it('relies on reading the cookie back, not on the write succeeding silently', () => {
    // A jar that accepts every write but never reflects it back on read — the
    // scenario the module's own docstring warns about ("verify by
    // observation, never by assumption"). An implementation that assumed
    // acceptance instead of checking readCookie would return a candidate
    // here; the real implementation must return undefined.
    const doc = {
      get cookie() {
        return ''
      },
      set cookie(_raw: string) {
        // accepted and silently discarded — never appears on read
      },
    } as unknown as Document

    expect(probeCookieDomain('shop.example.co.uk', doc)).toBeUndefined()
  })

  it('cleans up every throwaway probe cookie even when nothing is ever accepted', () => {
    // An artificial fixture — every candidate, including the host itself, is
    // marked a "public suffix" purely to force full exhaustion of the loop.
    // Not a plausible real domain; it exists to prove cleanup runs on every
    // iteration, not only on the accepted one.
    const { doc, store, attemptedDomains } = createFakeDocument(
      'shop.example.co.uk',
      new Set(['co.uk', 'example.co.uk', 'shop.example.co.uk']),
    )

    const result = probeCookieDomain('shop.example.co.uk', doc)

    expect(result).toBeUndefined()
    expect(attemptedDomains).toEqual(['.co.uk', '.example.co.uk', '.shop.example.co.uk'])
    expect(store.size).toBe(0)
  })
})
