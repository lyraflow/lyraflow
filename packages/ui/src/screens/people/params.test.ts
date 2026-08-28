import type { Trait } from '@lyraflow/core/segments/ast.js'
import { describe, expect, it } from 'vitest'
import { personPath, readPersonId, readTraitQuery, traitSearchPath } from './params.js'

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

describe('traitSearchPath / readTraitQuery', () => {
  it('round-trips a comparison clause, value included', () => {
    const node: Trait = { kind: 'trait', key: 'plan', operator: '=', value: 'pro' }
    const path = traitSearchPath(node)
    expect(readTraitQuery(new URL(`http://x${path}`).search)).toEqual(node)
  })

  it('round-trips a `between` pair and a relative window object, not just a scalar', () => {
    // These are the two value shapes JSON-encoding exists for: a tuple and a
    // plain object, neither of which a single unencoded query parameter
    // could carry.
    const between: Trait = { kind: 'trait', key: 'seats', operator: 'between', value: [1, 12] }
    expect(readTraitQuery(new URL(`http://x${traitSearchPath(between)}`).search)).toEqual(between)

    const relative: Trait = {
      kind: 'trait',
      key: 'last_login',
      operator: 'in_last',
      value: { n: 30, unit: 'days' },
    }
    expect(readTraitQuery(new URL(`http://x${traitSearchPath(relative)}`).search)).toEqual(relative)
  })

  it('round-trips a value-less clause with no stray value parameter', () => {
    const node: Trait = { kind: 'trait', key: 'plan', operator: 'is_set' }
    const path = traitSearchPath(node)
    expect(path).not.toContain('trait_value')
    expect(readTraitQuery(new URL(`http://x${path}`).search)).toEqual(node)
  })

  it('returns null for no search, an unknown operator, and a value that fails its clause', () => {
    expect(readTraitQuery('')).toBeNull()
    expect(readTraitQuery('?trait_key=plan')).toBeNull() // no operator at all
    expect(readTraitQuery('?trait_key=plan&trait_op=not_a_real_operator')).toBeNull()
    // `between` demands a two-element tuple -- a single value fails the
    // clause's own refine, not just the JSON parse.
    expect(
      readTraitQuery(`?trait_key=seats&trait_op=between&trait_value=${encodeURIComponent('5')}`),
    ).toBeNull()
    // Malformed JSON in the value slot, e.g. a hand-truncated link.
    expect(
      readTraitQuery(`?trait_key=plan&trait_op=%3D&trait_value=${encodeURIComponent('{not json')}`),
    ).toBeNull()
  })

  it('rejects an empty trait key the same way the AST does', () => {
    expect(readTraitQuery('?trait_key=&trait_op=is_set')).toBeNull()
  })
})
