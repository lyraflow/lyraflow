import { join } from 'node:path'
import { verifyPassword } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ensureAdminUser } from './bootstrap.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
})

// admin_user is a SINGLETON table -- every test in this file needs it empty
// to start, and no other suite may hold a row while this one runs. This is
// the one table the shared-database rule cannot be satisfied by prefixing,
// so it is emptied here and nowhere else creates a row outside its own
// beforeAll/afterAll pair.
beforeEach(async () => {
  await pg.query('DELETE FROM admin_user')
})

afterAll(async () => {
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

describe('ensureAdminUser', () => {
  it('creates the admin when the table is empty and env is set', async () => {
    const outcome = await ensureAdminUser(pg, {
      email: 'a@example.test',
      password: 'hunter2hunter2',
    })
    expect(outcome).toBe('created')

    const row = await pg.query<{ email: string; password_hash: string }>(
      'SELECT email, password_hash FROM admin_user',
    )
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0]?.email).toBe('a@example.test')
    expect(await verifyPassword('hunter2hunter2', row.rows[0]?.password_hash ?? '')).toBe(true)
  })

  // The upgrade path, and the reason this function returns three outcomes
  // rather than throwing: an install that predates the admin account has no
  // LYRAFLOW_ADMIN_PASSWORD in its .env, and boot must succeed anyway.
  it.each([
    ['no password', { email: 'a@example.test', password: undefined }],
    ['no email', { email: undefined, password: 'hunter2hunter2' }],
    ['neither', { email: undefined, password: undefined }],
    ['empty password', { email: 'a@example.test', password: '' }],
    ['whitespace-only password', { email: 'a@example.test', password: '   ' }],
  ])('creates nothing and reports not_configured: %s', async (_name, env) => {
    expect(await ensureAdminUser(pg, env)).toBe('not_configured')
    const row = await pg.query('SELECT 1 FROM admin_user')
    expect(row.rows).toHaveLength(0)
  })

  it('leaves an existing admin alone, even when env names a different password', async () => {
    await ensureAdminUser(pg, { email: 'a@example.test', password: 'original-password' })
    const outcome = await ensureAdminUser(pg, {
      email: 'a@example.test',
      password: 'a-different-password',
    })
    expect(outcome).toBe('exists')

    const row = await pg.query<{ password_hash: string }>('SELECT password_hash FROM admin_user')
    expect(await verifyPassword('original-password', row.rows[0]?.password_hash ?? '')).toBe(true)
    expect(await verifyPassword('a-different-password', row.rows[0]?.password_hash ?? '')).toBe(
      false,
    )
  })

  it('leaves an existing admin alone even when env names a different email', async () => {
    await ensureAdminUser(pg, { email: 'first@example.test', password: 'original-password' })
    expect(
      await ensureAdminUser(pg, { email: 'second@example.test', password: 'other-password' }),
    ).toBe('exists')

    const rows = await pg.query<{ email: string }>('SELECT email FROM admin_user')
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.email).toBe('first@example.test')
  })
})
