import { join } from 'node:path'
import {
  type ClickHouseClient,
  createChClient,
  createPgPool,
  loadMigrations,
  migrate,
} from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PgDictionarySource, ensureIdentityDictionaries, parsePgUrl } from './dictionaries.js'

describe('parsePgUrl', () => {
  it('extracts the parts the dictionary source needs', () => {
    expect(parsePgUrl('postgres://lyraflow:s3cret@postgres:5432/lyraflow')).toEqual({
      host: 'postgres',
      port: 5432,
      user: 'lyraflow',
      password: 's3cret',
      database: 'lyraflow',
    })
  })

  it('defaults the port when the url omits it', () => {
    expect(parsePgUrl('postgres://u:p@db/lyraflow').port).toBe(5432)
  })

  it('decodes a percent-encoded password', () => {
    expect(parsePgUrl('postgres://u:p%40ss%3Aword@db:5432/lyraflow').password).toBe('p@ss:word')
  })

  it('throws a message that names the variable but never echoes the url', () => {
    expect(() => parsePgUrl('not-a-url')).toThrow(/LYRAFLOW_POSTGRES_URL/)
    expect(() => parsePgUrl('not-a-url')).not.toThrow(/not-a-url/)
  })

  // The WHATWG URL parser reports an IPv6 host bracketed (`[::1]`) — correct
  // per the URL spec, but not a valid ClickHouse POSTGRESQL source `host`.
  it('strips the brackets from an IPv6 host', () => {
    expect(parsePgUrl('postgres://u:p@[::1]:5432/lyraflow').host).toBe('::1')
  })

  // `username`/`password` were already decoded; `pathname` was not, so a
  // database name containing a space or other reserved character arrived
  // percent-encoded instead of literal.
  it('percent-decodes the database name', () => {
    expect(parsePgUrl('postgres://u:p@db/lyra%20flow').database).toBe('lyra flow')
  })

  // `new URL()` accepts a lone, malformed `%` in userinfo without complaint
  // (percent-encoding is only validated on decode) — so this exercises a
  // failure `new URL()` itself cannot catch. Before this was fixed,
  // `decodeURIComponent` ran outside the try and this threw a raw
  // `URIError: URI malformed` instead of the documented, value-free message.
  it('reports a malformed percent-encoding through the same named message, not a raw URIError', () => {
    expect(() => parsePgUrl('postgres://u:p%@db/lyraflow')).toThrow(/LYRAFLOW_POSTGRES_URL/)
  })
})

/**
 * The DDL `ensureIdentityDictionaries` sends necessarily embeds the Postgres
 * password in plain text (see the module docstring). `@clickhouse/client`
 * can attach a chunk of the failing statement itself to `.message`: I
 * confirmed this by hand against a live ClickHouse — a malformed
 * `CREATE DICTIONARY` produces a `SYNTAX_ERROR` whose message echoes back
 * raw, unparsed query text verbatim, including whatever followed the syntax
 * error, which can be the `SOURCE(POSTGRESQL(... password '...' ...))`
 * clause itself. Real ClickHouse HTTP error messages are single-line, so
 * every fixture below is single-line too — an earlier version of this suite
 * used a fixture with the password after several `\n`s, which meant
 * `sanitizeDictionaryError`'s (then-present) first-line-only truncation
 * removed the password from the tested output *before redaction ever ran*.
 * The tests still passed with `redactPassword`'s body replaced by `return
 * text` — the truncation coincidentally did redaction's job for it. A
 * single-line fixture removes that confound: the password can only be gone
 * from the output because `redactPassword` actually removed it.
 *
 * A fake `ClickHouseClient` is used rather than the live test stack because
 * these specific failure shapes (a quote or backslash inside the password,
 * a truncated echo) are awkward or impossible to force live without
 * bypassing `escapeSqlLiteral` itself (see the Task 5 fix report for why
 * that's deliberately not done here). `ensureIdentityDictionaries` only
 * ever calls `ch.command()`, so only that needs implementing; the
 * `as unknown as ClickHouseClient` cast mirrors `createFakeClient`'s
 * `as unknown as Pool` in packages/db/src/migrator.test.ts, used there for
 * the identical reason (a failure mode too slow/flaky to reproduce live on
 * every run).
 */
describe('ensureIdentityDictionaries sanitizes a failure before it can reach a logger', () => {
  /**
   * Builds an error shaped like the ClickHouseError `@clickhouse/client`
   * throws (`.message`, `.code`, `.type`), around a well-formed
   * `password '...'` clause: the escaped password value (escaped the same
   * way `escapeSqlLiteral` in dictionaries.ts escapes it — `\` doubled, then
   * `'` backslash-escaped), a genuine closing quote, and a bit more of a
   * plausible `SOURCE(...)` clause after it.
   *
   * `opts.truncated` omits the closing quote — and everything after it —
   * entirely, reproducing a diagnostic that was cut off mid-value. This
   * matters precisely because `${escaped}` alone, without a trailing `'`,
   * is indistinguishable from a value that just happens to be short: an
   * earlier version of this fixture always appended a closing quote
   * regardless of any option, so the "truncated echo" test below never
   * actually exercised a message *without* one, and reverting the fallback
   * regex's `('|$)` end-of-string branch back to requiring a literal `'`
   * left every test in this file green (see the Task 5 round-3 fix report).
   *
   * Real ClickHouse HTTP error messages are single-line, so this fixture is
   * too, and deliberately lean *before* the password: `sanitizeDictionaryError`
   * caps its output at 200 characters, capped *after* redaction runs, never
   * before — but a verbose preamble here would push the password itself past
   * that mark, and the tests below would then pass even with redaction
   * completely broken (an earlier, multi-line version of this fixture had
   * the identical problem via first-line truncation instead of a character
   * cap — see the same report).
   */
  function chError(password: string, opts: { truncated?: boolean } = {}): Error {
    const escaped = password.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const rest = opts.truncated ? '' : `' db 'lyraflow_test' table 'identity_bindings_dict_src'))`
    const message = `Code: 62. Syntax error near SOURCE(POSTGRESQL(host 'postgres' password '${escaped}${rest}`
    const err = new Error(message)
    Object.assign(err, { code: '62', type: 'SYNTAX_ERROR' })
    return err
  }

  /**
   * A distinct, realistic ClickHouse failure shape — an argument-validation
   * error for the `postgresql` table function that `SOURCE(POSTGRESQL(...))`
   * compiles down to — that echoes an argument value generically, without
   * labelling it "password" at all. Deliberately *not* a `password '...'`
   * clause: `redactPassword`'s clause-shaped fallback regex (pass 3) cannot
   * match this shape no matter how it's written, so only the escaped-literal
   * substitution (pass 2) can catch the leak here. Without a fixture like
   * this, "drop the escaped-literal pass" was an untested mutation — every
   * other fixture puts the escaped password directly after the literal word
   * "password ", where pass 3 alone is already sufficient, so pass 2 was
   * never actually exercised on its own (see the Task 5 round-3 fix report).
   */
  function chErrorArgumentEcho(escapedValue: string): Error {
    const message = `Code: 36. DB::Exception: Bad arguments: 'postgresql' table function argument 4: '${escapedValue}'`
    const err = new Error(message)
    Object.assign(err, { code: '36', type: 'BAD_ARGUMENTS' })
    return err
  }

  function fakeCh(onCommand: (call: number) => void): ClickHouseClient {
    let call = 0
    return {
      command: vi.fn(async () => {
        call += 1
        onCommand(call)
      }),
    } as unknown as ClickHouseClient
  }

  function pgSourceWith(password: string): PgDictionarySource {
    return { host: 'postgres', port: 5432, user: 'lyraflow', password, database: 'lyraflow_test' }
  }

  /** Every surface a caller (or a log serializer walking `cause`) could read
   * the thrown error through. */
  async function surfacesFor(ch: ClickHouseClient, pg: PgDictionarySource): Promise<string[]> {
    let thrown: Error | undefined
    try {
      await ensureIdentityDictionaries(ch, pg)
    } catch (err) {
      thrown = err as Error
    }
    expect(thrown).toBeDefined()
    return [
      thrown?.message ?? '',
      thrown?.cause instanceof Error ? thrown.cause.message : '',
      JSON.stringify(thrown),
      JSON.stringify(thrown?.cause),
    ]
  }

  // THE test for this fix, and the one the review's own reproduction pins:
  // reverting `sanitizeDictionaryError` to forward `err` unredacted, *or*
  // reducing `redactPassword`'s body to `return text` (an identity
  // function — proven below, under "mutation proof"), makes
  // `thrown.message` contain `LEAKED_PASSWORD` verbatim and the substring
  // `password '`. Checking `cause` and `JSON.stringify` separately also
  // catches a narrower regression: code that sanitizes the top-level message
  // but forwards the original error as `cause` unchanged.
  it('a single-line error with the password on that line is fully redacted', async () => {
    const LEAKED_PASSWORD = 'MY_LEAKED_SECRET_XYZ'
    const ch = fakeCh(() => {
      throw chError(LEAKED_PASSWORD)
    })
    for (const text of await surfacesFor(ch, pgSourceWith(LEAKED_PASSWORD))) {
      expect(text).not.toContain(LEAKED_PASSWORD)
      expect(text).not.toMatch(/password\s*'/i)
    }
  })

  // A password containing `'` is exactly what a raw (unescaped) redaction
  // pass misses: the DDL — and therefore the error echo — carries the
  // *escaped* form `ab\'cd-SECRET-TAIL`, not the raw `ab'cd-SECRET-TAIL`.
  // The clause sits in its normal `password '...'` position here, so this
  // is primarily a test of the fallback regex's escape-awareness (pass 3);
  // see the argument-echo test below for a shape that isolates pass 2.
  it('a password containing a single quote is fully redacted', async () => {
    const PASSWORD = `ab'cd-SECRET-TAIL`
    const ch = fakeCh(() => {
      throw chError(PASSWORD)
    })
    for (const text of await surfacesFor(ch, pgSourceWith(PASSWORD))) {
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain('SECRET-TAIL')
      expect(text).not.toMatch(/password\s*'/i)
    }
  })

  // A password containing a literal `\` appears, escaped, outside a
  // `password '...'` clause entirely — a shape the fallback regex (pass 3)
  // cannot match by construction, since it requires the literal word
  // "password" nearby. Only the escaped-literal substitution (pass 2) can
  // catch this, which is the point: it is the one fixture in this file that
  // actually fails if pass 2 is dropped while pass 3 is left correct (see
  // the mutation matrix in the Task 5 round-3 fix report).
  it('an escaped password appearing outside a "password \'...\'" clause is still redacted', async () => {
    const PASSWORD = 'back\\slash-SECRET-TAIL'
    const escaped = PASSWORD.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const ch = fakeCh(() => {
      throw chErrorArgumentEcho(escaped)
    })
    for (const text of await surfacesFor(ch, pgSourceWith(PASSWORD))) {
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain('SECRET-TAIL')
    }
  })

  // ClickHouse caps this diagnostic's length (confirmed by hand — see the
  // Task 5 fix report), and where the cut lands is not under this code's
  // control: a partial password with no closing quote is still a leak, and
  // `[^']*'` (requiring a real closing quote) would never match it at all.
  // `{ truncated: true }` is what actually omits the closing quote here —
  // without it, this fixture would (as it originally did) always terminate
  // with a `'`, and this test would pass regardless of whether the fallback
  // regex's end-of-string branch worked at all.
  it('a truncated echo with no closing quote is fully redacted, not left untouched', async () => {
    const LEAKED_PASSWORD = 'MY_LEAKED_SECRET_XYZ'
    const PARTIAL = LEAKED_PASSWORD.slice(0, 12)
    const ch = fakeCh(() => {
      throw chError(PARTIAL, { truncated: true })
    })
    for (const text of await surfacesFor(ch, pgSourceWith(LEAKED_PASSWORD))) {
      expect(text).not.toContain(PARTIAL)
      expect(text).not.toMatch(/password\s*'/i)
    }
  })

  // `type` is read straight off the caught error, same as `.message`, and
  // is untrusted the same way: genuinely unlikely to carry the password via
  // real `@clickhouse/client` output, but `.name` is an own, enumerable
  // property (unlike `.message`), so an unredacted `cause.name = type`
  // would put the password within reach of `JSON.stringify(cause)`,
  // `String(cause)`, and `cause.stack`'s first line even though
  // `thrown.message` itself stayed clean (`type` also feeds the outer
  // message's `label`, which *does* go through `redactPassword` — so this
  // fixture's `thrown.message` is redacted regardless, isolating the
  // `cause.name` path specifically).
  it('redacts the password even if it turns up in the ClickHouseError-shaped type field', async () => {
    const LEAKED_PASSWORD = 'MY_LEAKED_SECRET_XYZ'
    const ch = fakeCh(() => {
      const err = new Error('Code: 1. DB::Exception: some unrelated failure')
      Object.assign(err, { code: '1', type: `WEIRD_TYPE_${LEAKED_PASSWORD}` })
      throw err
    })
    for (const text of await surfacesFor(ch, pgSourceWith(LEAKED_PASSWORD))) {
      expect(text).not.toContain(LEAKED_PASSWORD)
    }
  })

  // Losing which dictionary failed would still be safe, but would make a
  // real fatal log line useless for triage — this pins that regression too.
  it('names which dictionary failed', async () => {
    const ch = fakeCh(() => {
      throw chError('irrelevant')
    })
    await expect(ensureIdentityDictionaries(ch, pgSourceWith('irrelevant'))).rejects.toThrow(
      /identity_bindings/,
    )
  })

  it('identifies the second dictionary by name when only it fails', async () => {
    const ch = fakeCh((call) => {
      if (call === 2) throw chError('irrelevant')
    })
    await expect(ensureIdentityDictionaries(ch, pgSourceWith('irrelevant'))).rejects.toThrow(
      /person_aliases/,
    )
  })

  // Fails before any DDL is built at all — proven separately from the
  // sanitization tests above because there is no `ch.command()` call (and
  // therefore no ClickHouse error) for this one; it is a precondition check
  // on the input itself.
  it('rejects a non-integer port before building any DDL', async () => {
    const ch = fakeCh(() => {
      throw new Error('ch.command should never be reached')
    })
    await expect(
      ensureIdentityDictionaries(ch, { ...pgSourceWith('x'), port: Number.NaN }),
    ).rejects.toThrow(/port must be an integer/)
  })
})

/**
 * A FAILED dictionary still answers every dictGet with the caller's default —
 * that is exactly the "±infinity" failure this mechanism exists to avoid (see
 * dictionaries.ts's docstring) — so a test that only calls dictGet and sees a
 * plausible-looking value would pass just as well against a dictionary that
 * never loaded at all. These tests instead read `system.dictionaries`
 * directly, the only place a FAILED dictionary is visibly distinguishable
 * from a healthy one, and only then exercise dictGet.
 */
describe('ensureIdentityDictionaries (live ClickHouse + Postgres)', () => {
  const CH_DB = 'lyraflow_test'
  const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
  const ch = createChClient({
    url: 'http://localhost:8123',
    username: 'lyraflow',
    password: 'lyraflow',
    database: CH_DB,
  })

  // This test process reaches Postgres at the host-mapped 'localhost:5433'
  // (see the pg pool above), but the dictionary source is resolved by the
  // ClickHouse *server*, which runs inside docker-compose.test.yml's own
  // network and reaches Postgres at the service hostname/port instead
  // ('postgres':5432 — see docker-compose.test.yml and, for production,
  // docker-compose.yml's identical LYRAFLOW_POSTGRES_URL wiring). Reusing
  // parsePgUrl(the-localhost-url) here would build a source ClickHouse itself
  // cannot reach.
  const pgSource: PgDictionarySource = {
    host: 'postgres',
    port: 5432,
    user: 'lyraflow',
    password: 'lyraflow',
    database: CH_DB,
  }

  let projectId: number

  beforeAll(async () => {
    await migrate({
      pg,
      ch,
      migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
      appSchemaVersion: 999,
    })
    await pg.query('DELETE FROM projects WHERE slug = $1', ['dict-boot-test'])
    const r = await pg.query<{ id: string }>(
      `INSERT INTO projects (name, slug, write_key, server_key_hash)
       VALUES ('DictBoot', 'dict-boot-test', 'wk_dict_boot', 'h') RETURNING id`,
    )
    projectId = Number(r.rows[0]?.id)
  })

  afterAll(async () => {
    await pg.query('DELETE FROM identity_bindings WHERE project_id = $1', [projectId])
    await pg.query('DELETE FROM projects WHERE slug = $1', ['dict-boot-test'])
    await pg.end()
    await ch.close()
  })

  it('creates both dictionaries LOADED with no last_exception', async () => {
    await ensureIdentityDictionaries(ch, pgSource)
    // A freshly (re)created dictionary sits NOT_LOADED until first touched —
    // force the load so status/last_exception reflect whether it actually
    // succeeded, rather than "nothing has asked yet".
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.person_aliases` })

    const rs = await ch.query({
      query: `SELECT name, status, last_exception FROM system.dictionaries
              WHERE database = '${CH_DB}' AND name IN ('identity_bindings', 'person_aliases')
              ORDER BY name`,
      format: 'JSONEachRow',
    })
    const rows = await rs.json<{ name: string; status: string; last_exception: string }>()
    expect(rows.map((r) => r.name)).toEqual(['identity_bindings', 'person_aliases'])
    for (const row of rows) {
      expect(row.status).toBe('LOADED')
      expect(row.last_exception).toBe('')
    }
  })

  // Range-aware resolution, end to end through the real dictionary — not
  // just the view it reads from (schema-identity.test.ts and
  // bindings.test.ts already cover the view/tiling in isolation). This is
  // the test that would catch the dictionary being pointed at the raw
  // `identity_bindings` table instead of `identity_bindings_dict_src`: the
  // raw table has no `valid_from`/`valid_to` columns at all, so
  // `ensureIdentityDictionaries` itself would already have thrown
  // (COLUMN NOT FOUND / DICTIONARIES_WAS_NOT_LOADED) before this point ever
  // ran — but if some future change instead pointed it at a hypothetical
  // range-shaped table carrying Postgres's true ±infinity bounds, this test
  // would fail at the LOADED assertion above instead, per the CANNOT_PARSE_DATETIME
  // failure documented in dictionaries.ts. Either way, nothing here would let
  // a broken dictionary source pass silently.
  it('a range-aware dictGet resolves a bound device to its person, retroactively across a later re-bind, and falls back to the default for an unknown device', async () => {
    await ensureIdentityDictionaries(ch, pgSource)

    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
       VALUES ($1, 'dict-device', 'person-a', '2026-08-01T00:00:00Z')`,
      [projectId],
    )
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })

    const lookup = async (anonymousId: string, at: string, fallback: string) => {
      const rs = await ch.query({
        query: `SELECT dictGetOrDefault('${CH_DB}.identity_bindings', 'person_id',
                  (toUInt32(${projectId}), '${anonymousId}'), toDateTime('${at}'), '${fallback}') AS person`,
        format: 'JSONEachRow',
      })
      const [row] = await rs.json<{ person: string }>()
      return row?.person
    }

    // A single bind event is retroactive and open-ended (see
    // identity_bindings_dict_src): any instant after it resolves to that person.
    expect(await lookup('dict-device', '2026-08-02 00:00:00', '__unexpected_default__')).toBe(
      'person-a',
    )
    // A device that was never bound at all must answer with the caller's
    // default, not a made-up value and not an error.
    expect(await lookup('unknown-device', '2026-08-02 00:00:00', 'unbound-fallback')).toBe(
      'unbound-fallback',
    )

    // A second, later bind event narrows the first person's range instead of
    // overwriting it: this is what actually proves the dictionary is
    // range-aware (RANGE(MIN valid_from MAX valid_to) + COMPLEX_KEY_RANGE_HASHED)
    // rather than merely returning whichever row it happens to have.
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at)
       VALUES ($1, 'dict-device', 'person-b', '2026-08-03T00:00:00Z')`,
      [projectId],
    )
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })

    expect(await lookup('dict-device', '2026-08-02 00:00:00', '__unexpected_default__')).toBe(
      'person-a',
    )
    expect(await lookup('dict-device', '2026-08-04 00:00:00', '__unexpected_default__')).toBe(
      'person-b',
    )
  })

  /**
   * Task 6 review round 3: two binds inside the same wall-clock second, where
   * the earlier one is not the device's first-ever bind, make
   * identity_bindings_dict_src derive `valid_to = lead(bound_at) - 1s <
   * valid_from` for the earlier of the pair (see 003_identity.sql's comment
   * on the view for the full derivation) — reachable from the write path,
   * since bindings.ts stores bound_at at millisecond precision and a batch
   * can carry two identify() calls a few hundred milliseconds apart.
   *
   * Confirmed by hand against a live ClickHouse before the fix: the
   * dictionary tolerated the resulting inverted row and stayed LOADED with
   * an empty last_exception (never a FAILED/CANNOT_PARSE_DATETIME-style
   * catastrophic failure) — but the row itself silently never matched any
   * dictGet lookup, so the person who held the device for that sub-second
   * window became permanently unresolvable without anything visibly
   * breaking. The fix (an outer WHERE valid_to >= valid_from on the view)
   * drops that row instead.
   *
   * IMPORTANT: I verified by temporarily reverting the view to confirm this
   * — the status/last_exception and lookup assertions below, on their own,
   * do NOT distinguish the fix from its absence. The inverted row was
   * already unreachable by any dictGet lookup before the fix too (an
   * inverted range_min > range_max can never satisfy range_min <= x <=
   * range_max), so a plain equality-tolerant ClickHouse and the same lookup
   * results were both already true pre-fix; reverting only the WHERE filter
   * left every assertion below green. What actually distinguishes the two
   * is whether the phantom row exists in identity_bindings_dict_src at all
   * — the view assertion further down is the one this regression test
   * depends on; the dictionary-health and lookup checks stay as a second,
   * independent safety net against a *different* bad fix (e.g. clamping
   * valid_to up to valid_from instead of filtering, which the migration's
   * comment explains would reintroduce an ambiguous same-instant tie).
   */
  it('stays LOADED with an empty last_exception when two binds land in the same second, and resolves to the later person', async () => {
    await ensureIdentityDictionaries(ch, pgSource)

    // An earlier, unrelated bind first, so the first of the same-second pair
    // is NOT the device's first-ever tile — only then does the -1s
    // subtraction invert it (see 003_identity.sql). Two binds alone, with
    // the first landing at the device's very first tile, would not
    // reproduce this: that tile's valid_from is the epoch clamp, not its own
    // bound_at, and the epoch is nowhere near the inverted range.
    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at) VALUES
         ($1, 'same-second-device', 'earlier-owner', '2026-08-06T08:00:00Z'),
         ($1, 'same-second-device', 'first-of-pair', '2026-08-06T09:00:00.000Z'),
         ($1, 'same-second-device', 'second-of-pair', '2026-08-06T09:00:00.500Z')`,
      [projectId],
    )
    // This is the assertion that actually pins the fix (see the comment
    // above): the earlier of the same-second pair is dropped from the view
    // entirely, because its own derived valid_to landed before its own
    // valid_from. Reverting the WHERE filter puts 'first-of-pair' back here
    // with valid_to < valid_from — this is the one check in this test that
    // catches that regression; the dictionary-health and lookup checks
    // below do not.
    const viewRows = await pg.query<{ person_id: string; valid_from: Date; valid_to: Date }>(
      `SELECT person_id, valid_from, valid_to FROM identity_bindings_dict_src
       WHERE project_id = $1 AND anonymous_id = 'same-second-device' ORDER BY valid_from`,
      [projectId],
    )
    expect(viewRows.rows.map((r) => r.person_id)).toEqual(['earlier-owner', 'second-of-pair'])
    for (const r of viewRows.rows) {
      expect(r.valid_to.getTime()).toBeGreaterThanOrEqual(r.valid_from.getTime())
    }

    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })

    const rs = await ch.query({
      query: `SELECT status, last_exception FROM system.dictionaries
              WHERE database = '${CH_DB}' AND name = 'identity_bindings'`,
      format: 'JSONEachRow',
    })
    const [row] = await rs.json<{ status: string; last_exception: string }>()
    expect(row?.status).toBe('LOADED')
    expect(row?.last_exception).toBe('')

    const lookup = async (at: string) => {
      const lookupRs = await ch.query({
        query: `SELECT dictGetOrDefault('${CH_DB}.identity_bindings', 'person_id',
                  (toUInt32(${projectId}), 'same-second-device'), toDateTime('${at}'),
                  '__unexpected_default__') AS person`,
        format: 'JSONEachRow',
      })
      const [lookupRow] = await lookupRs.json<{ person: string }>()
      return lookupRow?.person
    }

    // Any instant landing on the contested second resolves to the later of
    // the two people who bound within it — never the earlier one (which
    // would mean the -1s fix regressed to the pre-fix overlap bleed) and
    // never the default (which would mean the WHERE filter degraded to
    // dropping BOTH tiles, or something adjacent to them, rather than just
    // the one genuinely inverted row).
    expect(await lookup('2026-08-06 09:00:00')).toBe('second-of-pair')
    // Sanity on both neighbours: the tile before the pair, and the tile
    // starting cleanly after it, are both untouched by the filter.
    expect(await lookup('2026-08-06 08:30:00')).toBe('earlier-owner')
    expect(await lookup('2026-08-06 09:00:01')).toBe('second-of-pair')
  })

  /**
   * Task 6 review round 4: the test above happens to hide something, because
   * of the specific pair it uses. `.000`/`.500` never straddles a whole
   * ClickHouse second boundary either way — `08:59:59` and `09:00:00` are
   * adjacent integers, so the earlier tile's truncated valid_to and the
   * later tile's truncated valid_from meet with no gap between them at all.
   * A pair that straddles a *second boundary* instead — bound_at values on
   * either side of a whole second, like `:00.900` and `:01.200` — leaves a
   * real dead zone: nothing before the WHERE filter ever covered it either
   * (the row it would have come from is exactly the one the filter drops),
   * and neither surviving neighbour's tile reaches into it.
   *
   * Measured directly against a live ClickHouse rather than estimated: for
   * binds at `09:00:00.900` and `09:00:01.200` (0.3s apart, straddling the
   * `09:00:00`/`09:00:01` boundary), lookups at `08:59:59` and earlier
   * resolve to the earlier owner, lookups at `09:00:01` and later resolve to
   * the later owner, and every instant in between — the entire second
   * `09:00:00`–`09:00:00.999` — falls through to the caller-supplied
   * default. A full second, not the sub-instant gap the row's own
   * millisecond-precision bound_at values would suggest: ClickHouse's
   * DateTime columns have no sub-second component at all, so the boundary
   * that matters is the whole second, not the millisecond. This is the same
   * "brief gap, safe default, never a wrong person" behaviour
   * 003_identity.sql's comment already documents in the abstract — this test
   * pins the concrete, worst-case extent of it.
   */
  it('leaves a full one-second gap (not a wrong person) when a sub-second rebind straddles a whole-second boundary', async () => {
    await ensureIdentityDictionaries(ch, pgSource)

    await pg.query(
      `INSERT INTO identity_bindings (project_id, anonymous_id, person_id, bound_at) VALUES
         ($1, 'straddle-device', 'earlier-owner', '2026-08-06T08:00:00Z'),
         ($1, 'straddle-device', 'first-of-pair', '2026-08-06T09:00:00.900Z'),
         ($1, 'straddle-device', 'second-of-pair', '2026-08-06T09:00:01.200Z')`,
      [projectId],
    )
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.identity_bindings` })

    const lookup = async (at: string) => {
      const rs = await ch.query({
        query: `SELECT dictGetOrDefault('${CH_DB}.identity_bindings', 'person_id',
                  (toUInt32(${projectId}), 'straddle-device'), toDateTime('${at}'),
                  '__anonymous_default__') AS person`,
        format: 'JSONEachRow',
      })
      const [row] = await rs.json<{ person: string }>()
      return row?.person
    }

    // Last second still cleanly owned by the earlier owner.
    expect(await lookup('2026-08-06 08:59:59')).toBe('earlier-owner')
    // The entire dead second: neither neighbour, the safe default instead.
    expect(await lookup('2026-08-06 09:00:00')).toBe('__anonymous_default__')
    // First second cleanly owned by the later owner.
    expect(await lookup('2026-08-06 09:00:01')).toBe('second-of-pair')
  })

  /**
   * The suppression dictionary the segment compiler injects its filter against.
   *
   * Both assertions are required, and the second is the one that matters.
   * Plan 2 established that a FAILED dictionary answers every lookup with the
   * caller's default rather than erroring — so a test that only checked
   * `status = 'LOADED'` would pass just as happily against a dictionary that
   * loads cleanly and contains nothing, which is precisely the shape of bug
   * that would publish a deleted person's events.
   */
  it('creates a loaded suppression dictionary that dictHas can read', async () => {
    await pg.query(
      `INSERT INTO suppressed_persons (project_id, person_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [projectId, 'person-gone'],
    )
    await ensureIdentityDictionaries(ch, pgSource)
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${CH_DB}.suppressed_persons` })

    const rs = await ch.query({
      query: `SELECT status, last_exception FROM system.dictionaries
              WHERE database = '${CH_DB}' AND name = 'suppressed_persons'`,
      format: 'JSONEachRow',
    })
    const [status] = await rs.json<{ status: string; last_exception: string }>()
    expect(status?.status).toBe('LOADED')
    expect(status?.last_exception).toBe('')

    const hits = await ch.query({
      query: `SELECT
                dictHas('${CH_DB}.suppressed_persons', (toUInt32(${projectId}), 'person-gone')) AS gone,
                dictHas('${CH_DB}.suppressed_persons', (toUInt32(${projectId}), 'person-here')) AS here`,
      format: 'JSONEachRow',
    })
    const [hit] = await hits.json<{ gone: number; here: number }>()
    expect(hit).toEqual({ gone: 1, here: 0 })
  })
})
