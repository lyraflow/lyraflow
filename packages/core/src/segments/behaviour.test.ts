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

  it('excludes suppressed events from the single scan', () => {
    const { pass } = build([beh()])
    // Per-EVENT, inside the pass, so "ran import 3 times" counts only
    // surviving events. Filtering at the person level here would count
    // erased events toward a threshold and then hide the person only if the
    // whole history predates the boundary.
    expect(pass.cte).toContain('timestamp <= dictGetOrDefault(')
    expect(pass.cte).toMatch(/\) AS e\s*\n\s*WHERE NOT \(dictHas/)
  })

  it('collapses many behaviours into one GROUP BY', () => {
    const { pass } = build([beh(), beh({ event: 'invite_teammate' })])
    const sql = pass.cte ?? ''
    expect(sql.match(/GROUP BY/g)).toHaveLength(1)
    expect(sql.match(/FROM events/g)).toHaveLength(1)
  })

  // Three, not one: `resolved` is substituted once to project the join key
  // (the SELECT), and twice more inside the per-event suppression guard —
  // notSuppressedExpr binds `person` into a shared `key` expression and then
  // uses that key in BOTH the dictHas guard and the dictGetOrDefault lookup,
  // so the text appears twice there even though behaviourCte passes it in
  // only once. Fixed at three regardless of how many behavioural nodes are
  // in the tree, i.e. it is not re-evaluated per node.
  it('emits the identity expression exactly three times — the projection, and twice inside the suppression guard', () => {
    const { pass } = build([beh(), beh({ event: 'a' }), beh({ event: 'b' })])
    const sql = pass.cte ?? ''
    expect(sql.match(/two-stage identity resolution/g)).toHaveLength(3)
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

describe('attribute columns in the scan', () => {
  const attr = (attribute: string, value: string) =>
    ({ source: 'attribute', attribute, operator: '=', value }) as never

  // A predicate compiles to a bare column reference, and the subquery it
  // sits over selects an explicit list -- so a column the scan did not ask
  // for is a query that does not parse, not one that answers wrongly.
  it('projects a column a predicate names', () => {
    const { pass } = build([beh({ where: [attr('utm_campaign', 'august-digest')] })])
    expect(pass.cte).toContain('utm_campaign')
  })

  // The pin that stops "just project all fourteen" arriving later as a
  // tidy-up. `events` is the hot path and it is columnar: fourteen unused
  // columns would be read by every segment evaluation in the product, to
  // serve the ones that use none.
  it('projects nothing extra when no predicate names an attribute', () => {
    const { pass } = build([beh({ where: [{ property: 'plan', operator: '=', value: 'pro' }] })])
    for (const column of ['utm_campaign', 'device_type', 'country', 'referrer', 'os', 'city']) {
      expect(pass.cte, column).not.toContain(column)
    }
  })

  it('projects each named column once, however many predicates name it', () => {
    const { pass } = build([
      beh({ where: [attr('path', '/a'), attr('path', '/b')] }),
      beh({ where: [attr('path', '/c'), attr('os', 'macos')] }),
    ])
    // The PROJECTION only -- between the inner SELECT and its FROM. The
    // text before that is the aggregates, where every predicate mentions
    // its own column and four `path`s are expected.
    const cte = pass.cte as string
    const projection = cte.slice(cte.indexOf('SELECT project_id'), cte.indexOf('FROM events'))
    expect(projection.match(/\bpath\b/g)).toHaveLength(1)
    expect(projection).toContain('os')
  })

  // One behaviour naming a column puts it in the ONE scan every behaviour
  // reads, so a second behaviour's predicate on the same column compiles
  // against a projection it did not itself ask for. That is fine, and it is
  // worth pinning: the collection is over the whole tree, not per node.
  it('collects across every behaviour in the tree, not just the first', () => {
    const { pass } = build([
      beh({ where: [attr('path', '/a')] }),
      beh({ where: [attr('city', 'x')] }),
    ])
    expect(pass.cte).toContain('path')
    expect(pass.cte).toContain('city')
  })
})
