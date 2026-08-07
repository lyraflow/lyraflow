import { describe, expect, it } from 'vitest'
import { resolvedPersonExpr } from './resolve.js'

describe('resolvedPersonExpr', () => {
  it('short-circuits on user_id but still applies the alias stage', () => {
    const sql = resolvedPersonExpr({ database: 'lyraflow' })
    expect(sql).toContain("user_id != ''")

    // resolvedPersonExpr prepends a leading `/* ... */` documentation
    // comment that itself names both dictionaries (see resolve.ts) — useful
    // in ClickHouse's query_log, but it means measuring indexOf against the
    // *full* string (comment included) is vacuous: the comment mentions
    // 'identity_bindings' before 'person_aliases' regardless of what the
    // actual expression underneath does, so that comparison would still
    // pass against an implementation with stage 2 deleted, or gated behind
    // the same `user_id == ''` short-circuit that guards stage 1 (the
    // historical /v1/alias-is-a-no-op bug, reproduced verbatim). An earlier
    // version of this test made exactly that mistake — caught in review.
    //
    // Strip the comment first, so what follows is a claim about the code,
    // not the prose describing it: the remaining text must literally BEGIN
    // with the stage-2 dictGetOrDefault call — i.e. stage 2 is the
    // outermost operation, applied over the whole stage-1 result rather
    // than gated onto one branch of it — and 'identity_bindings' must
    // appear nested *inside* that call's arguments, not merely somewhere in
    // the string.
    const code = sql.replace(/^\/\*.*?\*\/\s*/s, '')
    expect(code.startsWith("dictGetOrDefault('lyraflow.person_aliases'")).toBe(true)
    expect(code.indexOf('identity_bindings')).toBeGreaterThan(code.indexOf('person_aliases'))
  })

  it('qualifies both dictionaries with the database', () => {
    const sql = resolvedPersonExpr({ database: 'lyraflow' })
    expect(sql).toContain("'lyraflow.identity_bindings'")
    expect(sql).toContain("'lyraflow.person_aliases'")
  })

  it('passes the event timestamp as the range key so resolution is time-aware', () => {
    expect(resolvedPersonExpr({ database: 'lyraflow' })).toContain('timestamp')
  })

  // `toContain('anonymous_id)')` was vacuous: stage 1's key tuple is
  // `(project_id, anonymous_id)`, which already ends in that exact substring,
  // so the assertion passed with the fallback argument replaced by `''`.
  // dictGetOrDefault's default is its LAST argument, immediately after the
  // range key, so anchoring on `toDateTime(timestamp), anonymous_id)` is a
  // claim about the default specifically — the key tuple cannot supply it.
  // Live test 4 in this file pins the same property behaviourally; this one
  // now at least discriminates on the shape.
  it('falls back to the anonymous id when no binding exists', () => {
    expect(resolvedPersonExpr({ database: 'lyraflow' })).toContain(
      'toDateTime(timestamp), anonymous_id)',
    )
  })

  // Beyond the brief: the `alias` option is part of the documented interface
  // (resolvedPersonExpr(opts: { database: string; alias?: string })) but
  // untested by the brief's own Step 1 fixture. Plan 3's segment compiler
  // joins events under a table alias (e.g. `events e`), so every column this
  // expression touches must be qualifiable, not just the dictionary names.
  it('qualifies every column reference with the given table alias', () => {
    const sql = resolvedPersonExpr({ database: 'lyraflow', alias: 'e' })
    expect(sql).toContain('e.user_id')
    expect(sql).toContain('e.project_id')
    expect(sql).toContain('e.anonymous_id')
    expect(sql).toContain('e.timestamp')
    // Bare, unqualified column names must not remain — a partial rewrite
    // that qualifies some columns but not others would resolve against the
    // wrong table the moment this expression sits in a multi-table query.
    expect(sql).not.toMatch(/[^.]\buser_id\b/)
    expect(sql).not.toMatch(/[^.]\bproject_id\b/)
    expect(sql).not.toMatch(/[^.]\banonymous_id\b/)
    expect(sql).not.toMatch(/[^.]\btimestamp\b/)
  })

  it('defaults to unqualified columns when no alias is given', () => {
    const sql = resolvedPersonExpr({ database: 'lyraflow' })
    expect(sql).not.toMatch(/\w\.\w*user_id/)
  })

  // This module builds SQL text from caller-supplied values (`database`,
  // `alias`); per the module's own constraints, anything that reaches the
  // SQL must be validated, not interpolated blindly, even though every
  // current caller in this codebase passes a fixed literal. `database` sits
  // inside a *quoted* dictionary-name string literal
  // (`'<database>.identity_bindings'`), so the immediate risk is a caller
  // breaking out of that string with an embedded quote, not a bare
  // identifier-injection into unquoted SQL — validating both the same way
  // (safe-identifier characters only) closes that off without needing two
  // different escaping strategies.
  it('rejects a database name that is not a safe identifier', () => {
    expect(() => resolvedPersonExpr({ database: "lyraflow'; DROP TABLE events; --" })).toThrow(
      /database/i,
    )
  })

  it('rejects a table alias that is not a safe identifier', () => {
    expect(() =>
      resolvedPersonExpr({ database: 'lyraflow', alias: 'e; DROP TABLE events; --' }),
    ).toThrow(/alias/i)
  })
})
