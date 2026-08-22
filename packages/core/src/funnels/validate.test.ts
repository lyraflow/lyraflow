import { describe, expect, it } from 'vitest'
import type { FilterNode } from '../segments/ast.js'
import type { FunnelDefinition } from './ast.js'
import {
  FunnelValidationError,
  MAX_FUNNEL_BEHAVIOR_NODES,
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

/** A behaviour node with a bounded window — the cheap shape. */
const behaviour = (event: string): FilterNode => ({
  kind: 'behavior',
  event,
  aggregate: 'count',
  window: { kind: 'last', n: 14, unit: 'days' },
  operator: '=',
  value: 1,
})

/** A behaviour node with an `ever` window — the shape that warns. */
const everBehaviour = (event: string): FilterNode => ({
  kind: 'behavior',
  event,
  aggregate: 'count',
  window: { kind: 'ever' },
  operator: '=',
  value: 1,
})

const group = (children: FilterNode[]): FilterNode => ({ kind: 'group', op: 'and', children })

describe('audiences', () => {
  it('accepts a definition whose steps carry audiences', () => {
    expect(() =>
      validateFunnel({
        steps: [
          { event: 'a', audience: behaviour('docs_search') },
          { event: 'b', audience: group([behaviour('x'), behaviour('y')]) },
        ],
        window_seconds: 3600,
      }),
    ).not.toThrow()
  })

  it('rejects a definition whose audiences exceed the funnel-wide behaviour cap', () => {
    // Two steps, each holding more than half the cap: legal per tree
    // (MAX_BEHAVIOR_NODES is 25), illegal for the funnel.
    const many = (n: number) => group(Array.from({ length: n }, (_, i) => behaviour(`e${i}`)))
    let thrown: unknown
    try {
      validateFunnel({
        steps: [
          { event: 'a', audience: many(20) },
          { event: 'b', audience: many(20) },
        ],
        window_seconds: 3600,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(FunnelValidationError)
    expect((thrown as FunnelValidationError).code).toBe('audience')
    expect((thrown as FunnelValidationError).message).toContain(String(MAX_FUNNEL_BEHAVIOR_NODES))
  })

  it('rejects an audience that breaks the per-tree caps, naming the step', () => {
    // A tree nested past MAX_TREE_DEPTH (10). Built as nested groups.
    let deep: FilterNode = behaviour('x')
    for (let i = 0; i < 12; i++) deep = group([deep])
    let thrown: unknown
    try {
      validateFunnel({
        steps: [{ event: 'a' }, { event: 'b', audience: deep }],
        window_seconds: 3600,
      })
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(FunnelValidationError)
    expect((thrown as FunnelValidationError).code).toBe('audience')
    // The step must be named -- "this funnel is invalid" is not actionable.
    expect((thrown as FunnelValidationError).message).toContain('step 2')
  })

  it('reports an audience cost warning against the step that carries it', () => {
    const warnings = funnelCostWarnings(
      {
        steps: [{ event: 'a' }, { event: 'b', audience: everBehaviour('docs_search') }],
        window_seconds: 3600,
      },
      { since: new Date('2026-08-01T00:00:00Z'), until: new Date('2026-08-08T00:00:00Z') },
    )
    const ever = warnings.find((w) => w.reason.includes('`ever` window'))
    expect(ever).toBeDefined()
    // Prefixed with the step. This audience is a bare leaf, not wrapped in a
    // group, so the path has no `children[N]` segment at all -- that's the
    // format validate.ts's walk emits and the UI's costWarningPath parses.
    expect(ever?.path).toBe('steps.1.filter')
  })

  it('leaves a definition with no audience producing exactly the warnings it did before', () => {
    const def = { steps: [{ event: 'a' }, { event: 'b' }], window_seconds: 3600 }
    const range = {
      since: new Date('2026-08-01T00:00:00Z'),
      until: new Date('2026-08-08T00:00:00Z'),
    }
    expect(funnelCostWarnings(def, range)).toEqual([])
  })
})
