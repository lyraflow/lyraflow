import { describe, expect, it } from 'vitest'
import { personPath, readPersonId } from './params.js'

describe('personPath / readPersonId', () => {
  it('round-trips an id containing a dot, an at sign and a slash', () => {
    // The whole reason this is a query parameter: static.ts's looksLikeFile
    // 404s any SPA path whose last segment has a dot, AFTER percent-decoding,
    // so no path encoding survives a hard refresh.
    for (const id of ['cem@example.com', 'a/b', 'v1.2.3', 'plain']) {
      expect(readPersonId(new URL(`http://x${personPath(id)}`).search)).toBe(id)
    }
  })

  it('returns null for no id and for an empty id', () => {
    expect(readPersonId('')).toBeNull()
    expect(readPersonId('?id=')).toBeNull()
  })

  it('encodes with encodeURIComponent, not encodeURI -- & # and = travel inside the value', () => {
    // encodeURI leaves &, # and = alone, each of which would otherwise end
    // or split the query parameter rather than stay part of the id.
    //
    // This is the ONLY test in this file that would catch an encodeURI
    // regression. The round-trip test above uses '@', '/' and '.' -- all
    // three are left unescaped by encodeURI too, and an unescaped '/'
    // still round-trips through URLSearchParams, so that test passes
    // identically under either function. Only a character URLSearchParams
    // itself treats specially (here, '&' splitting the query string) can
    // tell them apart.
    for (const id of ['a&b', 'a#b', 'a=b']) {
      const path = personPath(id)
      expect(path).not.toContain(`id=${id}`)
      expect(readPersonId(new URL(`http://x${path}`).search)).toBe(id)
    }
  })
})
