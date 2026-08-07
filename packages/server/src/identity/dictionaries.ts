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

const REDACTED = '[redacted]'

/**
 * Blanks out every trace of the password from a piece of diagnostic text:
 * first the literal value wherever it occurs verbatim, then — because the
 * first pass is a "should always catch it" guarantee, not a proof — anything
 * shaped like the DDL's own `password '...'` clause, regardless of what
 * actually ends up between the quotes. The second pass also removes the word
 * "password" itself, not just the value, so a redacted message never
 * contains the telltale `password '` sequence that would tell a reader a
 * secret used to be there. Applied to the full, untruncated text before any
 * truncation happens elsewhere — truncating first and hoping the password
 * lands past the cut point is exactly the "probably fine" reasoning this
 * exists to not rely on.
 */
function redactPassword(text: string, password: string): string {
  const literalRedacted = password.length > 0 ? text.split(password).join(REDACTED) : text
  return literalRedacted.replace(/password\s*'[^']*'/gi, REDACTED)
}

/**
 * Turns any failure from the two `ch.command()` calls below into an `Error`
 * that is safe to hand to a logger. The DDL those calls send necessarily
 * contains the Postgres password in plain text (see the module docstring for
 * why), and `@clickhouse/client` can attach a chunk of the failing statement
 * itself to `.message` — confirmed by hand against a live ClickHouse: a
 * malformed `CREATE DICTIONARY` produces a `SYNTAX_ERROR` whose message
 * echoes back raw, unparsed query text verbatim, including whatever
 * happened to follow the syntax error, which can be the `SOURCE(POSTGRESQL(
 * ... password '...' ...))` clause itself. A caller that logs that error
 * object directly — exactly what a fatal-and-exit boot path does — would
 * ship the password straight into the log.
 *
 * Nothing about the original error is trusted, and nothing about it is kept:
 * this reads at most `.message`, and — if the error looks like the
 * ClickHouseError shape @lyraflow/db's client throws — its `.code`/`.type`.
 * Any `query`/`request`/`sql`-shaped field the client might attach (now or
 * in a future version) is never read, because nothing here reads the error
 * object generically; only these two named fields are ever pulled off it.
 * The result's `cause`, if set, is a fresh `Error` built from the same
 * redacted, truncated summary as the message — never the original error
 * object — so the `cause` chain cannot become a second copy of the leak.
 */
function sanitizeDictionaryError(dictionaryName: string, password: string, err: unknown): Error {
  const rawMessage = err instanceof Error ? err.message : String(err)
  const redacted = redactPassword(rawMessage, password)
  const firstLine = (redacted.split('\n')[0] ?? redacted).trim()
  const summary = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine

  const code =
    err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : undefined
  const type =
    err instanceof Error && 'type' in err ? String((err as { type: unknown }).type) : undefined
  const label = [type, code ? `code ${code}` : undefined].filter(Boolean).join(', ')

  const cause = new Error(summary)
  if (type) cause.name = type

  return new Error(
    `Failed to load the "${dictionaryName}" dictionary${label ? ` (${label})` : ''}: ${summary}`,
    { cause },
  )
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
 * Callers must never log the query this builds directly — it carries
 * `pg.password` in plain text. This function does not require that
 * discipline of its callers: any failure from `ch.command()` is caught and
 * re-thrown as an error that has already had the password stripped out (see
 * `sanitizeDictionaryError`), so logging the rejection normally — as
 * `index.ts` does — is safe.
 */
export async function ensureIdentityDictionaries(
  ch: ClickHouseClient,
  pg: PgDictionarySource,
): Promise<void> {
  const source = (table: string) =>
    `SOURCE(POSTGRESQL(host '${escapeSqlLiteral(pg.host)}' port ${pg.port} user '${escapeSqlLiteral(pg.user)}' ` +
    `password '${escapeSqlLiteral(pg.password)}' db '${escapeSqlLiteral(pg.database)}' table '${table}'))`

  try {
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
  } catch (err) {
    throw sanitizeDictionaryError('identity_bindings', pg.password, err)
  }

  try {
    await ch.command({
      query: `CREATE OR REPLACE DICTIONARY person_aliases (
      project_id UInt32, person_id String, canonical_id String
    )
    PRIMARY KEY project_id, person_id
    ${source('person_aliases_dict_src')}
    LAYOUT(COMPLEX_KEY_HASHED())
    LIFETIME(MIN 5 MAX 15)`,
    })
  } catch (err) {
    throw sanitizeDictionaryError('person_aliases', pg.password, err)
  }
}
