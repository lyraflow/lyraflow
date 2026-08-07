import { describe, expect, it } from 'vitest'
import { Params } from '../segments/params.js'
import { SUPPRESSION_NEVER, notSuppressedExpr } from './suppression.js'

describe('notSuppressedExpr', () => {
  it('guards the timestamp comparison behind dictHas', () => {
    const params = new Params()
    const sql = notSuppressedExpr({
      database: 'lyraflow',
      projectId: 7,
      params,
      person: 'base.person_id',
      instant: 'base.last_seen',
    })
    // dictHas is the fail-closed half: on a dictionary that never loaded it
    // THROWS (Code 156, measured), failing the query instead of quietly
    // reporting "not suppressed" for everyone. It must gate the dictGet, not
    // sit beside it.
    expect(sql).toMatch(/NOT \(dictHas\('lyraflow\.suppressed_persons'.*\) AND /s)
    expect(sql).toContain('base.last_seen <= dictGetOrDefault(')
  })

  it('defaults the boundary to the far future, so a lone dictGet still hides', () => {
    const params = new Params()
    const sql = notSuppressedExpr({
      database: 'lyraflow',
      projectId: 7,
      params,
      person: 'p',
      instant: 't',
    })
    expect(sql).toContain(SUPPRESSION_NEVER)
    // The default is the far future and NOT the far past: reached on its own,
    // `t <= far future` is true for every event, so the NOT hides the person.
    // The far past would reveal every deleted person instead — the exact
    // failure mode that made Plan 2's identity resolution silently degrade.
    expect(sql).not.toContain('toDateTime(0)')
  })

  it('binds the project id rather than interpolating it', () => {
    const params = new Params()
    const sql = notSuppressedExpr({
      database: 'lyraflow',
      projectId: 7,
      params,
      person: 'p',
      instant: 't',
    })
    // SUPPRESSION_NEVER ("toDateTime(4294967295)") itself contains the digit
    // '7', so a bare `not.toContain('7')` would fail even against a correct
    // implementation. Strip that expected constant out first, and only then
    // confirm no OTHER raw '7' (i.e. the interpolated projectId) survives.
    expect(sql.replace(SUPPRESSION_NEVER, '')).not.toContain('7')
    expect(Object.values(params.values)).toContain(7)
  })
})
