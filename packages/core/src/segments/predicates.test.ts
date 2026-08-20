import { describe, expect, it, vi } from 'vitest'
import type { Behavior, FilterNode } from './ast.js'
import { Params } from './params.js'
import { treeExpr } from './predicates.js'

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
