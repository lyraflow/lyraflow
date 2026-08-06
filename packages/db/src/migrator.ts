import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ClickHouseClient, Pool } from './clients.js'

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

const FILENAME = /^(\d+)_([a-z0-9-]+)\.sql$/

function loadStore(rootDir: string, store: Store): MigrationFile[] {
  const dir = join(rootDir, store)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.flatMap((file) => {
    const m = FILENAME.exec(file)
    if (!m) return []
    return [
      {
        version: Number(m[1]),
        name: m[2] as string,
        store,
        sql: readFileSync(join(dir, file), 'utf8'),
      },
    ]
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

/**
 * Splits a migration file into statements. ClickHouse's HTTP interface accepts
 * exactly one statement per request, so multi-statement files must be split.
 */
function statements(sql: string): string[] {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith('--'))
}

async function ensureLedger(pg: Pool): Promise<void> {
  await pg.query(`
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
 * that can disagree.
 */
export async function migrate(opts: MigrateOptions): Promise<{ applied: number[] }> {
  const { pg, ch, migrations, appSchemaVersion } = opts
  const client = await pg.connect()
  const applied: number[] = []

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY])
    await ensureLedger(pg)

    const done = await client.query<{ version: number }>('SELECT version FROM schema_migrations')
    const doneVersions = new Set(done.rows.map((r) => r.version))

    const maxApplied = done.rows.reduce((max, r) => Math.max(max, r.version), 0)
    if (maxApplied > appSchemaVersion) throw new SchemaTooNewError(maxApplied, appSchemaVersion)

    for (const m of migrations) {
      if (doneVersions.has(m.version)) continue

      if (m.store === 'postgres') {
        await client.query('BEGIN')
        try {
          for (const stmt of statements(m.sql)) await client.query(stmt)
          await client.query(
            'INSERT INTO schema_migrations (version, name, store) VALUES ($1, $2, $3)',
            [m.version, m.name, m.store],
          )
          await client.query('COMMIT')
        } catch (err) {
          await client.query('ROLLBACK')
          throw err
        }
      } else {
        // ClickHouse has no cross-statement transaction. Every migration must
        // therefore be individually idempotent (IF NOT EXISTS), so a partial
        // failure is safe to re-run.
        for (const stmt of statements(m.sql)) await ch.command({ query: stmt })
        await client.query(
          'INSERT INTO schema_migrations (version, name, store) VALUES ($1, $2, $3)',
          [m.version, m.name, m.store],
        )
      }

      applied.push(m.version)
    }

    return { applied }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
    client.release()
  }
}
