import { describe, expect, it, vi } from 'vitest'
import type { Behavior, FilterNode, WherePredicate } from './ast.js'
import { Params } from './params.js'
import { attributeColumns, treeExpr, wherePredicate } from './predicates.js'

const build = (node: FilterNode, aliasFor = new Map<Behavior, string>()) => {
  const params = new Params()
  return { sql: treeExpr(node, { params, aliasFor }), params }
}

const trait: FilterNode = { kind: 'trait', key: 'plan', operator: '=', value: 'trial' }

describe('treeExpr', () => {
  it('joins group children with the group operator', () => {
    const { sql } = build({ kind: 'group', op: 'or', children: [trait, trait] })
    expect(sql).toMatch(/\(.+ OR .+\)/)
  })

  it('wraps NOT so precedence cannot leak', () => {
    const { sql } = build({
      kind: 'not',
      child: { kind: 'group', op: 'or', children: [trait, trait] },
    })
    expect(sql.startsWith('NOT (')).toBe(true)
  })

  it('compiles a negated behaviour to coalesce, not an anti-join', () => {
    // "never did X" must cost the same as "did X".
    const beh: Behavior = {
      kind: 'behavior',
      event: 'invite_teammate',
      aggregate: 'count',
      operator: '>=',
      value: 1,
      window: { kind: 'ever' },
    }
    const { sql } = build({ kind: 'not', child: beh }, new Map([[beh, 'b0']]))
    expect(sql).toContain('coalesce(b0, 0)')
    expect(sql).not.toMatch(/NOT EXISTS|ANTI/i)
  })

  it('reads a context field from the column its scope selects', () => {
    const { sql: latest } = build({
      kind: 'context',
      field: 'country',
      scope: 'latest',
      operator: '=',
      value: 'DE',
    })
    const { sql: first } = build({
      kind: 'context',
      field: 'utm_source',
      scope: 'first_touch',
      operator: '=',
      value: 'google',
    })
    expect(latest).toContain('latest_country')
    expect(first).toContain('first_source')
  })

  it('reads a numeric trait from value_num and guards on has_num', () => {
    // A string trait leaves value_num at its default 0, so a predicate like
    // `seats < 5` would match every string trait without this guard.
    const { sql } = build({ kind: 'trait', key: 'seats', operator: '<', value: 5 })
    expect(sql).toContain('has_num')
  })

  it('binds every value', () => {
    const { sql, params } = build({
      kind: 'trait',
      key: "k' OR 1=1 --",
      operator: '=',
      value: "v' OR 1=1 --",
    })
    expect(sql).not.toContain('OR 1=1')
    expect(Object.values(params.values)).toContain("k' OR 1=1 --")
    expect(Object.values(params.values)).toContain("v' OR 1=1 --")
  })

  it('compiles between with two bounds', () => {
    const { sql } = build({
      kind: 'lifecycle',
      field: 'first_seen',
      operator: 'between',
      value: ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
    })
    expect(sql).toMatch(/first_seen BETWEEN .+ AND .+/)
  })
})

describe('a lifecycle bound means the same instant on every server (#124)', () => {
  const compileOne = (value: string) => {
    const { params } = build({
      kind: 'lifecycle',
      field: 'first_seen',
      operator: '>=',
      value,
    } as FilterNode)
    return { values: params.values }
  }

  it('compiles a zone-less bound as UTC, whatever the process zone is', () => {
    // Compiled TWICE, in two different zones, and required to produce the same
    // parameter. That is the actual claim -- "resolves as UTC" is one reading
    // of one run, and the defect was that the answer moved with the host.
    vi.stubEnv('TZ', 'Asia/Kolkata')
    const kolkata = compileOne('2026-08-01T10:00')
    // The stub MUST actually take, or this test compares two identical runs
    // and passes against the very defect it is written for. `new Date` on a
    // zone-less form is the thing that used to move; if it does not move here,
    // the fixture is broken rather than the code being right.
    const asLocalInKolkata = new Date('2026-08-01T10:00').toISOString()

    vi.stubEnv('TZ', 'America/Sao_Paulo')
    const saoPaulo = compileOne('2026-08-01T10:00')
    const asLocalInSaoPaulo = new Date('2026-08-01T10:00').toISOString()
    vi.unstubAllEnvs()

    expect(asLocalInKolkata, 'TZ stubbing had no effect — this test would be vacuous').not.toBe(
      asLocalInSaoPaulo,
    )
    expect(kolkata.values).toEqual(saoPaulo.values)
    expect(Object.values(kolkata.values)).toContain('2026-08-01 10:00:00.000')
  })

  it('compiles a bare date as UTC midnight', () => {
    vi.stubEnv('TZ', 'Asia/Kolkata')
    const { values } = compileOne('2026-08-01')
    vi.unstubAllEnvs()
    expect(Object.values(values)).toContain('2026-08-01 00:00:00.000')
  })

  it('still honours an explicit offset rather than overriding it', () => {
    vi.stubEnv('TZ', 'UTC')
    const { values } = compileOne('2026-08-01T10:00:00+05:30')
    vi.unstubAllEnvs()
    expect(Object.values(values)).toContain('2026-08-01 04:30:00.000')
  })
})

describe('attribute predicates', () => {
  const compile = (w: WherePredicate) => {
    const params = new Params()
    return { sql: wherePredicate(w, params), params }
  }

  // The whole point of the feature: a name that used to read an empty map
  // slot now reads the column it was always describing. `utm_campaign` is
  // the one Cem hit -- a $page event carried it, the feed's row detail
  // showed it, and the Where box could not reach it.
  it('compiles to the column itself, with the value bound', () => {
    const { sql, params } = compile({
      source: 'attribute',
      attribute: 'utm_campaign',
      operator: '=',
      value: 'august-digest',
    })
    expect(sql).toMatch(/^utm_campaign = \{/)
    expect(sql).not.toContain('properties')
    expect(Object.values(params.values)).toContain('august-digest')
  })

  // The identifier is interpolated, so it must be the ONLY thing that is:
  // a value reaching SQL unbound here would be the difference between this
  // and every other predicate in the compiler.
  it('binds the value rather than inlining it, for every operator', () => {
    for (const operator of ['=', '!=', '>', '>=', '<', '<='] as const) {
      const { sql } = compile({ source: 'attribute', attribute: 'path', operator, value: '/x' })
      expect(sql, operator).not.toContain("'/x'")
      expect(sql, operator).toContain('path')
    }
    const between = compile({
      source: 'attribute',
      attribute: 'path',
      operator: 'between',
      value: ['/a', '/m'],
    })
    expect(between.sql).toMatch(/^path BETWEEN \{.+\} AND \{.+\}$/)
    expect(Object.values(between.params.values)).toEqual(expect.arrayContaining(['/a', '/m']))
  })

  // Every attribute column is String/LowCardinality(String) in
  // 002_events.sql, and the AST refuses a number for one -- so there is no
  // numeric branch here to take. A `Float64` binding would compare a string
  // column against a number and answer nothing, silently.
  it('always binds as String, never as Float64', () => {
    const { params } = compile({
      source: 'attribute',
      attribute: 'city',
      operator: '=',
      value: '9',
    })
    expect(JSON.stringify(params.values)).not.toContain('Float64')
    for (const [name, value] of Object.entries(params.values)) {
      expect(typeof value, name).toBe('string')
    }
  })

  // A property predicate is what every tree saved before this existed
  // carries, and it must compile exactly as it always did -- through the
  // map, with the key bound, numeric values still routed to properties_num.
  it('leaves a property predicate compiling through the map, unchanged', () => {
    expect(compile({ property: 'plan', operator: '=', value: 'pro' }).sql).toContain('properties[{')
    expect(compile({ property: 'seats', operator: '>', value: 3 }).sql).toContain(
      'properties_num[{',
    )
    // Including one whose NAME is a column: nothing is inferred from the
    // name, so this still reads the property bag.
    expect(compile({ property: 'path', operator: '=', value: '/x' }).sql).toContain('properties[{')
  })
})

describe('attributeColumns', () => {
  it('lists only the attributes a set of predicates names, deduplicated and sorted', () => {
    expect(
      attributeColumns([
        { source: 'attribute', attribute: 'utm_source', operator: '=', value: 'hn' },
        { property: 'plan', operator: '=', value: 'pro' },
        { source: 'attribute', attribute: 'path', operator: '=', value: '/a' },
        { source: 'attribute', attribute: 'utm_source', operator: '!=', value: 'x' },
      ]),
    ).toEqual(['path', 'utm_source'])
  })

  it('is empty for predicates that name no attribute at all', () => {
    expect(attributeColumns([{ property: 'plan', operator: '=', value: 'pro' }])).toEqual([])
    expect(attributeColumns([])).toEqual([])
  })
})
