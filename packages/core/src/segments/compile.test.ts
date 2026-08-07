import { describe, expect, it } from 'vitest'
import type { FilterNode, SegmentQuery } from './ast.js'
import { compileSegment } from './compile.js'
import { SegmentValidationError } from './validate.js'

const compile = (filter: FilterNode) =>
  compileSegment({
    query: { ast_version: 1, filter } as SegmentQuery,
    projectId: 42,
    database: 'lyraflow',
    now: new Date('2026-08-07T00:00:00.000Z'),
  })

const trait: FilterNode = { kind: 'trait', key: 'plan', operator: '=', value: 'trial' }

const nest = (depth: number): FilterNode => {
  let node: FilterNode = trait
  for (let i = 0; i < depth; i++) node = { kind: 'group', op: 'and', children: [node] }
  return node
}

describe('compileSegment', () => {
  it('always filters suppressed people, even for a trivial tree', () => {
    // The caller has no way to express this and no way to remove it.
    expect(compile(trait).sql).toContain('dictHas')
    expect(compile(trait).sql).toContain('suppressed_persons')
  })

  it('injects project_id as a bound parameter and never from the tree', () => {
    const { sql, params } = compile(trait)
    expect(sql).not.toMatch(/project_id = 42/)
    expect(Object.values(params)).toContain(42)
  })

  it('omits the behavioural join when the tree has no behaviours', () => {
    const { sql } = compile(trait)
    expect(sql).not.toContain('LEFT JOIN beh')
    expect(sql).not.toContain('FROM events')
  })

  it('LEFT JOINs the behavioural pass when there is one', () => {
    const { sql } = compile({
      kind: 'behavior',
      event: 'x',
      aggregate: 'count',
      operator: '>=',
      value: 1,
      window: { kind: 'last', n: 7, unit: 'days' },
    })
    expect(sql).toContain('LEFT JOIN beh')
  })

  it("compiles the spec's worked example end to end", () => {
    const { sql, params } = compile({
      kind: 'group',
      op: 'and',
      children: [
        trait,
        {
          kind: 'behavior',
          event: 'import_started',
          aggregate: 'count',
          operator: '>=',
          value: 3,
          window: { kind: 'last', n: 7, unit: 'days' },
        },
        {
          kind: 'not',
          child: {
            kind: 'behavior',
            event: 'invite_teammate',
            aggregate: 'count',
            operator: '>=',
            value: 1,
            window: { kind: 'ever' },
          },
        },
      ],
    })
    expect(sql).toContain('SELECT count()')
    expect(sql.match(/FROM events/g)).toHaveLength(1)
    expect(Object.values(params)).toContain('import_started')
    expect(Object.values(params)).toContain('invite_teammate')
  })

  // Every column the compiler's own CTEs expose must be produced by them.
  // person_id in particular is the join key for all three CTEs, and the
  // plan's traits CTE selected and grouped by it without ever computing it.
  it('produces person_id in every CTE that is joined on it', () => {
    const { sql } = compile(trait)
    // base, traits — one identity expression each, and the aliases prove the
    // column exists rather than being assumed.
    expect(sql.match(/AS person_id/g)?.length).toBeGreaterThanOrEqual(2)
    expect(sql.match(/two-stage identity resolution/g)?.length).toBeGreaterThanOrEqual(2)
  })

  it('surfaces cost warnings without refusing the query', () => {
    const { warnings } = compile({
      kind: 'behavior',
      event: '*',
      aggregate: 'count',
      operator: '>=',
      value: 1,
      window: { kind: 'ever' },
    })
    expect(warnings).toHaveLength(2)
  })

  it('throws before emitting SQL for a tree past the caps', () => {
    expect(() => compile(nest(12))).toThrow(SegmentValidationError)
  })

  /**
   * The test above cannot tell "validated first" from "validated after the
   * SQL was built and thrown away" — the plan flags exactly this. This one
   * can, without needing to observe a return value that never arrives.
   *
   * A tree this deep is rejected by validateTree after ten levels, because it
   * throws while counting rather than after walking. Every SQL-building step
   * instead recurses the whole tree, so building first overflows the stack and
   * raises a RangeError. Asserting the error is a SegmentValidationError is
   * therefore an assertion about which ran first.
   */
  it('rejects an over-deep tree by validating, not by exhausting the stack', () => {
    expect(() => compile(nest(40_000))).toThrow(SegmentValidationError)
  })
})
