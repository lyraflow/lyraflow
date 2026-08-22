import { describe, expect, it } from 'vitest'
import { AST_VERSION } from './ast.js'
import type { FilterNode, SegmentQuery } from './ast.js'
import {
  MEMBER_PAGE_SIZE,
  TRAITS_PER_MEMBER_MAX,
  compileSegment,
  memberProjection,
  traitsCte,
} from './compile.js'
import { Params } from './params.js'
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

  it('scopes the base population to the suppression boundary, not presence alone', () => {
    const compiled = compileSegment({
      query: { ast_version: 1, filter: trait } as SegmentQuery,
      projectId: 7,
      database: 'lyraflow',
      now: new Date('2026-08-07T00:00:00.000Z'),
    })
    // The person survives if they have activity AFTER the boundary. Asserting
    // only that "dictHas" appears would pass for the old permanent-suppression
    // predicate too, which is exactly what this change replaces.
    expect(compiled.sql).toContain("last_seen <= dictGetOrDefault('lyraflow.suppressed_persons'")
    // The OLD predicate, gone: `dictHas(...) = 0`. Matched narrowly rather than
    // as a bare `= 0`, which appears legitimately elsewhere in a compiled tree
    // (a numeric trait predicate, `has_num` checks) and would make this
    // assertion fail for reasons unrelated to suppression.
    expect(compiled.sql).not.toMatch(/dictHas\('lyraflow\.suppressed_persons'[^)]*\)\)\s*= 0/)
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

  const members = (
    filter: FilterNode,
    cursor?: { lastSeen: string; personId: string; asOf: string },
  ) =>
    compileSegment({
      query: { ast_version: 1, filter } as SegmentQuery,
      projectId: 42,
      database: 'lyraflow',
      now: new Date('2026-08-07T00:00:00.000Z'),
      select: 'members',
      cursor,
    })

  it('selects the member projection, not merely the base CTE columns', () => {
    const { sql } = members(trait)
    expect(sql).not.toContain('count() AS person_count')
    // Aliased context columns exist ONLY in the member projection. person_id,
    // first_seen and last_seen all appear in the base CTE regardless of mode
    // (see 'produces person_id in every CTE that is joined on it'), so
    // asserting on those alone would pass against a projection replaced by a
    // literal.
    expect(sql).toContain('latest_country AS country')
    expect(sql).toContain('first_source AS utm_source')
    // And they must be absent in count mode, which is what makes this a
    // discriminating assertion rather than a coincidence.
    expect(compile(trait).sql).not.toContain('AS country')
  })

  describe('traits on a member row', () => {
    // Reversing a documented decision, so it gets a test that states what
    // changed: the projection used to say traits were "deliberately absent"
    // because a per-person map of arbitrary size is unbounded. They are here
    // now, bounded, and both halves matter.
    it('selects both trait maps and the real total', () => {
      const { sql } = members(trait)
      expect(sql).toContain('AS traits')
      expect(sql).toContain('AS traits_num')
      expect(sql).toContain('AS trait_total')
      // Count mode selects one number and nothing else -- traits there would
      // be a per-person map on a query that returns a single row.
      expect(compile(trait).sql).not.toContain('AS traits')
    })

    // THE defect this filter exists to prevent. The traits CTE builds t_str
    // and t_num over the same key set, so every string trait has a Float64
    // default of 0 sitting in t_num under its own name. Without the
    // has_num filter every person comes back with `plan: 0` beside their
    // real `plan: "pro"`, and nothing about the response looks wrong.
    it('splits the two maps by has_num, so a string trait has no numeric twin', () => {
      const { sql } = members(trait)
      expect(sql).toContain('mapFilter((k, v) -> t_has_num[k] = 0, t_str)')
      expect(sql).toContain('mapFilter((k, v) -> t_has_num[k] = 1, t_num)')
    })

    it('caps each map and sorts before it slices', () => {
      const { sql } = members(trait)
      expect(sql).toContain(`, 1, ${TRAITS_PER_MEMBER_MAX})`)
      // Sorted first: a Map's key order is whatever groupArray produced, so
      // an unsorted slice returns a different fifty on different runs of the
      // same query -- and page two of a walk would disagree with page one
      // about which traits a person has.
      expect(sql).toContain('arraySlice(arraySort(mapKeys(')
    })

    // Slicing keys and values as two independent arrays lines up only while
    // both are in the same order, which is an assumption about
    // mapKeys/mapValues that nothing here enforces. Looking each value up by
    // its key cannot mispair.
    it('looks values up by key rather than slicing values in parallel', () => {
      const { sql } = members(trait)
      expect(sql).toContain('arrayMap(k -> t_str[k]')
      expect(sql).toContain('arrayMap(k -> t_num[k]')
      expect(sql).not.toContain('mapValues')
    })

    // The count is what makes the cap honest -- it is the person's real
    // total, so a capped row can say what it held back instead of reading as
    // the whole set. A UInt64 reaches JSON as a string, and a count that
    // arrives as `"51"` is one a reader compares with `>` against a number.
    it('reports the total as a UInt32, not the size of the capped map', () => {
      expect(members(trait).sql).toContain('toUInt32(length(t_has_num)) AS trait_total')
    })
  })

  it('orders by last_seen then person_id so the ordering is total', () => {
    // Without the person_id tiebreaker, keyset pagination skips or repeats
    // rows whenever two people share a last_seen.
    expect(members(trait).sql).toMatch(/ORDER BY\s+last_seen DESC,\s*person_id ASC/)
  })

  it('bounds the page', () => {
    expect(members(trait).sql).toMatch(new RegExp(`LIMIT ${MEMBER_PAGE_SIZE}`))
  })

  it('carries project_id and the suppression filter in members mode too', () => {
    // A second output mode is exactly where a guardrail gets left behind.
    const { sql, params } = members(trait)
    expect(sql).toContain('dictHas')
    expect(sql).toContain('suppressed_persons')
    expect(sql).not.toMatch(/project_id = 42/)
    expect(Object.values(params)).toContain(42)
  })

  it('continues after the cursor position, binding both components', () => {
    const { sql, params } = members(trait, {
      lastSeen: '2026-08-06 10:00:00.000',
      personId: 'alice',
      // Not read by compileSegment (see cursor.ts) but required by the
      // Cursor type, which is the HTTP layer's contract, not this one's.
      asOf: '2026-08-07T00:00:00.000Z',
    })
    // Strict lexicographic continuation on (last_seen DESC, person_id ASC).
    expect(sql).toMatch(/last_seen < \{p\d+:DateTime64\(3\)\}/)
    expect(sql).toContain('person_id >')
    expect(Object.values(params)).toContain('2026-08-06 10:00:00.000')
    expect(Object.values(params)).toContain('alice')
    expect(sql).not.toContain("'alice'")
  })

  it('emits no cursor predicate on the first page', () => {
    // Not a bare `.not.toContain('last_seen <')`: the suppression predicate
    // now reads `last_seen <= dictGetOrDefault(...)`, and `<=` starts with
    // `<`, so that substring is present on every compiled query regardless
    // of cursor. Anchored to the cursor predicate's own shape instead —
    // `last_seen < {` followed by a bound parameter — which suppression's
    // `<=` never produces.
    expect(members(trait).sql).not.toMatch(/last_seen < \{/)
  })

  it('still counts when select is omitted', () => {
    expect(compile(trait).sql).toContain('SELECT count()')
  })

  // Found while hunting for untested clauses per the plan's test-discipline
  // note: `select === 'members' && cursor` is a compound guard, and no other
  // test exercises the `select === 'count'` half of it. Dropping that clause
  // (leaving only `cursor`) let every other test keep passing.
  it('ignores a cursor in count mode', () => {
    const { sql } = compileSegment({
      query: { ast_version: 1, filter: trait } as SegmentQuery,
      projectId: 42,
      database: 'lyraflow',
      now: new Date('2026-08-07T00:00:00.000Z'),
      select: 'count',
      cursor: {
        lastSeen: '2026-08-06 10:00:00.000',
        personId: 'alice',
        asOf: '2026-08-07T00:00:00.000Z',
      },
    })
    expect(sql).toContain('SELECT count()')
    // See "emits no cursor predicate on the first page" for why this is a
    // regex anchored to the cursor shape rather than a bare substring check.
    expect(sql).not.toMatch(/last_seen < \{/)
  })
})

describe('shared member projection', () => {
  it('is the projection the members select actually uses', () => {
    // Exported so the funnel people query compiles the SAME columns. A second
    // projection would drift first at `trait_total`, which is the field that
    // tells a reader what was held back -- and a reader shown a truncated
    // trait list with no count believes it is complete.
    const p = memberProjection()
    for (const field of [
      'person_id',
      'first_seen',
      'last_seen',
      'traits',
      'traits_num',
      'trait_total',
    ]) {
      expect(p).toContain(field)
    }
  })

  it('builds a traits CTE that reads person_traits and nothing else', () => {
    const cte = traitsCte({ database: 'lyraflow', projectId: 7, params: new Params() })
    expect(cte).toContain('traits AS (')
    expect(cte).toContain('person_traits')
    expect(cte).toContain('t_has_num')
  })

  // A pure extraction. If the members SQL moves at all -- even whitespace --
  // the refactor was not one, and every segment member walk in the product
  // goes through this code. Captured byte-for-byte from the pre-extraction
  // compiler (`memberProjection` module-private, the traits CTE inlined)
  // with these exact inputs, so this is not a substring check that a moved
  // fragment could still satisfy.
  const BASELINE_MEMBERS_SQL =
    "WITH\n  dev AS (\n    SELECT\n      project_id,\n      anonymous_id,\n      user_id,\n      minMerge(first_seen) AS m_first_seen,\n      maxMerge(last_seen)  AS timestamp,\n      maxMerge(last_seen)  AS m_last_seen,\n      argMaxMerge(latest_country) AS m_latest_country,\n      argMaxMerge(latest_region) AS m_latest_region,\n      argMaxMerge(latest_city) AS m_latest_city,\n      argMaxMerge(latest_device) AS m_latest_device,\n      argMaxMerge(latest_os) AS m_latest_os,\n      argMaxMerge(latest_browser) AS m_latest_browser,\n      argMinMerge(first_referrer) AS m_first_referrer,\n      argMinMerge(first_source) AS m_first_source,\n      argMinMerge(first_medium) AS m_first_medium,\n      argMinMerge(first_campaign) AS m_first_campaign,\n      argMinMerge(first_country) AS m_first_country,\n      argMinMerge(first_region) AS m_first_region,\n      argMinMerge(first_city) AS m_first_city,\n      argMinMerge(first_device) AS m_first_device,\n      argMinMerge(first_os) AS m_first_os,\n      argMinMerge(first_browser) AS m_first_browser\n    FROM device_index\n    WHERE project_id = {p0:UInt32}\n    GROUP BY project_id, anonymous_id, user_id, month\n  ),\n  base AS (\n    SELECT\n      /* two-stage identity resolution: stage 1 (identity_bindings) resolves device -> person for anonymous events, then stage 2 (person_aliases) resolves person -> canonical unconditionally */ dictGetOrDefault('lyraflow.person_aliases', 'canonical_id', (dev.project_id, if(dev.user_id != '', dev.user_id, dictGetOrDefault('lyraflow.identity_bindings', 'person_id', (dev.project_id, dev.anonymous_id), toDateTime(dev.timestamp), dev.anonymous_id))), if(dev.user_id != '', dev.user_id, dictGetOrDefault('lyraflow.identity_bindings', 'person_id', (dev.project_id, dev.anonymous_id), toDateTime(dev.timestamp), dev.anonymous_id))) AS person_id,\n      min(m_first_seen) AS first_seen,\n      max(m_last_seen)  AS last_seen,\n      argMax(m_latest_country, m_last_seen) AS latest_country,\n      argMax(m_latest_region, m_last_seen) AS latest_region,\n      argMax(m_latest_city, m_last_seen) AS latest_city,\n      argMax(m_latest_device, m_last_seen) AS latest_device,\n      argMax(m_latest_os, m_last_seen) AS latest_os,\n      argMax(m_latest_browser, m_last_seen) AS latest_browser,\n      argMin(m_first_referrer, m_first_seen) AS first_referrer,\n      argMin(m_first_source, m_first_seen) AS first_source,\n      argMin(m_first_medium, m_first_seen) AS first_medium,\n      argMin(m_first_campaign, m_first_seen) AS first_campaign,\n      argMin(m_first_country, m_first_seen) AS first_country,\n      argMin(m_first_region, m_first_seen) AS first_region,\n      argMin(m_first_city, m_first_seen) AS first_city,\n      argMin(m_first_device, m_first_seen) AS first_device,\n      argMin(m_first_os, m_first_seen) AS first_os,\n      argMin(m_first_browser, m_first_seen) AS first_browser\n    FROM dev\n    GROUP BY person_id\n  ),\n  traits AS (\n    SELECT\n      /* two-stage identity resolution: stage 1 (identity_bindings) resolves device -> person for anonymous events, then stage 2 (person_aliases) resolves person -> canonical unconditionally */ dictGetOrDefault('lyraflow.person_aliases', 'canonical_id', (tr.project_id, if(tr.user_id != '', tr.user_id, dictGetOrDefault('lyraflow.identity_bindings', 'person_id', (tr.project_id, tr.anonymous_id), toDateTime(tr.timestamp), tr.anonymous_id))), if(tr.user_id != '', tr.user_id, dictGetOrDefault('lyraflow.identity_bindings', 'person_id', (tr.project_id, tr.anonymous_id), toDateTime(tr.timestamp), tr.anonymous_id))) AS person_id,\n      CAST((groupArray(trait_key), groupArray(m_value_str)), 'Map(String, String)')  AS t_str,\n      CAST((groupArray(trait_key), groupArray(m_value_num)), 'Map(String, Float64)') AS t_num,\n      CAST((groupArray(trait_key), groupArray(m_has_num)),   'Map(String, UInt8)')   AS t_has_num\n    FROM (\n      SELECT\n        anonymous_id, user_id, project_id, trait_key,\n        argMaxMerge(value_str) AS m_value_str,\n        argMaxMerge(value_num) AS m_value_num,\n        argMaxMerge(has_num)   AS m_has_num,\n        now() AS timestamp\n      FROM person_traits\n      WHERE project_id = {p3:UInt32}\n      GROUP BY project_id, anonymous_id, user_id, trait_key\n    ) AS tr\n    GROUP BY person_id\n  )\nSELECT\n  person_id,\n  first_seen,\n  last_seen,\n  latest_country AS country,\n  latest_region AS region,\n  latest_city AS city,\n  latest_device AS device_type,\n  latest_os AS os,\n  latest_browser AS browser,\n  first_referrer AS referrer,\n  first_source AS utm_source,\n  first_medium AS utm_medium,\n  first_campaign AS utm_campaign,\n  CAST((arraySlice(arraySort(mapKeys(mapFilter((k, v) -> t_has_num[k] = 0, t_str))), 1, 50), arrayMap(k -> t_str[k], arraySlice(arraySort(mapKeys(mapFilter((k, v) -> t_has_num[k] = 0, t_str))), 1, 50))), 'Map(String, String)') AS traits,\n  CAST((arraySlice(arraySort(mapKeys(mapFilter((k, v) -> t_has_num[k] = 1, t_num))), 1, 50), arrayMap(k -> t_num[k], arraySlice(arraySort(mapKeys(mapFilter((k, v) -> t_has_num[k] = 1, t_num))), 1, 50))), 'Map(String, Float64)') AS traits_num,\n  toUInt32(length(t_has_num)) AS trait_total\nFROM base\nLEFT JOIN traits USING (person_id)\n\nWHERE NOT (dictHas('lyraflow.suppressed_persons', ({p4:UInt32}, base.person_id)) AND base.last_seen <= dictGetOrDefault('lyraflow.suppressed_persons', 'suppressed_at', ({p4:UInt32}, base.person_id), toDateTime64(4294967295, 6)))\n  AND (t_str[{p1:String}] = {p2:String})\nORDER BY last_seen DESC, person_id ASC\nLIMIT 100"

  it('leaves the segment members query unchanged, byte-for-byte', () => {
    const q = compileSegment({
      query: {
        ast_version: AST_VERSION,
        filter: { kind: 'trait', key: 'plan', operator: '=', value: 'pro' },
      },
      projectId: 7,
      database: 'lyraflow',
      now: new Date('2026-08-22T00:00:00Z'),
      select: 'members',
    })
    expect(q.sql).toBe(BASELINE_MEMBERS_SQL)
  })
})
