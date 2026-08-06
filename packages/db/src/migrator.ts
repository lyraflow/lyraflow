import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ClickHouseClient, Pool, PoolClient } from './clients.js'

/** Arbitrary but fixed. Every Lyraflow process uses this same advisory lock key. */
const ADVISORY_LOCK_KEY = 48_201_001

export type Store = 'postgres' | 'clickhouse'

export interface MigrationFile {
  version: number
  name: string
  store: Store
  sql: string
}

export interface MigrateOptions {
  pg: Pool
  ch: ClickHouseClient
  migrations: MigrationFile[]
  appSchemaVersion: number
}

export class SchemaTooNewError extends Error {
  constructor(dbVersion: number, appVersion: number) {
    super(
      `Database schema version ${dbVersion} is newer than this build understands (${appVersion}). This usually means the image was downgraded. Restore the newer image, or restore a backup taken before the upgrade.`,
    )
    this.name = 'SchemaTooNewError'
  }
}

// Allows underscores in the name so `<version>_<name>.sql` authors can write
// `003_api_keys.sql` rather than being forced into `003_api-keys.sql`.
const FILENAME = /^(\d+)_([a-z0-9_-]+)\.sql$/

/**
 * Splits a migration file into individual SQL statements, stripping `--` line
 * comments and `/* *\/` block comments first. Tracks single-quote,
 * double-quote, backtick, and Postgres `$tag$` dollar-quote state so that
 * semicolons and comment markers inside string/identifier literals never
 * split or truncate a statement.
 *
 * Used to split ClickHouse migrations (its HTTP interface accepts exactly one
 * statement per request) and to validate ClickHouse statements at load time.
 * Postgres migrations are NOT run through this splitter for execution — the
 * whole file is sent to Postgres as a single `client.query(sql)` call, which
 * uses the simple query protocol and lets Postgres's own parser (which
 * already handles comments, quoting, and dollar-quoting correctly) execute
 * every statement in the file as one implicit transaction block. This
 * function is still used against Postgres files to detect a migration that
 * is empty after stripping comments (see `assertHasStatements`).
 */
function splitStatements(sql: string): string[] {
  const result: string[] = []
  let current = ''
  let i = 0
  const n = sql.length

  while (i < n) {
    const ch = sql[i]
    const next = sql[i + 1]

    // Line comment: skip to (and including) the newline.
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i)
      i = nl === -1 ? n : nl + 1
      continue
    }

    // Block comment.
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }

    // Quoted string or identifier: copy verbatim, honouring doubled-quote
    // escapes ('' inside '...', "" inside "...", `` inside `...`).
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      const start = i
      let j = i + 1
      while (j < n) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) {
            j += 2
            continue
          }
          j++
          break
        }
        j++
      }
      current += sql.slice(start, j)
      i = j
      continue
    }

    // Postgres dollar-quoted body, e.g. $$ ... $$ or $tag$ ... $tag$ — used
    // for function bodies that themselves contain semicolons.
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))
      if (tagMatch) {
        const tag = tagMatch[0]
        const closeAt = sql.indexOf(tag, i + tag.length)
        const end = closeAt === -1 ? n : closeAt + tag.length
        current += sql.slice(i, end)
        i = end
        continue
      }
    }

    if (ch === ';') {
      const trimmed = current.trim()
      if (trimmed.length > 0) result.push(trimmed)
      current = ''
      i++
      continue
    }

    current += ch
    i++
  }

  const tail = current.trim()
  if (tail.length > 0) result.push(tail)

  return result
}

/**
 * Refuses to treat a migration file that contains no SQL (e.g. only a header
 * comment, or a comment-only edit) as valid. Without this guard, `migrate`
 * would run BEGIN / (nothing) / INSERT INTO schema_migrations / COMMIT and
 * silently record the version as applied even though nothing happened.
 */
function assertHasStatements(m: MigrationFile): void {
  if (splitStatements(m.sql).length === 0) {
    throw new Error(
      `Migration ${m.version}_${m.name}.sql (${m.store}) contains no SQL statements after stripping comments. Refusing to record it as applied — this is almost always a mistake in the migration file.`,
    )
  }
}

const CH_CREATE_RE = /^\s*CREATE\s+(TABLE|MATERIALIZED VIEW|VIEW|DICTIONARY)\b/i
const CH_IF_NOT_EXISTS_RE = /\bIF\s+NOT\s+EXISTS\b/i
const CH_MUTATION_RE = /^\s*ALTER\s+TABLE\b[\s\S]*\b(UPDATE|DELETE)\b/i

function truncateForError(stmt: string): string {
  return stmt.length > 80 ? `${stmt.slice(0, 80)}…` : stmt
}

/**
 * ClickHouse has no cross-statement transaction, so every statement in a
 * ClickHouse migration must be individually idempotent (IF NOT EXISTS) —
 * otherwise a partial failure (statement 2 of 3 fails) leaves statement 1's
 * object in place with no ledger row written, and the re-run crashes with
 * TABLE_ALREADY_EXISTS. ClickHouse migrations must also be additive-only, so
 * ALTER ... UPDATE/DELETE (ClickHouse's mutation syntax) is rejected outright.
 */
function validateClickHouseStatement(stmt: string, m: MigrationFile): void {
  if (CH_CREATE_RE.test(stmt) && !CH_IF_NOT_EXISTS_RE.test(stmt)) {
    throw new Error(
      `${m.version}_${m.name}.sql (clickhouse): CREATE statements must include IF NOT EXISTS so the migration is idempotent and safe to re-run after a partial failure: "${truncateForError(stmt)}"`,
    )
  }
  if (CH_MUTATION_RE.test(stmt)) {
    throw new Error(
      `${m.version}_${m.name}.sql (clickhouse): ALTER ... UPDATE/DELETE is not allowed — ClickHouse migrations must be additive only: "${truncateForError(stmt)}"`,
    )
  }
}

function validateClickHouseMigration(m: MigrationFile): void {
  for (const stmt of splitStatements(m.sql)) validateClickHouseStatement(stmt, m)
}

/**
 * A store directory that simply does not exist is legitimate — a deployment
 * may ship Postgres migrations and no ClickHouse ones yet. *Any other* read
 * failure is not: a permissions error, or a migrations directory left out of
 * the image, would otherwise make loadStore return `[]`, and `migrate` would
 * then report success against a schema it never created. That failure is
 * silent at boot and only surfaces later as missing tables, so narrow the
 * catch to ENOENT and let everything else escape.
 */
function isMissingDirectory(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function loadStore(rootDir: string, store: Store): MigrationFile[] {
  const dir = join(rootDir, store)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch (err) {
    if (isMissingDirectory(err)) return []
    throw err
  }
  return entries.flatMap((file) => {
    // Non-SQL files (e.g. .gitkeep) are not migrations; ignore them.
    if (!file.endsWith('.sql')) return []

    const m = FILENAME.exec(file)
    if (!m) {
      throw new Error(
        `Migration file "${file}" in ${dir} does not match the required <version>_<name>.sql pattern (e.g. "001_projects.sql"). Rename or remove it — silently skipping an unrecognised migration file would boot the app against an incomplete schema.`,
      )
    }

    const migration: MigrationFile = {
      version: Number(m[1]),
      name: m[2] as string,
      store,
      sql: readFileSync(join(dir, file), 'utf8'),
    }

    if (store === 'clickhouse') validateClickHouseMigration(migration)

    return [migration]
  })
}

export function loadMigrations(rootDir: string): MigrationFile[] {
  const all = [...loadStore(rootDir, 'postgres'), ...loadStore(rootDir, 'clickhouse')]
  const seen = new Map<number, string>()
  for (const m of all) {
    const prior = seen.get(m.version)
    if (prior) {
      throw new Error(
        `Duplicate migration version ${m.version}: "${prior}" and "${m.name}". Versions are a single sequence shared across both stores.`,
      )
    }
    seen.set(m.version, m.name)
  }
  return all.sort((a, b) => a.version - b.version)
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     integer PRIMARY KEY,
      name        text        NOT NULL,
      store       text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `)
}

/**
 * Postgres is the single source of truth for schema version, including for
 * ClickHouse migrations. That keeps one ledger and one lock rather than two
 * that can disagree. Every step here — the advisory lock, the ledger table,
 * and the version check — runs on the single dedicated connection `client`
 * obtained from `pg.connect()`, never on the pool directly: `pg_advisory_lock`
 * is connection-scoped, so a query routed to a different pool connection
 * would not see the lock, and (with a pool sized exactly to the number of
 * concurrent callers) could deadlock waiting for a connection that will never
 * free up.
 */
export async function migrate(opts: MigrateOptions): Promise<{ applied: number[] }> {
  const { pg, ch, migrations, appSchemaVersion } = opts
  const client = await pg.connect()
  const applied: number[] = []
  // Set when the connection is left in a state that must not be reused
  // (e.g. a failed ROLLBACK leaves the session in an aborted-transaction
  // state) — passed to `client.release()` so pg destroys the connection
  // instead of returning it to the pool.
  let poisoned = false

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])
    await ensureLedger(client)

    const done = await client.query<{ version: number }>('SELECT version FROM schema_migrations')
    const doneVersions = new Set(done.rows.map((r) => r.version))

    const maxApplied = done.rows.reduce((max, r) => Math.max(max, r.version), 0)
    if (maxApplied > appSchemaVersion) throw new SchemaTooNewError(maxApplied, appSchemaVersion)

    for (const m of migrations) {
      if (doneVersions.has(m.version)) continue
      assertHasStatements(m)

      if (m.store === 'postgres') {
        await client.query('BEGIN')
        try {
          // Sent unsplit: node-pg's simple query protocol (used when a query
          // has no bind values) runs a whole multi-statement file as one
          // implicit block, and Postgres's own parser — not a hand-rolled
          // splitter — is what correctly handles comments, quoted strings,
          // and dollar-quoted function bodies containing semicolons.
          await client.query(m.sql)
          await client.query(
            'INSERT INTO schema_migrations (version, name, store) VALUES ($1, $2, $3)',
            [m.version, m.name, m.store],
          )
          await client.query('COMMIT')
        } catch (err) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // The connection is almost certainly already broken (e.g. it
            // dropped mid-transaction). Keep `err` — the statement failure —
            // as the thrown value, and mark the connection for destruction
            // rather than returning a suspect connection to the pool.
            poisoned = true
          }
          throw err
        }
      } else {
        // ClickHouse's HTTP interface accepts exactly one statement per
        // request, so (unlike Postgres) the file must be split. Every
        // statement was already validated as idempotent at load time.
        for (const stmt of splitStatements(m.sql)) await ch.command({ query: stmt })
        await client.query(
          'INSERT INTO schema_migrations (version, name, store) VALUES ($1, $2, $3)',
          [m.version, m.name, m.store],
        )
      }

      applied.push(m.version)
    }

    return { applied }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
    } catch {
      // If this fails the connection/session is gone, and Postgres releases
      // session-level advisory locks automatically when the session ends —
      // there is nothing further to do, and the original error (if any)
      // from the try block must not be replaced by this one.
    }
    client.release(poisoned)
  }
}
