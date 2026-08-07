import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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
