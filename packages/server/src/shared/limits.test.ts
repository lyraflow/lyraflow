import { describe, expect, it } from 'vitest'
import { InFlightCap, ResultCache } from './limits.js'

describe('InFlightCap', () => {
  it('admits up to the limit per key and releases', () => {
    const cap = new InFlightCap(2)
    expect(cap.acquire('a')).toBe(true)
    expect(cap.acquire('a')).toBe(true)
    expect(cap.acquire('a')).toBe(false)
    expect(cap.acquire('b')).toBe(true)
    cap.release('a')
    expect(cap.acquire('a')).toBe(true)
    expect(cap.held('a')).toBe(2)
  })
  it('forgets a key once nothing is held, so the map cannot grow', () => {
    const cap = new InFlightCap(1)
    cap.acquire('a')
    cap.release('a')
    expect(cap.held('a')).toBe(0)
    cap.release('a') // a stray release is a no-op, never a negative count
    expect(cap.acquire('a')).toBe(true)
  })
})

describe('ResultCache', () => {
  it('returns a value inside the ttl and nothing after it', () => {
    let t = 1000
    const c = new ResultCache<string>({ ttlMs: 50, now: () => t })
    c.set('k', 'v')
    t = 1049
    expect(c.get('k')).toBe('v')
    t = 1050
    expect(c.get('k')).toBeUndefined()
    expect(c.size).toBe(0)
  })
  it('evicts the oldest insertion past maxEntries', () => {
    const c = new ResultCache<number>({ ttlMs: 1000, maxEntries: 2 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    expect(c.get('a')).toBeUndefined()
    expect(c.get('b')).toBe(2)
    expect(c.size).toBe(2)
  })
  it('a re-set refreshes the entry and its position', () => {
    const c = new ResultCache<number>({ ttlMs: 1000, maxEntries: 2 })
    c.set('a', 1)
    c.set('b', 2)
    c.set('a', 3)
    c.set('c', 4)
    expect(c.get('b')).toBeUndefined()
    expect(c.get('a')).toBe(3)
  })
})
