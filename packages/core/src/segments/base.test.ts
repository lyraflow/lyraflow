import { describe, expect, it } from 'vitest'
import { CONTEXT_FIELDS, LIFECYCLE_FIELDS } from './ast.js'
import { CONTEXT_COLUMNS, baseCte } from './base.js'
import { Params } from './params.js'

const build = () => {
  const params = new Params()
  return { sql: baseCte({ database: 'lyraflow', projectId: 42, params }), params }
}

describe('baseCte', () => {
  it('every allowlisted context field maps to a real column pair', () => {
    // The AST allowlist and this mapping are the two halves of the injection
    // boundary. If a field is added to one and not the other, the compiler
    // either emits an undefined column or silently ignores a filter.
    for (const field of CONTEXT_FIELDS) {
      expect(CONTEXT_COLUMNS[field]).toBeDefined()
      expect(CONTEXT_COLUMNS[field].latest).toMatch(/^[a-z_]+$/)
      expect(CONTEXT_COLUMNS[field].first_touch).toMatch(/^[a-z_]+$/)
    }
    expect(Object.keys(CONTEXT_COLUMNS).sort()).toEqual([...CONTEXT_FIELDS].sort())
  })

  // Beyond the plan's list. Every column CONTEXT_COLUMNS can name has to be
  // one the CTE actually selects, or a filter on it compiles to SQL that
  // references an undefined column and fails only at execution time. The
  // plan's own CONTEXT_COLUMNS named six first_* columns its DEVICE_MERGES
  // never read, which is exactly this defect.
  it('selects every column CONTEXT_COLUMNS can name', () => {
    const { sql } = build()
    for (const field of CONTEXT_FIELDS) {
      for (const scope of ['latest', 'first_touch'] as const) {
        expect(sql).toContain(`AS ${CONTEXT_COLUMNS[field][scope]}`)
      }
    }
  })

  // The lifecycle half of the same boundary, and the one thing about
  // LIFECYCLE_FIELDS that a single source of truth CANNOT make safe.
  //
  // `predicates.ts`'s lifecycleExpr interpolates a lifecycle node's `field`
  // as a bare SQL identifier. Deriving the schema and the UI from one array
  // stops those three drifting apart -- but the array is still an assertion
  // about columns that exist, and `baseCte` builds `first_seen`/`last_seen`
  // into its SQL TEXT rather than reading any list. Nothing else compares
  // the two. A third field added here would compile, validate, render a
  // select option, and fail only when ClickHouse rejected the query.
  it('selects every column a lifecycle condition can name', () => {
    const { sql } = build()
    for (const field of LIFECYCLE_FIELDS) {
      expect(sql).toMatch(new RegExp(`AS\\s+${field}\\b`))
    }
  })

  it('binds project_id rather than interpolating it', () => {
    const { sql, params } = build()
    expect(sql).not.toContain('42')
    expect(Object.values(params.values)).toContain(42)
  })

  it('resolves each device-month at its own last_seen, aliased as timestamp', () => {
    const { sql } = build()
    // resolvedPersonExpr reads a column literally named `timestamp`; the inner
    // query has to supply one or resolution silently reads nothing.
    expect(sql).toMatch(/maxMerge\(last_seen\)\s+AS\s+timestamp/)
  })

  it('groups to one row per person', () => {
    const { sql } = build()
    expect(sql).toContain('GROUP BY person_id')
  })

  // The identified/anonymous distinction a member list marks with an icon
  // (AcceptedTable.tsx's feed icon, taken to its person-level meaning) --
  // true the instant ANY of a person's device-index rows carried a real
  // user_id, cast to a real ClickHouse `Bool` so it reaches JSON as
  // `true`/`false` rather than `1`/`0`.
  it('marks a person identified the instant any of their device rows carried a real user_id', () => {
    const { sql } = build()
    expect(sql).toContain("CAST(max(user_id != ''), 'Bool') AS identified")
  })

  it('takes latest context by last_seen and first touch by first_seen', () => {
    const { sql } = build()
    expect(sql).toMatch(/argMax\(m_latest_country,\s*m_last_seen\)/)
    expect(sql).toMatch(/argMin\(m_first_source,\s*m_first_seen\)/)
  })

  /**
   * A merged value must never be aliased back onto the column it reads.
   * ClickHouse resolves the argument to the alias — a DateTime64 — rather
   * than the underlying AggregateFunction column, and the query dies with
   * "Illegal type DateTime64(3, 'UTC') of argument for aggregate function
   * with Merge suffix". It only bites under a GROUP BY, so the shape tests
   * and schema-clickhouse.test.ts both stay green while the compiled query
   * cannot run at all. Found in Task 11 against a live server.
   */
  it('never aliases a merged value back onto its own column name', () => {
    const { sql } = build()
    const merges = [...sql.matchAll(/\w*Merge\((\w+)\)\s+AS\s+(\w+)/g)]
    expect(merges.length).toBeGreaterThan(0)
    for (const [, column, alias] of merges) {
      expect(alias).not.toBe(column)
    }
  })
})
