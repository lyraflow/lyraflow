import { describe, expect, it } from 'vitest'
import { summarise } from './summarise.js'

const trait = (key: string) => ({ kind: 'trait', key, operator: '=', value: 'x' }) as const
const group = (...children: unknown[]) => ({ kind: 'group', op: 'and', children }) as const

describe('summarise', () => {
  it('renders a single trait without group chrome', () => {
    expect(summarise(trait('plan') as never)).toBe('plan = x')
  })
  it('joins a group with its operator', () => {
    expect(summarise(group(trait('a'), trait('b')) as never)).toBe('a = x and b = x')
  })
  it('parenthesises a nested group so precedence is not lost in one line', () => {
    const root = { kind: 'group', op: 'or', children: [trait('a'), group(trait('b'), trait('c'))] }
    expect(summarise(root as never)).toBe('a = x or (b = x and c = x)')
  })
  it('renders a behaviour as a readable clause', () => {
    const b = {
      kind: 'behavior',
      event: 'checkout',
      aggregate: 'count',
      window: { kind: 'last', n: 30, unit: 'days' },
      operator: '>=',
      value: 3,
    }
    expect(summarise(b as never)).toBe('count of checkout in last 30 days >= 3')
  })
  it('marks a negated node', () => {
    expect(summarise({ kind: 'not', child: trait('a') } as never)).toBe('not (a = x)')
  })

  // --- Mutations invented beyond the brief --------------------------------
  //
  // Every trait/group fixture above uses the same operator ('=') and the
  // same value ('x') on every node, and every top-level test is a
  // two-child group. A `summarise` that swapped `key`/`operator`, hard-coded
  // '=' or 'x', always joined with the literal string 'and', or dropped a
  // node's own value in favour of another node's, would still pass every
  // test above. Distinct operators/values per node, per-node join
  // correctness, and a 3-child group close that gap.

  it('renders each node with its own operator and value, not another node in the tree', () => {
    const root = {
      kind: 'group',
      op: 'or',
      children: [
        { kind: 'trait', key: 'plan', operator: '!=', value: 'free' },
        { kind: 'trait', key: 'age', operator: '>', value: 18 },
      ],
    }
    expect(summarise(root as never)).toBe('plan != free or age > 18')
  })

  it('joins a 3-child group with the operator between every pair, not just twice at the ends', () => {
    const root = group(trait('a'), trait('b'), trait('c'))
    expect(summarise(root as never)).toBe('a = x and b = x and c = x')
  })

  it('renders an "or" group distinctly from an "and" group built from the same children', () => {
    const children = [trait('a'), trait('b')]
    const andSummary = summarise({ kind: 'group', op: 'and', children } as never)
    const orSummary = summarise({ kind: 'group', op: 'or', children } as never)
    expect(andSummary).not.toBe(orSummary)
    expect(andSummary).toBe('a = x and b = x')
    expect(orSummary).toBe('a = x or b = x')
  })

  it('renders a non-count behaviour using its own aggregate, property, window unit, operator and value', () => {
    const b = {
      kind: 'behavior',
      event: 'page_view',
      aggregate: 'sum',
      property: 'duration_ms',
      window: { kind: 'last', n: 6, unit: 'hours' },
      operator: '<',
      value: 500,
    }
    expect(summarise(b as never)).toBe('sum of duration_ms of page_view in last 6 hours < 500')
  })

  it('renders an "ever" window distinctly from a "last" window', () => {
    const b = {
      kind: 'behavior',
      event: 'signup',
      aggregate: 'count',
      window: { kind: 'ever' },
      operator: '>=',
      value: 1,
    }
    expect(summarise(b as never)).toBe('count of signup in ever >= 1')
  })

  it('renders a context node using its own field, scope and value', () => {
    const c = { kind: 'context', field: 'country', scope: 'latest', operator: '=', value: 'US' }
    expect(summarise(c as never)).toBe('country (latest) = US')
  })

  it('renders a lifecycle node using its own field and value', () => {
    const l = {
      kind: 'lifecycle',
      field: 'first_seen',
      operator: '>=',
      value: '2026-01-01T00:00:00Z',
    }
    expect(summarise(l as never)).toBe('first_seen >= 2026-01-01T00:00:00Z')
  })

  it('negates a group, not just a trait, and still nests it correctly', () => {
    const root = { kind: 'not', child: group(trait('a'), trait('b')) }
    expect(summarise(root as never)).toBe('not (a = x and b = x)')
  })
})
