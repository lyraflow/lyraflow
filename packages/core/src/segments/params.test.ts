import { describe, expect, it } from 'vitest'
import { Params } from './params.js'

describe('Params', () => {
  it('returns a placeholder and records the value', () => {
    const p = new Params()
    expect(p.add('trial', 'String')).toBe('{p0:String}')
    expect(p.add(3, 'Float64')).toBe('{p1:Float64}')
    expect(p.values).toEqual({ p0: 'trial', p1: 3 })
  })

  it('never reuses a name, even for identical values', () => {
    // Deduplicating would be a correctness trap the day a caller mutates one
    // site's value, and saves nothing measurable.
    const p = new Params()
    expect(p.add('x', 'String')).toBe('{p0:String}')
    expect(p.add('x', 'String')).toBe('{p1:String}')
  })

  it('produces a name that cannot collide with SQL text', () => {
    const p = new Params()
    const placeholder = p.add("'; DROP TABLE events; --", 'String')
    // The hostile string is in the VALUES map, never in the SQL fragment.
    expect(placeholder).toBe('{p0:String}')
    expect(p.values.p0).toBe("'; DROP TABLE events; --")
  })
})
