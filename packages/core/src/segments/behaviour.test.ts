import { describe, expect, it } from 'vitest'
import type { Behavior } from './ast.js'
import { behaviourCte } from './behaviour.js'
import { Params } from './params.js'

const NOW = new Date('2026-08-07T00:00:00.000Z')

const beh = (over: Partial<Behavior> = {}): Behavior =>
  ({
    kind: 'behavior',
    event: 'import_started',
    aggregate: 'count',
    operator: '>=',
    value: 3,
    window: { kind: 'last', n: 7, unit: 'days' },
    ...over,
  }) as Behavior

const build = (behaviors: Behavior[]) => {
  const params = new Params()
  return {
    pass: behaviourCte({ database: 'lyraflow', projectId: 42, behaviors, params, now: NOW }),
    params,
  }
}

describe('behaviourCte', () => {
  it('returns no CTE when the tree has no behavioural nodes', () => {
    expect(build([]).pass.cte).toBeNull()
  })

  it('collapses many behaviours into one GROUP BY', () => {
    const { pass } = build([beh(), beh({ event: 'invite_teammate' })])
    const sql = pass.cte ?? ''
    expect(sql.match(/GROUP BY/g)).toHaveLength(1)
    expect(sql.match(/FROM events/g)).toHaveLength(1)
  })

  it('emits the identity expression exactly once', () => {
    const { pass } = build([beh(), beh({ event: 'a' }), beh({ event: 'b' })])
    const sql = pass.cte ?? ''
    expect(sql.match(/two-stage identity resolution/g)).toHaveLength(1)
  })

  it('deduplicates by event_id so retried deliveries are not double-counted', () => {
    // events is ReplacingMergeTree ordered by (project_id, timestamp,
    // anonymous_id, event_id); a retry that omitted `timestamp` is stored as a
    // permanent second row. This is the one place that is handled.
    const { pass } = build([beh()])
    expect(pass.cte).toMatch(/LIMIT 1 BY project_id,\s*event_id/)
  })

  /**
   * The plan's version of this test asserted that the 7-day bound appears
   * nowhere in the params. It does appear, and it must: the scan is bounded by
   * the widest window in the tree, and each narrower node re-applies its own
   * bound inside its own countIf. Without that re-application a 7-day
   * condition would silently count 90-day-old events.
   *
   * So this pins the thing the plan's assertion was reaching for — that the
   * bound on the SCAN is the widest one — by reading the parameter used in the
   * scan's WHERE clause specifically, rather than asking whether a value
   * exists anywhere in the bag.
   */
  it('scans from the widest window in the whole tree, not per node', () => {
    const { pass, params } = build([
      beh({ window: { kind: 'last', n: 7, unit: 'days' } }),
      beh({ event: 'other', window: { kind: 'last', n: 90, unit: 'days' } }),
    ])
    const scan =
      /WHERE project_id = \{\w+:UInt32\} AND timestamp >= \{(\w+):DateTime64\(3\)\}/.exec(
        pass.cte ?? '',
      )
    expect(scan).not.toBeNull()
    // 90 days before NOW, not 7.
    expect(params.values[scan?.[1] as string]).toBe('2026-05-09 00:00:00.000')
    // And the narrower node still carries its own bound, inside its aggregate.
    expect(Object.values(params.values)).toContain('2026-07-31 00:00:00.000')
  })

  it('omits the lower bound entirely when any node says `ever`', () => {
    const { pass } = build([beh({ window: { kind: 'ever' } })])
    expect(pass.cte).not.toContain('timestamp >=')
  })

  /**
   * Beyond the plan's list, and the reason it is here: the test above uses a
   * lone `ever` node, so it stays green against an implementation that merely
   * skips nulls when picking the widest window rather than treating one as
   * "no bound at all". That implementation is wrong exactly here — the scan
   * would be bounded at 7 days and the `ever` node would silently receive a
   * truncated answer, with nothing failing.
   */
  it('omits the lower bound when `ever` shares the tree with a bounded node', () => {
    const { pass } = build([
      beh({ window: { kind: 'ever' } }),
      beh({ event: 'other', window: { kind: 'last', n: 7, unit: 'days' } }),
    ])
    // The scan itself must carry no lower bound...
    expect(pass.cte).not.toMatch(
      /WHERE project_id = \{\w+:UInt32\} AND timestamp >= \{\w+:DateTime64\(3\)\}/,
    )
    // ...while the bounded node still applies its own, inside its aggregate.
    expect(pass.cte).toContain('timestamp >=')
  })

  it('gives each behaviour a distinct alias and reports the mapping', () => {
    const a = beh()
    const b = beh({ event: 'other' })
    const { pass } = build([a, b])
    expect(pass.aliasFor.get(a)).toBe('b0')
    expect(pass.aliasFor.get(b)).toBe('b1')
    expect(pass.cte).toContain('AS b0')
    expect(pass.cte).toContain('AS b1')
  })

  it('binds event names rather than interpolating them', () => {
    const { pass, params } = build([beh({ event: "x' OR 1=1 --" })])
    expect(pass.cte).not.toContain('OR 1=1')
    expect(Object.values(params.values)).toContain("x' OR 1=1 --")
  })

  it('matches every event for the `*` wildcard without an event_name predicate', () => {
    const { pass } = build([beh({ event: '*' })])
    expect(pass.cte).not.toContain('event_name =')
  })

  it('uses uniqExact for a distinct aggregate and sum for a sum', () => {
    const { pass } = build([
      beh({ aggregate: 'distinct', property: 'plan' }),
      beh({ aggregate: 'sum', property: 'amount', event: 'purchase' }),
    ])
    expect(pass.cte).toMatch(/uniqExactIf\(/)
    expect(pass.cte).toMatch(/sumIf\(/)
  })
})
