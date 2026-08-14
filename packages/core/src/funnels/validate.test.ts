import { describe, expect, it } from 'vitest'
import type { FunnelDefinition } from './ast.js'
import {
  FunnelValidationError,
  MAX_FUNNEL_STEPS,
  MAX_WINDOW_SECONDS,
  funnelCostWarnings,
  validateFunnel,
  validateRange,
} from './validate.js'

const def = (steps: number, window = 3600): FunnelDefinition => ({
  steps: Array.from({ length: steps }, (_, i) => ({ event: `e${i}` })),
  window_seconds: window,
})

describe('validateFunnel', () => {
  it('accepts a funnel at the step cap', () => {
    expect(() => validateFunnel(def(MAX_FUNNEL_STEPS))).not.toThrow()
  })

  it('rejects one step past the cap, naming the code', () => {
    try {
      validateFunnel(def(MAX_FUNNEL_STEPS + 1))
      throw new Error('expected validateFunnel to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(FunnelValidationError)
      expect((err as FunnelValidationError).code).toBe('steps')
    }
  })

  it('accepts a window at exactly the cap and rejects one second past it', () => {
    expect(() => validateFunnel(def(2, MAX_WINDOW_SECONDS))).not.toThrow()
    try {
      validateFunnel(def(2, MAX_WINDOW_SECONDS + 1))
      throw new Error('expected validateFunnel to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(FunnelValidationError)
      expect((err as FunnelValidationError).code).toBe('window')
    }
  })
})

describe('validateRange', () => {
  const until = new Date('2026-08-14T00:00:00Z')

  it('rejects a span past 90 days', () => {
    // 91 days before `until`.
    const since = new Date(until.getTime() - 91 * 86_400_000)
    try {
      validateRange({ since, until })
      throw new Error('expected validateRange to throw')
    } catch (err) {
      expect(err).toBeInstanceOf(FunnelValidationError)
      expect((err as FunnelValidationError).code).toBe('range')
    }
  })

  it('accepts exactly 90 days', () => {
    const since = new Date(until.getTime() - 90 * 86_400_000)
    expect(() => validateRange({ since, until })).not.toThrow()
  })

  it('rejects an inverted range', () => {
    expect(() => validateRange({ since: until, until: new Date(until.getTime() - 1000) })).toThrow(
      FunnelValidationError,
    )
  })

  it('rejects a zero-length range', () => {
    expect(() => validateRange({ since: until, until })).toThrow(FunnelValidationError)
  })
})

describe('funnelCostWarnings', () => {
  const range = { since: new Date('2026-08-07T00:00:00Z'), until: new Date('2026-08-14T00:00:00Z') }

  it('warns about a high-volume step event and names it', () => {
    const w = funnelCostWarnings(
      { steps: [{ event: '$page' }, { event: 'signed_up' }], window_seconds: 3600 },
      range,
    )
    expect(w).toHaveLength(1)
    expect(w[0]?.path).toBe('steps.0')
    expect(w[0]?.reason).toContain('$page')
  })

  it('names the index of every high-volume step, not just the first', () => {
    const w = funnelCostWarnings(
      {
        steps: [{ event: 'landing' }, { event: '$page' }, { event: '$identify' }],
        window_seconds: 60,
      },
      range,
    )
    expect(w.map((x) => x.path)).toEqual(['steps.1', 'steps.2'])
  })

  it('is silent for distinct custom events over a short range', () => {
    expect(
      funnelCostWarnings(
        { steps: [{ event: 'login_click' }, { event: 'signed_up' }], window_seconds: 3600 },
        range,
      ),
    ).toEqual([])
  })

  it('warns when the range is at the maximum', () => {
    const wide = {
      since: new Date(range.until.getTime() - 90 * 86_400_000),
      until: range.until,
    }
    const w = funnelCostWarnings(
      { steps: [{ event: 'a' }, { event: 'b' }], window_seconds: 3600 },
      wide,
    )
    expect(w.some((x) => x.path === 'range')).toBe(true)
  })
})
