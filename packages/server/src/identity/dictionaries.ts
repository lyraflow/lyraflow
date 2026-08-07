import type { ClickHouseClient } from '@lyraflow/db'

export interface PgDictionarySource {
  host: string
  port: number
  user: string
  password: string
  database: string
}

/**
 * The error deliberately names the variable and never echoes its value — the URL
 * contains the database password, and this runs on a startup path that logs.
 */
export function parsePgUrl(url: string): PgDictionarySource {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('LYRAFLOW_POSTGRES_URL is not a valid connection URL')
  }
  if (!parsed.hostname || !parsed.pathname.slice(1)) {
    throw new Error('LYRAFLOW_POSTGRES_URL is missing a host or database name')
  }
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: parsed.pathname.slice(1),
  }
}

function escapeSqlLiteral(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Creates the two identity dictionaries ClickHouse resolves against.
 *
 * They read the *_dict_src views rather than the tables directly: Postgres stores
 * true ±infinity bounds so the exclusion constraint stays natural, but ClickHouse
 * cannot parse those into DateTime — the dictionary fails to load entirely and
 * every lookup silently falls back to the anonymous id. The views clamp to the
 * representable DateTime range.
 *
 * Not a migration: the DDL below embeds the Postgres password, and migrations
 * are committed `.sql` files in a public repository. Running this at boot from
 * credentials already in the process environment keeps the secret out of git,
 * and `CREATE OR REPLACE DICTIONARY` is idempotent and also picks up a rotated
 * password on the next restart, which a one-shot migration would not.
 *
 * Callers must never log the query this builds — it carries `pg.password`
 * in plain text.
 */
export async function ensureIdentityDictionaries(
  ch: ClickHouseClient,
  pg: PgDictionarySource,
): Promise<void> {
  const source = (table: string) =>
    `SOURCE(POSTGRESQL(host '${escapeSqlLiteral(pg.host)}' port ${pg.port} user '${escapeSqlLiteral(pg.user)}' ` +
    `password '${escapeSqlLiteral(pg.password)}' db '${escapeSqlLiteral(pg.database)}' table '${table}'))`

  await ch.command({
    query: `CREATE OR REPLACE DICTIONARY identity_bindings (
      project_id UInt32, anonymous_id String, person_id String,
      valid_from DateTime, valid_to DateTime
    )
    PRIMARY KEY project_id, anonymous_id
    ${source('identity_bindings_dict_src')}
    LAYOUT(COMPLEX_KEY_RANGE_HASHED())
    RANGE(MIN valid_from MAX valid_to)
    LIFETIME(MIN 5 MAX 15)`,
  })

  await ch.command({
    query: `CREATE OR REPLACE DICTIONARY person_aliases (
      project_id UInt32, person_id String, canonical_id String
    )
    PRIMARY KEY project_id, person_id
    ${source('person_aliases_dict_src')}
    LAYOUT(COMPLEX_KEY_HASHED())
    LIFETIME(MIN 5 MAX 15)`,
  })
}
