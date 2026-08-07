import { describe, expect, it } from 'vitest'
import type { FilterNode, SegmentQuery } from './ast.js'
import {
  MAX_BEHAVIOR_NODES,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  SegmentValidationError,
  costWarnings,
  validateTree,
} from './validate.js'

const leaf: FilterNode = { kind: 'trait', key: 'plan', operator: '=', value: 'trial' }
const q = (filter: FilterNode): SegmentQuery => ({ ast_version: 1, filter })

function nest(depth: number): FilterNode {
  let node: FilterNode = leaf
  for (let i = 0; i < depth; i++) node = { kind: 'group', op: 'and', children: [node] }
  return node
}

describe('validateTree', () => {
  it('accepts a tree at exactly the depth limit and rejects one past it', () => {
    expect(() => validateTree(q(nest(MAX_TREE_DEPTH - 1)))).not.toThrow()
    expect(() => validateTree(q(nest(MAX_TREE_DEPTH)))).toThrow(SegmentValidationError)
  })

  it('rejects a wide tree on node count even when it is shallow', () => {
    const children = Array.from({ length: MAX_TREE_NODES + 1 }, () => leaf)
    // Depth 2, so this can only be caught by the node-count cap.
    let err: unknown
    try {
      validateTree(q({ kind: 'group', op: 'or', children: children.slice(0, 50) }))
      validateTree(
        q({
          kind: 'group',
          op: 'or',
          children: [
            { kind: 'group', op: 'or', children: children.slice(0, 50) },
            { kind: 'group', op: 'or', children: children.slice(0, 50) },
            { kind: 'group', op: 'or', children: children.slice(0, 50) },
          ],
        }),
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SegmentValidationError)
    expect((err as SegmentValidationError).code).toBe('nodes')
  })

  it('caps behavioural nodes separately from total nodes', () => {
    // Each behaviour node adds a conditional aggregate to the single events
    // pass, so these are the expensive ones — a tree can be well under the
    // node cap and still be far too many aggregates.
    const beh: FilterNode = {
      kind: 'behavior',
      event: 'x',
      aggregate: 'count',
      operator: '>=',
      value: 1,
      window: { kind: 'last', n: 1, unit: 'days' },
    }
    const children = Array.from({ length: MAX_BEHAVIOR_NODES + 1 }, () => beh)
    let err: unknown
    try {
      validateTree(q({ kind: 'group', op: 'or', children }))
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(SegmentValidationError)
    expect((err as SegmentValidationError).code).toBe('behaviors')
  })
})

describe('costWarnings', () => {
  it('flags an `ever` window and names the node responsible', () => {
    const warnings = costWarnings(
      q({
        kind: 'group',
        op: 'and',
        children: [
          leaf,
          {
            kind: 'behavior',
            event: 'import_started',
            aggregate: 'count',
            operator: '>=',
            value: 1,
            window: { kind: 'ever' },
          },
        ],
      }),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.path).toBe('filter.children[1]')
    expect(warnings[0]?.reason).toMatch(/ever/i)
  })

  it('flags a wildcard event separately from an `ever` window', () => {
    const warnings = costWarnings(
      q({
        kind: 'behavior',
        event: '*',
        aggregate: 'count',
        operator: '>=',
        value: 1,
        window: { kind: 'last', n: 1, unit: 'days' },
      }),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.path).toBe('filter')
    expect(warnings[0]?.reason).toMatch(/every event/i)
  })

  it('returns no warnings for an ordinary bounded tree', () => {
    expect(
      costWarnings(
        q({
          kind: 'behavior',
          event: 'import_started',
          aggregate: 'count',
          operator: '>=',
          value: 3,
          window: { kind: 'last', n: 7, unit: 'days' },
        }),
      ),
    ).toEqual([])
  })
})
