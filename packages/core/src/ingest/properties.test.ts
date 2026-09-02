import { describe, expect, it } from 'vitest'
import { MAX_ID_LENGTH, routeProperties } from './properties.js'

describe('routeProperties', () => {
  it('routes finite numbers to properties_num', () => {
    expect(routeProperties({ amount: 42.5 })).toEqual({
      properties: {},
      properties_num: { amount: 42.5 },
    })
  })

  it('routes strings to properties', () => {
    expect(routeProperties({ plan: 'trial' })).toEqual({
      properties: { plan: 'trial' },
      properties_num: {},
    })
  })

  it('stringifies booleans into properties', () => {
    expect(routeProperties({ paid: true, trial: false })).toEqual({
      properties: { paid: 'true', trial: 'false' },
      properties_num: {},
    })
  })

  // The claim the README now makes to callers, which is sharper than
  // "booleans are stringified": once ingested there is NO WAY BACK. A caller
  // who sent a real boolean and one who sent the string are indistinguishable,
  // which is why a segment filter has to use the string form (#67).
  it('makes a real boolean and its string spelling the same stored value', () => {
    const fromBoolean = routeProperties({ flag: true })
    const fromString = routeProperties({ flag: 'true' })
    expect(fromBoolean).toEqual(fromString)
    expect(fromBoolean.properties.flag).toBe('true')
    // And nothing records that a coercion happened -- no second column, no
    // marker, nothing a reader could use to tell the two apart later.
    expect(Object.keys(fromBoolean.properties_num)).toEqual([])
  })

  it('drops null and undefined rather than storing empty strings', () => {
    expect(routeProperties({ a: null, b: undefined as never })).toEqual({
      properties: {},
      properties_num: {},
    })
  })

  it('drops non-finite numbers, which ClickHouse Float64 cannot represent usefully', () => {
    expect(routeProperties({ x: Number.NaN, y: Number.POSITIVE_INFINITY })).toEqual({
      properties: {},
      properties_num: {},
    })
  })

  it('truncates keys longer than 128 characters', () => {
    const key = 'k'.repeat(200)
    const out = routeProperties({ [key]: 'v' })
    expect(Object.keys(out.properties)[0]).toHaveLength(128)
  })
})

describe('control characters in property KEYS (#35)', () => {
  const ch = (code: number) => String.fromCharCode(code)

  // A property key reaches `event_schema` and from there the autocomplete
  // endpoints, so it is rendered in exactly the places an event name is.
  it('escapes a control character in a key', () => {
    const out = routeProperties({ [`pl${ch(0x1b)}an`]: 'pro' })
    expect(Object.keys(out.properties)).toEqual(['pl\\x1ban'])
    expect(out.properties['pl\\x1ban']).toBe('pro')
  })

  it('escapes keys on the numeric side too', () => {
    const out = routeProperties({ [`se${ch(0x0a)}ats`]: 12 })
    expect(Object.keys(out.properties_num)).toEqual(['se\\x0aats'])
  })

  // The half that must NOT change. A value is arbitrary customer data -- a
  // support message, a page title -- where a newline can be genuine content,
  // and rewriting it would corrupt the thing the operator asked to store.
  it('leaves property VALUES untouched', () => {
    const value = `line one${ch(0x0a)}line two`
    const out = routeProperties({ note: value })
    expect(out.properties.note).toBe(value)
  })

  it('leaves ordinary keys byte-for-byte alone', () => {
    const out = routeProperties({ plan: 'pro', 'utm.source': 'x', 'a-b_c': 'y' })
    expect(Object.keys(out.properties).sort()).toEqual(['a-b_c', 'plan', 'utm.source'])
  })

  // Escaping runs AFTER the MAX_ID_LENGTH truncation, deliberately: escaping
  // first and truncating second can cut a `\xNN` sequence in half and leave a
  // `\x1` that means nothing.
  it('does not leave a half-written escape sequence at the truncation boundary', () => {
    const key = `${'a'.repeat(MAX_ID_LENGTH - 1)}${ch(0x1b)}trailing`
    const out = routeProperties({ [key]: 'v' })
    const stored = Object.keys(out.properties)[0] ?? ''
    expect(stored.endsWith('\\x1b')).toBe(true)
    expect(stored).not.toMatch(/\\x1?$/)
  })
})

describe('the $ prefix is reserved for Lyraflow (#53)', () => {
  it('drops a caller-supplied $ key from the STRING map', () => {
    expect(routeProperties({ $page_name: 'forged', plan: 'pro' })).toEqual({
      properties: { plan: 'pro' },
      properties_num: {},
    })
  })

  it('drops it from the NUMBER map too, which is the half a naive guard misses', () => {
    // Routing is per VALUE, not per key. A guard that defended only
    // `properties` would MOVE the collision into the column no reader of the
    // page name ever looks in -- the forged value would be unfindable rather
    // than merely wrong, which is worse than no guard at all.
    expect(routeProperties({ $page_name: 42, seats: 3 })).toEqual({
      properties: {},
      properties_num: { seats: 3 },
    })
  })

  it('drops any $ key, not a list of known ones', () => {
    // A ban-list is the wrong tool the moment it needs a second entry. This is
    // the difference between reserving a NAMESPACE and reserving a name.
    expect(routeProperties({ $anything: 'x', $future_key: 1, $: 'bare' })).toEqual({
      properties: {},
      properties_num: {},
    })
  })

  it('leaves a $ anywhere but the FIRST character alone', () => {
    // `price_$` and `a$b` are ordinary keys somebody may legitimately send.
    // Reserving the prefix must not quietly become reserving the character.
    expect(routeProperties({ price_$: '10', a$b: 2 })).toEqual({
      properties: { price_$: '10' },
      properties_num: { a$b: 2 },
    })
  })
})
