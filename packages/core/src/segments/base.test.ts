import { describe, expect, it } from 'vitest'
import { CONTEXT_FIELDS } from './ast.js'
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

  it('takes latest context by last_seen and first touch by first_seen', () => {
    const { sql } = build()
    expect(sql).toMatch(/argMax\(latest_country,\s*last_seen\)/)
    expect(sql).toMatch(/argMin\(first_source,\s*first_seen\)/)
  })
})
