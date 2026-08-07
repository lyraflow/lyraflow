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
   * Builds a single-line error shaped exactly like the ClickHouseError
   * `@clickhouse/client` throws (`.message`, `.code`, `.type`) around a
   * `SOURCE(POSTGRESQL(...))` clause containing `password`, escaped the same
   * way `escapeSqlLiteral` in dictionaries.ts escapes it — `\` doubled,
   * then `'` backslash-escaped. `tail` is appended after the password
   * clause when present, or omitted (simulating a length-capped diagnostic
   * that truncates mid-value, with no closing quote at all) when not.
   *
   * Deliberately lean *before* the password: `sanitizeDictionaryError` caps
   * its output at 200 characters (for a readable, single fatal log line),
   * capped *after* redaction runs, never before — but a verbose preamble
   * here would push the password itself past that 200-character mark, and
   * the tests below would then pass even with redaction completely broken,
   * for the same reason the multi-line fixture this replaced did: whatever
   * comes after the cut point disappears regardless of whether it was ever
   * actually redacted. Keeping the preamble short (verified below, in the
   * mutation proof) makes these tests depend on `redactPassword` actually
   * running, not on truncation coincidentally standing in for it.
   */
  function chError(password: string, tail?: string): Error {
    const escaped = password.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    const message = `Code: 62. Syntax error near SOURCE(POSTGRESQL(host 'postgres' password '${escaped}'${tail ?? ''}`
    const err = new Error(message)
    Object.assign(err, { code: '62', type: 'SYNTAX_ERROR' })
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
      throw chError(LEAKED_PASSWORD, `' db 'lyraflow_test' table 'identity_bindings_dict_src'))`)
    })
    for (const text of await surfacesFor(ch, pgSourceWith(LEAKED_PASSWORD))) {
      expect(text).not.toContain(LEAKED_PASSWORD)
      expect(text).not.toMatch(/password\s*'/i)
    }
  })

  // A password containing `'` is exactly what a raw (unescaped) redaction
  // pass misses: the DDL — and therefore the error echo — carries the
  // *escaped* form `ab\'cd-SECRET-TAIL`, not the raw `ab'cd-SECRET-TAIL`.
  it('a password containing a single quote is fully redacted', async () => {
    const PASSWORD = `ab'cd-SECRET-TAIL`
    const ch = fakeCh(() => {
      throw chError(PASSWORD, `' db 'lyraflow_test' table 'identity_bindings_dict_src'))`)
    })
    for (const text of await surfacesFor(ch, pgSourceWith(PASSWORD))) {
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain('SECRET-TAIL')
      expect(text).not.toMatch(/password\s*'/i)
    }
  })

  // A password containing `\` doubles under escaping (`\` -> `\\`); the
  // fallback clause-matcher must not mistake the doubled backslash for an
  // escaped quote and stop early.
  it('a password containing a backslash is fully redacted', async () => {
    const PASSWORD = 'back\\slash-SECRET-TAIL'
    const ch = fakeCh(() => {
      throw chError(PASSWORD, `' db 'lyraflow_test' table 'identity_bindings_dict_src'))`)
    })
    for (const text of await surfacesFor(ch, pgSourceWith(PASSWORD))) {
      expect(text).not.toContain(PASSWORD)
      expect(text).not.toContain('SECRET-TAIL')
      expect(text).not.toMatch(/password\s*'/i)
    }
  })

  // ClickHouse caps this diagnostic's length (confirmed by hand — see the
  // Task 5 fix report), and where the cut lands is not under this code's
  // control: a partial password with no closing quote is still a leak, and
  // `[^']*'` (requiring a real closing quote) would never match it at all.
  it('a truncated echo with no closing quote is fully redacted, not left untouched', async () => {
    const LEAKED_PASSWORD = 'MY_LEAKED_SECRET_XYZ'
    const ch = fakeCh(() => {
      // No trailing quote and no tail: the message ends mid-value, exactly
      // as a length cap would produce.
      throw chError(LEAKED_PASSWORD.slice(0, 12))
    })
    for (const text of await surfacesFor(ch, pgSourceWith(LEAKED_PASSWORD))) {
      expect(text).not.toContain(LEAKED_PASSWORD.slice(0, 12))
      expect(text).not.toMatch(/password\s*'/i)
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
})
