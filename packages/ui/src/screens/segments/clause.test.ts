import type { Trait, WherePredicate } from '@lyraflow/core/segments/ast.js'
import { Trait as TraitSchema } from '@lyraflow/core/segments/ast.js'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RELATIVE_WINDOW, clauseValueOf, withOperator } from './clause.js'

const trait = (over: Record<string, unknown>) =>
  ({ kind: 'trait', key: 'plan', ...over }) as unknown as Trait

describe('withOperator', () => {
  it('drops the value entirely when the new operator carries none', () => {
    const next = withOperator(trait({ operator: '=', value: 'pro' }), 'is_set')
    // ABSENT, not undefined: the two are the same to `===` and different to
    // `JSON.stringify`, and this tree is serialised on save.
    expect('value' in next).toBe(false)
    expect(JSON.stringify(next)).not.toContain('value')
  })

  it('produces a tree the AST accepts, for every operator', () => {
    // The guard that matters: the editor must not be able to build a row the
    // server then refuses. Checked against the real schema rather than
    // against this module's own idea of the shapes.
    const start = trait({ operator: '=', value: 'pro' })
    for (const op of ['=', 'between', 'contains', 'is_set', 'is_true', 'in_last'] as const) {
      const built = withOperator(start, op)
      // `between` alone is left half-built on purpose -- ValueInput's healing
      // effect owns the second slot -- so it is the one shape not asserted
      // valid here.
      if (op === 'between') continue
      expect(TraitSchema.safeParse(built).success).toBe(true)
    }
  })

  it('carries a scalar across into a text operator rather than making them retype it', () => {
    expect(clauseValueOf(withOperator(trait({ operator: '=', value: 'pro' }), 'contains'))).toBe(
      'pro',
    )
  })

  it('collapses a between tuple to its first slot on the way out', () => {
    expect(clauseValueOf(withOperator(trait({ operator: 'between', value: [2, 10] }), '='))).toBe(2)
  })

  it('starts a relative window at a usable default rather than an empty box', () => {
    expect(clauseValueOf(withOperator(trait({ operator: '=', value: 'pro' }), 'in_last'))).toEqual(
      DEFAULT_RELATIVE_WINDOW,
    )
  })

  it('keeps an existing window when moving between the two relative operators', () => {
    const from = trait({ operator: 'in_last', value: { n: 30, unit: 'days' } })
    expect(clauseValueOf(withOperator(from, 'not_in_last'))).toEqual({ n: 30, unit: 'days' })
  })

  it('does not stringify a window into a comparison value', () => {
    const from = trait({ operator: 'in_last', value: { n: 30, unit: 'days' } })
    expect(clauseValueOf(withOperator(from, '='))).not.toContain('object Object')
  })

  it('leaves the rest of the node alone', () => {
    const next = withOperator(trait({ operator: '=', value: 'pro' }), 'is_set') as Trait
    expect(next.kind).toBe('trait')
    expect(next.key).toBe('plan')
  })

  it('keeps a where predicate on the same half of the union', () => {
    const p = { source: 'attribute', attribute: 'url', operator: '=', value: '/' } as WherePredicate
    const next = withOperator(p, 'starts_with')
    expect(next).toMatchObject({ source: 'attribute', attribute: 'url', value: '/' })
  })
})

describe('clauseValueOf', () => {
  it('is undefined for an operator that carries no value', () => {
    expect(clauseValueOf(trait({ operator: 'is_set' }))).toBeUndefined()
  })
})
