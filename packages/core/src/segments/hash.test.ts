import { describe, expect, it } from 'vitest'
import { canonicalJson, treeHash } from './hash.js'

describe('canonicalJson', () => {
  it('orders object keys so equivalent trees serialise identically', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }))
  })

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })

  it('orders keys at every depth, not just the top level', () => {
    const x = { filter: { kind: 'trait', key: 'plan', operator: '=' } }
    const y = { filter: { operator: '=', key: 'plan', kind: 'trait' } }
    expect(canonicalJson(x)).toBe(canonicalJson(y))
  })

  it('distinguishes values that JSON.stringify would not', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }))
  })

  it('rejects a Date value', () => {
    expect(() => canonicalJson({ a: new Date('2024-01-01') })).toThrow(
      /canonicalJson accepts only plain JSON data/,
    )
  })

  it('rejects a Map value', () => {
    expect(() => canonicalJson({ a: new Map([['x', 1]]) })).toThrow(
      /canonicalJson accepts only plain JSON data/,
    )
  })

  it('rejects a nested non-plain object', () => {
    expect(() => canonicalJson({ a: { b: new Date('2024-01-01') } })).toThrow(
      /canonicalJson accepts only plain JSON data/,
    )
  })

  it('accepts an Object.create(null) object', () => {
    const nullProtoObj = Object.create(null)
    nullProtoObj.a = 1
    nullProtoObj.b = 2
    expect(() => canonicalJson(nullProtoObj)).not.toThrow()
    expect(canonicalJson(nullProtoObj)).toEqual(canonicalJson({ b: 2, a: 1 }))
  })
})

describe('treeHash', () => {
  it('is stable across key order', () => {
    expect(treeHash({ b: 1, a: 2 })).toBe(treeHash({ a: 2, b: 1 }))
  })

  it('changes when a value changes', () => {
    expect(treeHash({ a: 1 })).not.toBe(treeHash({ a: 2 }))
  })

  it('returns hex, so it is safe in a cache key', () => {
    expect(treeHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })
})
