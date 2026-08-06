import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Pool } from 'pg'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChClient, createPgPool } from './clients.js'
import { type MigrationFile, SchemaTooNewError, loadMigrations, migrate } from './migrator.js'

const CONNECTION_STRING = 'postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test'

const pg = createPgPool(CONNECTION_STRING)
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

function emptyMigrationsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'lyraflow-mig-'))
  mkdirSync(join(root, 'postgres'), { recursive: true })
  mkdirSync(join(root, 'clickhouse'), { recursive: true })
  return root
}

function fixtureDir(): string {
  const root = emptyMigrationsRoot()
  writeFileSync(
    join(root, 'postgres', '001_widgets.sql'),
    'CREATE TABLE widgets (id int primary key);',
  )
  writeFileSync(
    join(root, 'clickhouse', '002_gadgets.sql'),
    // IF NOT EXISTS is required: ClickHouse has no cross-statement transaction,
    // so every CREATE in a ClickHouse migration must be safe to re-run after a
    // partial failure (see the `rejects a non-idempotent ClickHouse CREATE`
    // test below, and IMPORTANT 5 in the Task 4 fix report).
    'CREATE TABLE IF NOT EXISTS gadgets (id UInt32) ENGINE = MergeTree ORDER BY id;',
  )
  return root
}

/** A minimal fake `pg.PoolClient` for tests that need to control exactly what
 * a query call returns or throws, without depending on real Postgres error
 * conditions (a dropped connection, an aborted transaction) that are slow and
 * flaky to reproduce for real. */
function createFakeClient(onQuery: (text: string) => { rows: unknown[] } | undefined) {
  const query = vi.fn(async (text: string, _values?: unknown[]) => {
    const result = onQuery(text)
    return result ?? { rows: [] }
  })
  const release = vi.fn()
  return { query, release }
}

afterAll(async () => {
  await pg.end()
  await ch.close()
})

describe('loadMigrations', () => {
  it('loads files from both stores into one ordered sequence', () => {
    const found = loadMigrations(fixtureDir())
    expect(found.map((m) => [m.version, m.store])).toEqual([
      [1, 'postgres'],
      [2, 'clickhouse'],
    ])
  })

  it('rejects duplicate version numbers across stores', () => {
    const root = fixtureDir()
    writeFileSync(join(root, 'clickhouse', '001_clash.sql'), 'SELECT 1;')
    expect(() => loadMigrations(root)).toThrow(/duplicate migration version 1/i)
  })

  // --- IMPORTANT 6: non-matching filenames must not be silently skipped ---

  it('allows underscores in the migration name', () => {
    const root = emptyMigrationsRoot()
    writeFileSync(join(root, 'postgres', '003_api_keys.sql'), 'SELECT 1;')
    const found = loadMigrations(root)
    expect(found).toEqual([{ version: 3, name: 'api_keys', store: 'postgres', sql: 'SELECT 1;' }])
  })

  it('ignores non-.sql files in a migrations directory (e.g. .gitkeep)', () => {
    const root = emptyMigrationsRoot()
    writeFileSync(join(root, 'postgres', '.gitkeep'), '')
    writeFileSync(join(root, 'postgres', '001_only.sql'), 'SELECT 1;')
    const found = loadMigrations(root)
    expect(found.map((m) => m.version)).toEqual([1])
  })

  it('throws — rather than silently skipping — a .sql file that does not match <version>_<name>.sql', () => {
    const root = emptyMigrationsRoot()
    writeFileSync(join(root, 'postgres', 'not_a_migration.sql'), 'SELECT 1;')
    expect(() => loadMigrations(root)).toThrow(/does not match the required.*pattern/i)
  })

  // --- IMPORTANT 5: ClickHouse migrations must be individually idempotent and additive-only ---

  it('rejects a ClickHouse CREATE TABLE that lacks IF NOT EXISTS', () => {
    const root = emptyMigrationsRoot()
    writeFileSync(
      join(root, 'clickhouse', '001_bad.sql'),
      'CREATE TABLE bad_gadgets (id UInt32) ENGINE = MergeTree ORDER BY id;',
    )
    expect(() => loadMigrations(root)).toThrow(/IF NOT EXISTS/i)
  })

  it('returns no migrations for a store whose directory does not exist at all', () => {
    // Legitimate: a build may ship Postgres migrations and no ClickHouse ones.
    const root = mkdtempSync(join(tmpdir(), 'lyraflow-mig-'))
    mkdirSync(join(root, 'postgres'), { recursive: true })
    writeFileSync(join(root, 'postgres', '001_only.sql'), 'SELECT 1;')
    expect(loadMigrations(root).map((m) => m.version)).toEqual([1])
  })

  it('throws — rather than reporting an empty migration set — when a store directory cannot be read', () => {
    // A plain file where a directory is expected makes readdirSync fail with
    // ENOTDIR, standing in for the real cases (bad permissions, a migrations
    // directory left out of the image). The old bare `catch { return [] }`
    // swallowed all of them, so migrate() reported success against a schema
    // it had never created — silent at boot, visible only later as missing
    // tables. Deleting the `if (isMissingDirectory(err))` guard makes this
    // pass again, which is the mutation it catches.
    const root = mkdtempSync(join(tmpdir(), 'lyraflow-mig-'))
    mkdirSync(join(root, 'clickhouse'), { recursive: true })
    writeFileSync(join(root, 'postgres'), 'this is a file, not a directory')
    expect(() => loadMigrations(root)).toThrow(/ENOTDIR/)
  })

  it('rejects a ClickHouse ALTER ... UPDATE/DELETE mutation outright', () => {
    const root = emptyMigrationsRoot()
    writeFileSync(
      join(root, 'clickhouse', '001_mutate.sql'),
      'ALTER TABLE gadgets UPDATE id = 0 WHERE 1;',
    )
    expect(() => loadMigrations(root)).toThrow(/additive only/i)
  })
})

describe('migrate', () => {
  // Scoped to this describe (and its nested ones below) rather than a
  // file-level hook: every test here exercises the real Postgres/ClickHouse
  // clients and needs a clean slate. The "connection lifecycle regression"
  // tests further down use a fake `pg` client and never touch the real
  // database, so they are a *sibling* describe below, deliberately outside
  // this hook's scope — otherwise the drop here would run before them too,
  // and since they never recreate `schema_migrations` for real, the table
  // would be left dropped for whichever test file vitest runs next in the
  // shared, `fileParallelism: false` suite (see the Task 6 review fix).
  beforeEach(async () => {
    await pg.query('DROP TABLE IF EXISTS widgets, schema_migrations')
    await ch.command({ query: 'DROP TABLE IF EXISTS gadgets' })
  })

  it('applies pending migrations to both stores', async () => {
    const migrations = loadMigrations(fixtureDir())
    const { applied } = await migrate({ pg, ch, migrations, appSchemaVersion: 2 })
    expect(applied).toEqual([1, 2])

    const w = await pg.query("SELECT to_regclass('public.widgets') AS t")
    expect(w.rows[0].t).toBe('widgets')
  })

  it('is idempotent — a second run applies nothing', async () => {
    const migrations = loadMigrations(fixtureDir())
    await migrate({ pg, ch, migrations, appSchemaVersion: 2 })
    const second = await migrate({ pg, ch, migrations, appSchemaVersion: 2 })
    expect(second.applied).toEqual([])
  })

  it('is safe under concurrent starts — the advisory lock serialises them', async () => {
    const migrations = loadMigrations(fixtureDir())
    const results = await Promise.all([
      migrate({ pg, ch, migrations, appSchemaVersion: 2 }),
      migrate({ pg, ch, migrations, appSchemaVersion: 2 }),
    ])
    expect(results.flatMap((r) => r.applied).sort()).toEqual([1, 2])
  })

  it('refuses to start when the database is newer than the binary', async () => {
    const migrations = loadMigrations(fixtureDir())
    await migrate({ pg, ch, migrations, appSchemaVersion: 2 })
    await expect(migrate({ pg, ch, migrations: [], appSchemaVersion: 1 })).rejects.toBeInstanceOf(
      SchemaTooNewError,
    )
  })

  // --- CRITICAL 1: the statement splitter must never silently drop SQL ---

  describe('statement splitting regression (CRITICAL 1)', () => {
    it('does not silently drop a ClickHouse migration that starts with a header comment', async () => {
      const root = emptyMigrationsRoot()
      writeFileSync(
        join(root, 'clickhouse', '002_events_raw.sql'),
        '-- 002_events_raw: raw ingest table\nCREATE TABLE IF NOT EXISTS events_raw (id UInt32) ENGINE = MergeTree ORDER BY id;',
      )
      await ch.command({ query: 'DROP TABLE IF EXISTS events_raw' })

      const migrations = loadMigrations(root)
      const { applied } = await migrate({ pg, ch, migrations, appSchemaVersion: 2 })
      // Before the fix: applied === [2] too, but the table was never created —
      // the version was burned with nothing to show for it. The real
      // assertion is the table's existence below, not just `applied`.
      expect(applied).toEqual([2])

      const result = await ch.query({
        query: "SELECT count() AS cnt FROM system.tables WHERE name = 'events_raw'",
        format: 'JSONEachRow',
      })
      const rows = await result.json<{ cnt: string }>()
      expect(Number(rows[0]?.cnt)).toBe(1)

      await ch.command({ query: 'DROP TABLE IF EXISTS events_raw' })
    })

    it('keeps every statement in a Postgres migration that starts with a header comment', async () => {
      const root = emptyMigrationsRoot()
      writeFileSync(
        join(root, 'postgres', '001_projects.sql'),
        '-- 001_projects: core tenant tables\nCREATE TABLE projects_x (id int primary key);\nCREATE INDEX idx_projects_x_id ON projects_x (id);',
      )
      await pg.query('DROP TABLE IF EXISTS projects_x')

      const migrations = loadMigrations(root)
      const { applied } = await migrate({ pg, ch, migrations, appSchemaVersion: 1 })
      expect(applied).toEqual([1])

      const table = await pg.query("SELECT to_regclass('public.projects_x') AS t")
      expect(table.rows[0].t).toBe('projects_x')
      const index = await pg.query(
        "SELECT indexname FROM pg_indexes WHERE indexname = 'idx_projects_x_id'",
      )
      expect(index.rows).toHaveLength(1)

      await pg.query('DROP TABLE IF EXISTS projects_x')
    })

    it('does not shatter a statement on a semicolon inside a string literal', async () => {
      const root = emptyMigrationsRoot()
      writeFileSync(
        join(root, 'postgres', '001_punct.sql'),
        "CREATE TABLE punct_test (id int primary key, sep text DEFAULT ';');",
      )
      await pg.query('DROP TABLE IF EXISTS punct_test')

      const migrations = loadMigrations(root)
      const { applied } = await migrate({ pg, ch, migrations, appSchemaVersion: 1 })
      expect(applied).toEqual([1])

      const table = await pg.query("SELECT to_regclass('public.punct_test') AS t")
      expect(table.rows[0].t).toBe('punct_test')

      await pg.query('DROP TABLE IF EXISTS punct_test')
    })

    it('does not shatter a dollar-quoted function body containing semicolons', async () => {
      const root = emptyMigrationsRoot()
      writeFileSync(
        join(root, 'postgres', '001_touch_fn.sql'),
        [
          'CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$',
          'BEGIN',
          '  NEW.updated_at = now();',
          '  RETURN NEW;',
          'END;',
          '$$ LANGUAGE plpgsql;',
        ].join('\n'),
      )
      await pg.query('DROP FUNCTION IF EXISTS touch_updated_at()')

      const migrations = loadMigrations(root)
      const { applied } = await migrate({ pg, ch, migrations, appSchemaVersion: 1 })
      expect(applied).toEqual([1])

      const fn = await pg.query("SELECT proname FROM pg_proc WHERE proname = 'touch_updated_at'")
      expect(fn.rows).toHaveLength(1)

      await pg.query('DROP FUNCTION IF EXISTS touch_updated_at()')
    })

    it('throws instead of silently applying a migration file with no SQL after stripping comments', async () => {
      const root = emptyMigrationsRoot()
      writeFileSync(join(root, 'postgres', '001_empty.sql'), '-- just a comment, nothing else\n')

      const migrations = loadMigrations(root)
      await expect(migrate({ pg, ch, migrations, appSchemaVersion: 1 })).rejects.toThrow(
        /contains no SQL statements/i,
      )

      const rows = await pg.query('SELECT version FROM schema_migrations')
      expect(rows.rows.map((r: { version: number }) => r.version)).not.toContain(1)
    })
  })

  // --- IMPORTANT 1: the ledger must be created on the locked connection, not the pool ---

  describe('connection pool sizing regression (IMPORTANT 1)', () => {
    it('does not deadlock when concurrent callers exactly fill the pool', async () => {
      const migrations = loadMigrations(fixtureDir())
      const smallPool = new Pool({ connectionString: CONNECTION_STRING, max: 3 })
      try {
        const results = await Promise.all([
          migrate({ pg: smallPool, ch, migrations, appSchemaVersion: 2 }),
          migrate({ pg: smallPool, ch, migrations, appSchemaVersion: 2 }),
          migrate({ pg: smallPool, ch, migrations, appSchemaVersion: 2 }),
        ])
        expect(results.flatMap((r) => r.applied).sort()).toEqual([1, 2])
      } finally {
        await smallPool.end()
      }
    })
  })
})

// --- IMPORTANT 2 & 3: connection lifecycle around the advisory lock and a failing rollback ---

// Deliberately a sibling of `describe('migrate', ...)` above, not nested
// inside it: every test here uses a fake `pg` client and never touches the
// real database, so it must not inherit that describe's real-DB-cleanup
// `beforeEach` — a prior version of this file had it nested, which meant the
// real `schema_migrations` table got dropped before these fake-client tests
// too and was never recreated after them, leaving it missing for whichever
// database-backed test file vitest ran next in the shared,
// `fileParallelism: false` suite (see the Task 6 review fix report).
describe('connection lifecycle regression (IMPORTANT 2 & 3)', () => {
  it('releases the connection exactly once even when the advisory-unlock query fails', async () => {
    const { query, release } = createFakeClient((text) => {
      if (text.includes('SELECT version FROM schema_migrations')) return { rows: [] }
      if (text.includes('pg_advisory_unlock')) throw new Error('connection lost')
    })
    const fakePg = { connect: async () => ({ query, release }) } as unknown as Pool

    await expect(migrate({ pg: fakePg, ch, migrations: [], appSchemaVersion: 0 })).resolves.toEqual(
      { applied: [] },
    )
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('surfaces the original error — not a failing ROLLBACK — and destroys the connection when both fail', async () => {
    const originalError = new Error('syntax error at or near THIS')
    const rollbackError = new Error('current transaction is aborted')
    const migrations: MigrationFile[] = [
      { version: 1, name: 'broken', store: 'postgres', sql: 'THIS IS NOT VALID SQL;' },
    ]
    const { query, release } = createFakeClient((text) => {
      if (text.includes('SELECT version FROM schema_migrations')) return { rows: [] }
      if (text === 'THIS IS NOT VALID SQL;') throw originalError
      if (text === 'ROLLBACK') throw rollbackError
    })
    const fakePg = { connect: async () => ({ query, release }) } as unknown as Pool

    await expect(migrate({ pg: fakePg, ch, migrations, appSchemaVersion: 1 })).rejects.toBe(
      originalError,
    )
    expect(release).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledWith(true)
  })
})
