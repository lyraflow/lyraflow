import { join } from 'node:path'
import { verifyPassword } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EmptyPasswordError, setAdminPassword } from './set-admin-password.js'

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
    migrations: loadMigrations(join(import.meta.dirname, '../../db/migrations')),
    appSchemaVersion: 999,
  })
})

beforeEach(async () => {
  await pg.query('DELETE FROM admin_user')
})

afterAll(async () => {
  await pg.query('DELETE FROM admin_user')
  await pg.end()
  await ch.close()
})

describe('setAdminPassword', () => {
  it('creates the admin when none exists', async () => {
    expect(await setAdminPassword(pg, 'new@example.test', 'a-good-password')).toBe('created')
    const row = await pg.query<{ email: string; password_hash: string }>(
      'SELECT email, password_hash FROM admin_user',
    )
    expect(row.rows[0]?.email).toBe('new@example.test')
    expect(await verifyPassword('a-good-password', row.rows[0]?.password_hash ?? '')).toBe(true)
  })

  it('replaces the password and the email of the existing admin', async () => {
    await setAdminPassword(pg, 'old@example.test', 'old-password')
    expect(await setAdminPassword(pg, 'new@example.test', 'new-password')).toBe('updated')

    const rows = await pg.query<{ email: string; password_hash: string }>(
      'SELECT email, password_hash FROM admin_user',
    )
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]?.email).toBe('new@example.test')
    expect(await verifyPassword('new-password', rows.rows[0]?.password_hash ?? '')).toBe(true)
    expect(await verifyPassword('old-password', rows.rows[0]?.password_hash ?? '')).toBe(false)
  })

  // Every existing session was issued against the old password. Leaving them
  // alive makes "I changed the password" mean nothing to whoever already
  // holds a stolen cookie -- which is the single most likely reason an
  // operator runs this command at all.
  it('revokes every existing session', async () => {
    await setAdminPassword(pg, 'a@example.test', 'old-password')
    const admin = await pg.query<{ id: string }>('SELECT id FROM admin_user')
    await pg.query(
      "INSERT INTO sessions (id, admin_user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')",
      ['set-admin-password-suite-session', Number(admin.rows[0]?.id)],
    )

    await setAdminPassword(pg, 'a@example.test', 'new-password')

    const left = await pg.query('SELECT 1 FROM sessions WHERE id = $1', [
      'set-admin-password-suite-session',
    ])
    expect(left.rows).toHaveLength(0)
  })

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
  ])('refuses a %s password', async (_name, password) => {
    await expect(setAdminPassword(pg, 'a@example.test', password)).rejects.toBeInstanceOf(
      EmptyPasswordError,
    )
    expect((await pg.query('SELECT 1 FROM admin_user')).rows).toHaveLength(0)
  })
})
