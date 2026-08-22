import { describe, expect, it } from 'vitest'
import type { FunnelStep } from '../../api/types.js'
import {
  COLLAPSE_ON_LOAD_MIN_STEPS,
  collapsedOnLoad,
  stepComplete,
  stepSummary,
} from './stepSummary.js'

const behaviour = {
  kind: 'behavior' as const,
  event: 'docs_search',
  aggregate: 'count' as const,
  window: { kind: 'last' as const, n: 14, unit: 'days' as const },
  operator: '=' as const,
  value: 1,
}

describe('stepComplete', () => {
  it('needs an event name', () => {
    expect(stepComplete({ event: '' })).toBe(false)
    expect(stepComplete({ event: '   ' })).toBe(false)
    expect(stepComplete({ event: '$page' })).toBe(true)
  })

  it('treats a step with no audience as complete', () => {
    // Absent is a finished state. Requiring an audience would leave every
    // ordinary step permanently expanded.
    expect(stepComplete({ event: '$page' })).toBe(true)
  })

  it('refuses a step whose audience does not parse against the real AST', () => {
    // The seeded draft is a trait with an empty key -- a legal shape and an
    // unfinished value. Collapsing it would hide the one field standing
    // between the operator and a saveable funnel.
    const draft: FunnelStep = {
      event: '$page',
      audience: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'trait', key: '', operator: '=', value: '' }],
      },
    }
    expect(stepComplete(draft)).toBe(false)
  })

  it('accepts a step whose audience does parse', () => {
    expect(stepComplete({ event: '$page', audience: behaviour })).toBe(true)
  })
})

describe('collapsedOnLoad', () => {
  const done = (n: number): FunnelStep => ({ event: `e${n}` })

  it('leaves a short funnel entirely expanded', () => {
    // Collapsing exists so a long definition is readable. A two-step funnel
    // already fits on screen, so folding it shut costs two clicks and buys
    // nothing -- the cost of the feature without its benefit.
    expect(collapsedOnLoad([done(1), done(2)])).toEqual([])
    expect(collapsedOnLoad([done(1), done(2), done(3)])).toEqual([])
  })

  it('folds the complete steps of a long funnel', () => {
    const steps = Array.from({ length: COLLAPSE_ON_LOAD_MIN_STEPS }, (_, i) => done(i + 1))
    expect(collapsedOnLoad(steps)).toEqual(steps.map((_, i) => i))
  })

  it('leaves an unfinished step open however long the funnel', () => {
    // A collapsed row would hide the one field standing between the operator
    // and a saveable funnel.
    const steps = [done(1), done(2), { event: '' }, done(4), done(5)]
    expect(collapsedOnLoad(steps)).toEqual([0, 1, 3, 4])
  })
})

describe('stepSummary', () => {
  it('is just the event when there is nothing else to say', () => {
    expect(stepSummary({ event: 'docs_search' })).toBe('docs_search')
  })

  it('reads the predicates in the same words the expanded form uses', () => {
    // Not a third phrasing. A collapsed row that described a step
    // differently from its own expanded form would make a reader distrust
    // both, so this goes through `wherePhrase` like everything else.
    const s = stepSummary({
      event: '$page',
      where: [{ property: 'path', operator: '=', value: '/docs' }],
    })
    expect(s).toContain('$page')
    expect(s).toContain('/docs')
    expect(s.startsWith('$page · where ')).toBe(true)
  })

  it('reports an audience by shape rather than spelling out the whole tree', () => {
    const s = stepSummary({ event: 'docs_search', audience: behaviour })
    expect(s).toContain('audience:')
    expect(s).toContain('docs_search')
  })

  it('names an unset step rather than rendering a blank row', () => {
    // Unreachable through the UI (`stepComplete` refuses to collapse it) but
    // a funnel written through the API can carry anything the schema allows,
    // and a blank collapsed row is one the reader must click to identify.
    expect(stepSummary({ event: '' })).toBe('Not set')
  })

  it('keeps both clauses when a step has predicates AND an audience', () => {
    const s = stepSummary({
      event: '$page',
      where: [{ property: 'path', operator: '=', value: '/docs' }],
      audience: behaviour,
    })
    expect(s).toContain('where ')
    expect(s).toContain('audience:')
    expect(s.split(' · ')).toHaveLength(3)
  })
})
