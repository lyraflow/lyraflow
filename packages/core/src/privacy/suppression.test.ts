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
    // Wiring check only — SUPPRESSION_NEVER is imported from the module
    // under test, so this alone would pass no matter what value that
    // constant held. It is not what proves the property below.
    expect(sql).toContain(SUPPRESSION_NEVER)

    // The property that actually matters: whatever epoch-seconds literal
    // ends up as the dictGetOrDefault default, it must denote an instant
    // far in the FUTURE relative to now — reached on its own (dictHas true,
    // dictGetOrDefault returning the default), `instant <= default` must
    // stay true for any real event timestamp, so the default cannot sit
    // behind "now". A far-past default would make a lone dictGetOrDefault
    // report "not suppressed" for everyone and silently republish every
    // deleted person — the exact failure mode that made Plan 2's identity
    // resolution silently degrade, and the regression this test exists to
    // pin. The literal is parsed out of the GENERATED SQL rather than taken
    // from SUPPRESSION_NEVER, so an edit that flips the constant toward the
    // past fails here regardless of what literal replaces it.
    //
    // Matches `toDateTime(N)` or `toDateTime64(N, scale)` — the function
    // name gained the `64` and a scale argument when the dictionary's own
    // `suppressed_at` attribute changed from `DateTime` to `DateTime64(6)`
    // (dictionaries.ts), but the first captured group is still the same
    // epoch-SECONDS integer either way.
    const match = sql.match(/toDateTime(?:64)?\((\d+)/)
    expect(match).not.toBeNull()
    const denotedMs = Number(match?.[1]) * 1000
    const tenYearsFromNowMs = Date.now() + 10 * 365 * 24 * 3600 * 1000
    expect(denotedMs).toBeGreaterThan(tenYearsFromNowMs)
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
    // SUPPRESSION_NEVER ("toDateTime64(4294967295, 6)") itself contains the
    // digit '7', so a bare `not.toContain('7')` would fail even against a
    // correct implementation. Strip that expected constant out first, and only then
    // confirm no OTHER raw '7' (i.e. the interpolated projectId) survives.
    expect(sql.replace(SUPPRESSION_NEVER, '')).not.toContain('7')
    expect(Object.values(params.values)).toContain(7)
  })
})
