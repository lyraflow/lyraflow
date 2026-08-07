/** The SELECT-list alias every caller of {@link resolvedPersonExpr} should use. */
export const RESOLVED_PERSON_ALIAS = 'person_id'

// Applies to both `database` and `alias`: neither is caller-supplied user
// input today (every call site in this codebase passes a fixed literal), but
// this module's own rule is that any parameter reaching the SQL is validated,
// not interpolated blindly, regardless of who currently calls it. `database`
// is embedded inside a *quoted* string literal (`'<database>.identity_bindings'`),
// so an unvalidated value could break out of that literal; `alias` is
// embedded unquoted as a bare identifier prefix, so an unvalidated value
// could inject arbitrary SQL directly. A single safe-identifier allowlist
// closes off both.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertSafeIdentifier(value: string, label: string): void {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `resolvedPersonExpr: ${label} must be a safe SQL identifier ([A-Za-z_][A-Za-z0-9_]*), got ${JSON.stringify(value)}`,
    )
  }
}

/**
 * The canonical person for an events row, resolved in two stages.
 *
 * Stage 1 maps device→person and is consulted only for anonymous events; an
 * event that already carries a user_id short-circuits it. Stage 2 maps
 * person→canonical and applies UNCONDITIONALLY, to both branches of stage 1
 * — omitting it is what silently made /v1/alias a no-op for every event
 * carrying the aliased id.
 *
 * Stage 1 is range-aware: the event's own timestamp selects the binding that
 * was in force when it happened, so a shared laptop does not retroactively
 * hand one person's history to another (see identity_bindings_dict_src in
 * 003_identity.sql for how that tiling is derived).
 *
 * Stage 2 is a single lookup with no recursive walk — alias chains are
 * always flattened to depth 1 at write time (see person_aliases' schema
 * comment), so a second lookup could never find anything a first one missed.
 *
 * The returned text is a single self-contained SQL value expression: safe to
 * embed in a SELECT list, a WHERE clause, a JOIN condition, or anywhere else
 * a column expression is valid. It takes no caller-supplied *values* — only
 * `database`/`alias`, which select where the expression looks, not what it
 * returns — so nothing here is an injection surface for event data.
 *
 * `database` is REQUIRED and deliberately has no default. It used to default
 * to 'lyraflow', which duplicated configuration that is already required
 * elsewhere and could silently disagree with it: LYRAFLOW_CLICKHOUSE_DB has
 * no default of its own (see config.ts), and `ensureIdentityDictionaries`
 * creates both dictionaries UNQUALIFIED, i.e. in whatever database the
 * client is connected to. An operator setting
 * LYRAFLOW_CLICKHOUSE_DB=analytics therefore got dictionaries in `analytics.*`
 * and an expression pointing at `lyraflow.*` — a lookup that resolves nobody,
 * answered with dictGetOrDefault's fallback, so identity resolution degrades
 * to "nobody was ever identified" with nothing visibly broken. Making the
 * parameter required means a caller must pass the configured database, and
 * Plan 3's query work cannot inherit the mismatch by omission.
 */
export function resolvedPersonExpr(opts: { database: string; alias?: string }): string {
  const db = opts.database
  assertSafeIdentifier(db, 'database')

  const columnPrefix = opts.alias ? `${opts.alias}.` : ''
  if (opts.alias !== undefined) assertSafeIdentifier(opts.alias, 'alias')

  const bindingsDict = `'${db}.identity_bindings'`
  const aliasesDict = `'${db}.person_aliases'`

  const projectId = `${columnPrefix}project_id`
  const anonymousId = `${columnPrefix}anonymous_id`
  const userId = `${columnPrefix}user_id`
  const timestamp = `${columnPrefix}timestamp`

  // Stage 1: device→person, range-aware via the event's own timestamp,
  // short-circuited by a non-empty user_id. Written out twice below because
  // dictGetOrDefault for stage 2 needs the same value both as the alias
  // lookup key and as the fallback when no alias row exists.
  //
  // `toDateTime(...)` is required, not cosmetic: identity_bindings' RANGE
  // column is plain `DateTime` (see dictionaries.ts), but events.timestamp
  // is `DateTime64(3, 'UTC')` — passing it to dictGetOrDefault unconverted
  // fails at query time with "Illegal type DateTime64(3, 'UTC') ... must be
  // convertible to Int64" (confirmed against a live ClickHouse). The
  // shape-only unit tests beside this file do not catch it; only the
  // live-service suite in packages/server/src/identity/resolve.test.ts does,
  // which is why that suite stays in the server package after this module
  // moved to core — core's own tests must not require a database.
  const stage1 =
    `if(${userId} != '', ${userId}, ` +
    `dictGetOrDefault(${bindingsDict}, 'person_id', (${projectId}, ${anonymousId}), toDateTime(${timestamp}), ${anonymousId}))`

  // Documents the two-stage design directly in the generated SQL (visible in
  // ClickHouse's query_log/EXPLAIN, where this TSDoc is not) and, as a side
  // effect of naming identity_bindings before person_aliases, mirrors this
  // expression's real evaluation order: stage 1 is an *operand* of stage 2's
  // dictGetOrDefault call, so ClickHouse evaluates it first even though
  // stage 2's dictionary name is the outer call and therefore appears first
  // in the text below.
  const comment =
    '/* two-stage identity resolution: stage 1 (identity_bindings) resolves ' +
    'device -> person for anonymous events, then stage 2 (person_aliases) ' +
    'resolves person -> canonical unconditionally */ '

  return `${comment}dictGetOrDefault(${aliasesDict}, 'canonical_id', (${projectId}, ${stage1}), ${stage1})`
}
