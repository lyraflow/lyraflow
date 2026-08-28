import { describe, expect, it } from 'vitest'
import {
  ALL_OPERATORS,
  Context,
  Lifecycle,
  OPERATOR_FAMILY,
  SegmentQuery,
  Trait,
  WherePredicate,
  operatorArity,
} from './ast.js'
import type { FilterNode } from './ast.js'
import { Params } from './params.js'
import { treeExpr, wherePredicate } from './predicates.js'

/**
 * A fixed `now`, so every relative-date assertion names the instant it
 * expects rather than racing the clock. 7 days before it is
 * `2026-08-20 12:00:00.000`; 6 hours before it is `2026-08-27 06:00:00.000`.
 */
const NOW = new Date('2026-08-27T12:00:00.000Z')

const build = (node: FilterNode) => {
  const params = new Params()
  return { sql: treeExpr(node, { params, aliasFor: new Map(), now: NOW }), params }
}

const compileWhere = (w: WherePredicate) => {
  const params = new Params()
  return { sql: wherePredicate(w, params, NOW), params }
}

const trait = (over: Record<string, unknown>) =>
  ({ kind: 'trait', key: 'plan', ...over }) as unknown as FilterNode
const context = (over: Record<string, unknown>) =>
  ({ kind: 'context', field: 'utm_campaign', scope: 'latest', ...over }) as unknown as FilterNode
const lifecycle = (over: Record<string, unknown>) =>
  ({ kind: 'lifecycle', field: 'last_seen', ...over }) as unknown as FilterNode

describe('the operator vocabulary itself', () => {
  it('gives every operator exactly one family', () => {
    // The guard the exhaustive Record cannot express on its own: a family
    // array can gain a member without OPERATOR_FAMILY being wrong, if the
    // new member is simply never added to any array.
    for (const op of ALL_OPERATORS) expect(OPERATOR_FAMILY[op]).toBeDefined()
    expect(new Set(ALL_OPERATORS).size).toBe(ALL_OPERATORS.length)
  })

  it('says which operators take no value, and which take a window', () => {
    expect(operatorArity('is_set')).toBe('none')
    expect(operatorArity('is_true')).toBe('none')
    expect(operatorArity('between')).toBe('two')
    expect(operatorArity('contains')).toBe('one')
    expect(operatorArity('in_last')).toBe('window')
  })
})

describe('text operators', () => {
  it('folds BOTH sides, so a match is case-insensitive', () => {
    const { sql, params } = build(trait({ operator: 'contains', value: 'Checkout' }))
    // Both sides. Folding only the needle is the shape that passes a test
    // written with a lowercase haystack and fails on real data.
    expect(sql).toContain('lowerUTF8(t_str[')
    expect(sql).toMatch(/position\(lowerUTF8\(.+\), lowerUTF8\(\{p\d+:String\}\)\) > 0/)
    expect(Object.values(params.values)).toContain('Checkout')
  })

  it('uses lowerUTF8 rather than lower, so folding is not ASCII-only', () => {
    // Measured against ClickHouse 24.8 rather than assumed: `lower` folds
    // neither `ΑΘΗΝΑ` nor `ÇÖĞ`, `lowerUTF8` folds both. Neither folds
    // Turkish dotted `İ` -- see `textExpr`'s own comment, which records the
    // gap rather than implying the function is complete.
    const { sql } = build(trait({ operator: 'contains', value: 'Αθηνα' }))
    expect(sql).toContain('lowerUTF8')
    expect(sql).not.toMatch(/[^UTF8]\blower\(/)
  })

  it('compiles each of the six spellings to its own SQL', () => {
    const of = (operator: string) => build(trait({ operator, value: 'x' })).sql
    expect(of('contains')).toContain('> 0')
    expect(of('not_contains')).toContain('= 0')
    expect(of('starts_with')).toMatch(/^startsWith\(/)
    expect(of('not_starts_with')).toMatch(/^NOT startsWith\(/)
    expect(of('ends_with')).toMatch(/^endsWith\(/)
    expect(of('not_ends_with')).toMatch(/^NOT endsWith\(/)
  })

  it('reads a column for an attribute predicate and a map slot for a property', () => {
    expect(
      compileWhere({
        source: 'attribute',
        attribute: 'url',
        operator: 'starts_with',
        value: 'https://',
      }).sql,
    ).toContain('lowerUTF8(url)')
    expect(
      compileWhere({ property: 'path', operator: 'starts_with', value: '/docs' }).sql,
    ).toContain('lowerUTF8(properties[')
  })

  it('binds the needle rather than interpolating it', () => {
    const { sql } = build(trait({ operator: 'contains', value: "') OR 1=1 --" }))
    expect(sql).not.toContain('OR 1=1')
  })
})

describe('presence operators', () => {
  // The reason this family exists at all: a ClickHouse Map returns the value
  // type's default for an absent key, so `!= ''` cannot separate "no plan"
  // from "plan is the empty string". Nothing but mapContains can.
  it('tests a trait through t_has_num, the one map holding every key', () => {
    const { sql } = build(trait({ operator: 'is_set' }))
    expect(sql).toMatch(/^mapContains\(t_has_num, \{p\d+:String\}\)$/)
    // NOT t_str: a numeric trait has no entry there and would read as unset.
    expect(sql).not.toContain('t_str')
  })

  it('tests BOTH property bags, because routing is per value', () => {
    const { sql } = compileWhere({ property: 'seats', operator: 'is_set' })
    expect(sql).toContain('mapContains(properties,')
    expect(sql).toContain('mapContains(properties_num,')
  })

  it('tests emptiness on a column, which always exists', () => {
    expect(
      compileWhere({ source: 'attribute', attribute: 'utm_source', operator: 'is_set' }).sql,
    ).toBe("utm_source != ''")
    expect(build(context({ operator: 'is_set' })).sql).toBe("first_campaign != ''")
  })

  it('negates by wrapping the same test, so the two are complementary', () => {
    const set = build(trait({ operator: 'is_set' })).sql
    const notSet = build(trait({ operator: 'is_not_set' })).sql
    expect(notSet).toBe(`NOT (${set})`)
  })

  it('binds no value, so nothing is left over to reach SQL', () => {
    const { params } = build(trait({ operator: 'is_set', value: 'ignored' }))
    expect(Object.values(params.values)).not.toContain('ignored')
  })
})

describe('boolean operators', () => {
  it('compares against the text ingest actually stored', () => {
    const { sql, params } = build(trait({ operator: 'is_true' }))
    expect(sql).toMatch(/^t_str\[\{p\d+:String\}\] = \{p\d+:String\}$/)
    expect(Object.values(params.values)).toContain('true')
  })

  it('is false compares against "false", not merely the negation of true', () => {
    // `NOT (x = 'true')` would also match a person with no such property at
    // all, which is a different population from "the flag is off".
    const { sql, params } = build(trait({ operator: 'is_false' }))
    expect(sql).not.toContain('NOT')
    expect(Object.values(params.values)).toContain('false')
  })
})

describe('relative date operators', () => {
  it('resolves the window against the caller-supplied now, not the clock', () => {
    const { params } = build(lifecycle({ operator: 'in_last', value: { n: 7, unit: 'days' } }))
    expect(Object.values(params.values)).toContain('2026-08-20 12:00:00.000')
  })

  it('counts hours as hours', () => {
    const { params } = build(lifecycle({ operator: 'in_last', value: { n: 6, unit: 'hours' } }))
    expect(Object.values(params.values)).toContain('2026-08-27 06:00:00.000')
  })

  it('compares a lifecycle column directly, with no null guard it does not need', () => {
    const { sql } = build(lifecycle({ operator: 'in_last', value: { n: 7, unit: 'days' } }))
    expect(sql).toMatch(/^\(last_seen >= \{p\d+:DateTime64\(3\)\}\)$/)
    expect(sql).not.toContain('ifNull')
  })

  it('parses a trait as a date and makes an unparseable one a definite non-match', () => {
    const { sql } = build(trait({ operator: 'in_last', value: { n: 7, unit: 'days' } }))
    expect(sql).toContain('parseDateTime64BestEffortOrNull(t_str[')
    // Without ifNull, a NULL date is dropped by BOTH in_last and not_in_last
    // -- the two stop being complementary and those people vanish from every
    // result rather than appearing in exactly one.
    expect(sql).toMatch(/^ifNull\(/)
  })

  it('makes not_in_last the exact negation of in_last', () => {
    const inLast = build(trait({ operator: 'in_last', value: { n: 7, unit: 'days' } })).sql
    const notInLast = build(trait({ operator: 'not_in_last', value: { n: 7, unit: 'days' } })).sql
    expect(notInLast).toBe(`NOT ${inLast}`)
  })
})

describe('which operators each target admits', () => {
  const parses = (schema: { safeParse: (v: unknown) => { success: boolean } }, node: unknown) =>
    schema.safeParse(node).success

  it('lets a trait and a property take every family, each with its own value shape', () => {
    const clauses = [
      { operator: '=', value: 'trial' },
      { operator: 'contains', value: 'pro' },
      { operator: 'is_set' },
      { operator: 'is_true' },
      { operator: 'in_last', value: { n: 7, unit: 'days' } },
    ]
    for (const clause of clauses) {
      expect(parses(Trait, { kind: 'trait', key: 'plan', ...clause })).toBe(true)
      expect(parses(WherePredicate, { property: 'plan', ...clause })).toBe(true)
    }
  })

  it('refuses a text or relative operator that arrives without its value', () => {
    // The families are not interchangeable just because they are new: a
    // substring match with nothing to match is a half-built row, and the
    // editor must not be able to save one.
    expect(parses(Trait, { kind: 'trait', key: 'plan', operator: 'contains' })).toBe(false)
    expect(parses(Trait, { kind: 'trait', key: 'plan', operator: 'in_last' })).toBe(false)
  })

  it('refuses a flag or a date on a column, which is never either', () => {
    for (const operator of ['is_true', 'is_false', 'in_last', 'not_in_last']) {
      expect(
        parses(Context, {
          kind: 'context',
          field: 'country',
          scope: 'latest',
          operator,
          value: { n: 1, unit: 'days' },
        }),
      ).toBe(false)
      expect(
        parses(WherePredicate, {
          source: 'attribute',
          attribute: 'url',
          operator,
          value: { n: 1, unit: 'days' },
        }),
      ).toBe(false)
    }
  })

  it('refuses text and presence on a lifecycle bound, which is always set', () => {
    for (const operator of ['contains', 'is_set', 'is_not_set']) {
      expect(
        parses(Lifecycle, { kind: 'lifecycle', field: 'first_seen', operator, value: 'x' }),
      ).toBe(false)
    }
  })

  it('refuses every new family on a behavioural count', () => {
    for (const operator of ['contains', 'is_set', 'is_true', 'in_last']) {
      expect(
        parses(SegmentQuery, {
          ast_version: 1,
          filter: {
            kind: 'behavior',
            event: 'import',
            aggregate: 'count',
            operator,
            value: 3,
            window: { kind: 'ever' },
          },
        }),
      ).toBe(false)
    }
  })

  it('refuses a number where a substring belongs', () => {
    expect(parses(Trait, { kind: 'trait', key: 'seats', operator: 'contains', value: 5 })).toBe(
      false,
    )
  })

  it('refuses a relative window that is not a positive whole number of hours or days', () => {
    const bad = [
      { n: 0, unit: 'days' },
      { n: 1.5, unit: 'days' },
      { n: 1, unit: 'weeks' },
      { n: 4000, unit: 'days' },
    ]
    for (const value of bad) {
      expect(parses(Trait, { kind: 'trait', key: 't', operator: 'in_last', value })).toBe(false)
    }
  })
})

describe('already-saved trees', () => {
  // AST_VERSION is deliberately NOT bumped by this change, and that claim is
  // only true if every previously-valid tree still parses to the same thing.
  // Asserted rather than stated in a comment, because the union's member
  // ORDER is what makes it true and a reorder would not fail anything else.
  it('parse unchanged, which is why AST_VERSION stays at 1', () => {
    const saved = {
      ast_version: 1,
      filter: {
        kind: 'group',
        op: 'and',
        children: [
          { kind: 'trait', key: 'plan', operator: '=', value: 'trial' },
          { kind: 'trait', key: 'seats', operator: 'between', value: [2, 10] },
          { kind: 'context', field: 'country', scope: 'latest', operator: '!=', value: 'TR' },
          { kind: 'lifecycle', field: 'first_seen', operator: '>=', value: '2026-01-01T00:00:00Z' },
          {
            kind: 'behavior',
            event: 'import',
            aggregate: 'count',
            operator: '>=',
            value: 3,
            window: { kind: 'last', n: 7, unit: 'days' },
            where: [{ property: 'path', operator: '=', value: '/' }],
          },
        ],
      },
    }
    const parsed = SegmentQuery.safeParse(saved)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data).toEqual(saved)
  })
})
