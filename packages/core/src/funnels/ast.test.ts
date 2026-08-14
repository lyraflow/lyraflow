import { describe, expect, it } from 'vitest'
import { FunnelDefinition } from './ast.js'

describe('FunnelDefinition', () => {
  it('accepts a step with no predicates', () => {
    const r = FunnelDefinition.safeParse({
      steps: [{ event: 'signed_up' }, { event: 'paid' }],
      window_seconds: 3600,
    })
    expect(r.success).toBe(true)
  })

  it('accepts the existing WherePredicate shape', () => {
    const r = FunnelDefinition.safeParse({
      steps: [
        { event: '$page', where: [{ property: 'path', operator: '=', value: '/billing' }] },
        { event: 'paid' },
      ],
      window_seconds: 3600,
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown operator spelling', () => {
    const r = FunnelDefinition.safeParse({
      steps: [
        { event: '$page', where: [{ property: 'path', operator: 'eq', value: '/' }] },
        { event: 'paid' },
      ],
      window_seconds: 3600,
    })
    expect(r.success).toBe(false)
  })

  it('inherits `between` needing exactly two values', () => {
    const two = FunnelDefinition.safeParse({
      steps: [
        { event: 'purchase', where: [{ property: 'total', operator: 'between', value: [10, 20] }] },
        { event: 'refund' },
      ],
      window_seconds: 3600,
    })
    const one = FunnelDefinition.safeParse({
      steps: [
        { event: 'purchase', where: [{ property: 'total', operator: 'between', value: 10 }] },
        { event: 'refund' },
      ],
      window_seconds: 3600,
    })
    expect(two.success).toBe(true)
    expect(one.success).toBe(false)
  })

  it('rejects a funnel with fewer than two steps', () => {
    const r = FunnelDefinition.safeParse({ steps: [{ event: 'a' }], window_seconds: 3600 })
    expect(r.success).toBe(false)
  })

  it('rejects a non-integer window', () => {
    const r = FunnelDefinition.safeParse({
      steps: [{ event: 'a' }, { event: 'b' }],
      window_seconds: 1.5,
    })
    expect(r.success).toBe(false)
  })

  it('rejects a zero or negative window', () => {
    for (const window_seconds of [0, -1]) {
      const r = FunnelDefinition.safeParse({
        steps: [{ event: 'a' }, { event: 'b' }],
        window_seconds,
      })
      expect(r.success).toBe(false)
    }
  })

  it('accepts a null segment_id, and rejects a zero one', () => {
    const nulled = FunnelDefinition.safeParse({
      steps: [{ event: 'a' }, { event: 'b' }],
      window_seconds: 60,
      segment_id: null,
    })
    const zero = FunnelDefinition.safeParse({
      steps: [{ event: 'a' }, { event: 'b' }],
      window_seconds: 60,
      segment_id: 0,
    })
    expect(nulled.success).toBe(true)
    expect(zero.success).toBe(false)
  })
})
