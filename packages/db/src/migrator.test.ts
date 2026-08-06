import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createChClient, createPgPool } from './clients.js'
import { SchemaTooNewError, loadMigrations, migrate } from './migrator.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

function fixtureDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'lyraflow-mig-'))
  mkdirSync(join(root, 'postgres'), { recursive: true })
  mkdirSync(join(root, 'clickhouse'), { recursive: true })
  writeFileSync(
    join(root, 'postgres', '001_widgets.sql'),
    'CREATE TABLE widgets (id int primary key);',
  )
  writeFileSync(
    join(root, 'clickhouse', '002_gadgets.sql'),
    'CREATE TABLE gadgets (id UInt32) ENGINE = MergeTree ORDER BY id;',
  )
  return root
}

beforeEach(async () => {
  await pg.query('DROP TABLE IF EXISTS widgets, schema_migrations')
  await ch.command({ query: 'DROP TABLE IF EXISTS gadgets' })
})

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
})

describe('migrate', () => {
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
})
