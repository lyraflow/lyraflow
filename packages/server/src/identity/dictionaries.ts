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
 *
 * `decodeURIComponent` runs *inside* the try, alongside `new URL()`: a lone
 * `%` (or any other malformed percent-encoding) in the username, password,
 * or path makes `decodeURIComponent` throw `URIError: URI malformed`, and
 * that must surface through the same named, value-free message as a
 * structurally invalid URL — not as a raw, uncaught `URIError`.
 */
export function parsePgUrl(url: string): PgDictionarySource {
  let parsed: URL
  let user: string
  let password: string
  let database: string
  try {
    parsed = new URL(url)
    user = decodeURIComponent(parsed.username)
    password = decodeURIComponent(parsed.password)
    // The path segment is percent-encoded exactly like userinfo is — e.g. a
    // database literally named "lyra flow" arrives as `/lyra%20flow` — but
    // unlike `username`/`password`, `pathname` was previously used raw.
    database = decodeURIComponent(parsed.pathname.slice(1))
  } catch {
    throw new Error('LYRAFLOW_POSTGRES_URL is not a valid connection URL')
  }
  if (!parsed.hostname || !database) {
    throw new Error('LYRAFLOW_POSTGRES_URL is missing a host or database name')
  }
  // The WHATWG URL parser reports an IPv6 host's `hostname` bracketed, e.g.
  // `[::1]` — required in a URL to separate the address's own colons from
  // the port's, but not a valid ClickHouse POSTGRESQL source `host` value.
  // Left bracketed, `ensureIdentityDictionaries` would build a well-formed
  // SOURCE(...) clause that ClickHouse's Postgres driver simply cannot
  // connect with; since dictionary loading is lazy (see dictionaries.test.ts
  // for the confirmation), `CREATE OR REPLACE DICTIONARY` would still
  // succeed, boot would still succeed, and only a later `dictGet` would
  // discover the dictionary never actually loaded.
  const host =
    parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname
  return {
    host,
    port: parsed.port ? Number(parsed.port) : 5432,
    user,
    password,
    database,
  }
}

function escapeSqlLiteral(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

const REDACTED = '[redacted]'

/**
 * Blanks out every trace of the password from a piece of diagnostic text.
 * Three independent passes, each covering what the others can miss on their
 * own — a security review of an earlier version of this function found real
 * holes in the first and third when used alone:
 *
 *  1. The literal password value, wherever it appears verbatim.
 *  2. The *escaped* form `escapeSqlLiteral` puts into the DDL — distinct
 *     from (1) whenever the password itself contains a `'` or `\`. The DDL
 *     always contains this escaped form, never the raw one, so a raw-only
 *     pass leaves it — and the secret inside it — completely untouched.
 *  3. A `password '...'` clause matcher that does not require either exact
 *     string above to still be intact. `(?:\\.|[^'\\])*` walks the value
 *     the same way the escaping scheme itself does: `\\.` consumes an
 *     escaped backslash or escaped quote as a single unit, so an internal
 *     `\'` from pass (2)'s own escaping is never mistaken for the value's
 *     real closing quote (naively matching `[^']*'` terminates right there
 *     and leaves everything after it — including the rest of the secret —
 *     unredacted). `('|$)` accepts either that genuine closing quote or the
 *     end of the string, so a length-capped diagnostic that truncates
 *     mid-value (confirmed by hand: ClickHouse caps this diagnostic's
 *     length, and where the cut lands is not something this code controls)
 *     is still fully redacted instead of leaking whatever fragment survived
 *     the cut.
 *
 * Applied to the fully-assembled message exactly once (see
 * `sanitizeDictionaryError`), not field-by-field — so nothing that ends up
 * in the final message, including the ClickHouse-supplied `code`/`type`,
 * depends on being independently guaranteed clean.
 */
function redactPassword(text: string, password: string): string {
  const escaped = escapeSqlLiteral(password)
  let out = text
  if (password.length > 0) out = out.split(password).join(REDACTED)
  if (escaped.length > 0) out = out.split(escaped).join(REDACTED)
  out = out.replace(/password\s*'(?:\\.|[^'\\])*('|$)/gi, REDACTED)
  return out
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
 * fully-redacted summary as the message — never the original error object —
 * so the `cause` chain cannot become a second copy of the leak.
 */
function sanitizeDictionaryError(dictionaryName: string, password: string, err: unknown): Error {
  const rawMessage = err instanceof Error ? err.message : String(err)

  // ClickHouseError (thrown by @clickhouse/client for a server-side
  // failure) carries `code` and `type` as plain string/number properties;
  // read only those two, never anything else the error object might carry.
  const code =
    err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : undefined
  const type =
    err instanceof Error && 'type' in err ? String((err as { type: unknown }).type) : undefined
  const label = [type, code ? `code ${code}` : undefined].filter(Boolean).join(', ')

  // Assembled in full — including the `code`/`type` label — *before*
  // redaction runs, and redacted exactly once, immediately below, rather
  // than redacting `rawMessage` alone and trusting that `label` (built from
  // fields read off the same untrusted error object) could never itself
  // carry the password.
  const assembled = `Failed to load the "${dictionaryName}" dictionary${label ? ` (${label})` : ''}: ${rawMessage}`
  const redacted = redactPassword(assembled, password)

  // Whitespace-collapsing and length-capping happen strictly *after* this
  // point, on text that is already fully redacted — never before it. Taking
  // only a message's first line (or its first N characters) ahead of
  // redaction was exactly the earlier version of this function's bug: a
  // password sitting on a later line, or past the cut point, would never
  // reach `redactPassword` at all and would be dropped by truncation, not by
  // redaction — which looks identical in a passing test but leaves a
  // differently-shaped real failure completely unredacted. So collapsing and
  // capping here exist purely to keep a fatal log line short and single-line;
  // they carry none of the safety responsibility, which belongs to
  // `redactPassword` alone, applied to the complete, untruncated text.
  const collapsed = redacted.replace(/\s+/g, ' ').trim()
  const summary = collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed

  const cause = new Error(summary)
  // `type` is read straight off the caught error (see above) and is
  // untrusted the same way `.message` is — assigning it to `cause.name`
  // unredacted would put the password back within reach of anything that
  // reads `.name` (an own, enumerable property, unlike `.message`): a log
  // serializer walking `cause`, `String(cause)`, or `cause.stack`'s first
  // line all include `.name`. Redacted through the same function as
  // everything else, not trusted to be safe just because it looks like a
  // short enum value.
  if (type) cause.name = redactPassword(type, password)

  return new Error(summary, { cause })
}

/**
 * Creates the two identity dictionaries ClickHouse resolves against.
 *
 * They read the *_dict_src views rather than the tables directly, and this is
 * the one place a reader learns why those views exist at all.
 *
 * There is no exclusion constraint and no stored range. `identity_bindings`
 * stores bind *events* — one instant per row — and the validity window a
 * device's person holds is derived fresh, every read, by
 * `identity_bindings_dict_src`'s window function (see 003_identity.sql for
 * that derivation and why events rather than ranges). Deriving it that way
 * naturally produces unbounded ends: the earliest bind owns everything
 * before it (retroactive attachment, the whole point), the latest owns
 * everything after.
 *
 * Those unbounded ends are exactly what ClickHouse cannot take. A Postgres
 * ±infinity timestamptz does not parse into DateTime — the dictionary fails
 * to load outright (Code: 41, CANNOT_PARSE_DATETIME) and every lookup
 * silently falls back to the event's own anonymous id, so identity
 * resolution degrades to "nobody was ever identified" with nothing visibly
 * broken. So the views never emit ±infinity at all: they write the two ends
 * directly as the widest instants ClickHouse's DateTime can represent
 * (1970-01-01T00:00:00Z and 2106-02-07T06:28:15Z), and drop any tile that
 * the one-second discretisation inverts.
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
  // `port` is interpolated unquoted below (it is a number, not a SQL string
  // literal, so `escapeSqlLiteral` does not apply to it). `parsePgUrl` always
  // produces a safe integer, but `PgDictionarySource` is a public interface —
  // dictionaries.test.ts's own live-service test builds one by hand — and a
  // non-integer value (a stray `NaN`, or a value carrying its own quotes)
  // would land in the DDL unescaped, which is exactly the kind of malformed
  // statement `sanitizeDictionaryError` exists to be the *last* line of
  // defence against, not the only one. Fail before any DDL is built at all.
  if (!Number.isInteger(pg.port)) {
    throw new Error(`PgDictionarySource.port must be an integer, got ${String(pg.port)}`)
  }

  // `invalidateQuery`, when given, is a scalar Postgres query ClickHouse runs
  // before each scheduled reload: an unchanged result means the reload is
  // skipped entirely. It is interpolated into the DDL the same way `table` is
  // — both are compile-time constants from this module, never caller data —
  // and neither is ever built from a request.
  const source = (table: string, invalidateQuery?: string) =>
    `SOURCE(POSTGRESQL(host '${escapeSqlLiteral(pg.host)}' port ${pg.port} user '${escapeSqlLiteral(pg.user)}' ` +
    `password '${escapeSqlLiteral(pg.password)}' db '${escapeSqlLiteral(pg.database)}' table '${table}'` +
    `${invalidateQuery ? ` invalidate_query '${escapeSqlLiteral(invalidateQuery)}'` : ''}))`

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

  // The third dictionary: the people whose data must never reach a result set.
  //
  // LIFETIME is deliberately far shorter than the identity dictionaries' 5-15s.
  // A stale identity dictionary shows slightly out-of-date stitching; a stale
  // suppression dictionary shows data belonging to someone who asked for it to
  // be deleted. The two are not comparable, so they do not share a refresh
  // policy. The frequency is cheap because `invalidate_query` means a reload
  // only actually happens once a row has been added — rows are never removed,
  // so the count and the newest timestamp together change if and only if the
  // list grew.
  // The invalidate_query still fires correctly now that a REPEAT deletion
  // UPDATES a row rather than only inserting one. `suppressed_at` is always
  // now(), so any write — insert or upsert — becomes the new max(), and the
  // scalar changes. A reload is skipped only when nothing was written at all.
  //
  // `suppressed_at DateTime64(6)`, not `DateTime`. `suppressed_at` is a
  // Postgres `timestamptz` — `now()` at the moment of deletion, so it almost
  // always carries a fractional second — and this dictionary's own
  // `notSuppressedExpr` (suppression.ts) compares it directly against an
  // event's `timestamp`, itself `DateTime64(3)`. A plain `DateTime` attribute
  // (second precision) used to floor that value on load — measured directly
  // against a live server: `dictGetOrDefault` returned the whole second with
  // the fractional part silently gone, never rounded, never rejected — which
  // opened a real, up-to-999ms gap where an event genuinely BEFORE the
  // deletion instant compared as NOT suppressed here while the exact,
  // Postgres-backed person-read/export paths (which read `suppressed_at`
  // with no such truncation) correctly hid it. Two routes disagreeing about
  // a person deleted in the same second they acted — the exact defect shape
  // Task 11 exists to make impossible, just one layer further down than that
  // task's own fixture could reach until it grew a boundary-instant case.
  //
  // The attribute is declared `(6)`, not `(3)` (to match `events.timestamp`)
  // or `(9)` ("more precision is safer"). Both of those instincts are
  // plausible, and both are wrong in a way that is silent and bidirectional:
  // getting the scale wrong does not fail to load, it loads clean and reads
  // back a garbage instant. Measured directly against a live server, with a
  // single `suppressed_persons` row holding `2026-08-08 12:00:00.123456`:
  //   - `DateTime64(3)` reads back as `2299-12-31` — a far-future boundary,
  //     which SUPPRESSES EVERY EVENT for that person, forever.
  //   - `DateTime64(9)` reads back as `1970-01-21` — a far-past boundary,
  //     which REPUBLISHES EVERY DELETED PERSON, the exact leak this feature
  //     exists to prevent.
  //   - `DateTime64(6)` reads back correctly.
  // All four scales tried ((3), (6), (9), and no explicit structure) load
  // with dictionary status `LOADED` and an empty `last_exception` — nothing
  // errors, nothing warns, at either the wrong scales or the right one. `(6)`
  // is not a tuning choice; it is what ClickHouse's own `postgresql()` source
  // infers for a `timestamptz` column with no explicit structure given
  // (confirmed directly: `SELECT ... FROM postgresql(...)` reports
  // `DateTime64(6)`), and matching that inferred scale exactly is what makes
  // this a value the dictionary loads correctly rather than merely a value
  // it accepts declaring.
  try {
    await ch.command({
      query: `CREATE OR REPLACE DICTIONARY suppressed_persons (
      project_id UInt32, person_id String, suppressed UInt8, suppressed_at DateTime64(6)
    )
    PRIMARY KEY project_id, person_id
    ${source(
      'suppressed_persons_dict_src',
      "SELECT count(*)::text || ':' || coalesce(max(suppressed_at), 'epoch')::text FROM suppressed_persons",
    )}
    LAYOUT(COMPLEX_KEY_HASHED())
    LIFETIME(MIN 1 MAX 5)`,
    })
  } catch (err) {
    throw sanitizeDictionaryError('suppressed_persons', pg.password, err)
  }
}
