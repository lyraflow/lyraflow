import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SessionStore, hashSessionToken } from './sessions.js'

const pg = createPgPool('postgres://lyraflow:lyraflow@localhost:5433/lyraflow_test')
const ch = createChClient({
  url: 'http://localhost:8123',
  username: 'lyraflow',
  password: 'lyraflow',
  database: 'lyraflow_test',
})

// A prefix no other suite uses, per the shared-database rule.
const EMAIL = 'sessions-store-suite@example.test'
let adminId = 0

beforeAll(async () => {
  await migrate({
    pg,
    ch,
    migrations: loadMigrations(join(import.meta.dirname, '../../../db/migrations')),
    appSchemaVersion: 999,
  })
  await pg.query('DELETE FROM admin_user WHERE email = $1', [EMAIL])
  const r = await pg.query<{ id: string }>(
    'INSERT INTO admin_user (email, password_hash) VALUES ($1, $2) RETURNING id',
    [EMAIL, 'scrypt$16384$8$1$aa$bb'],
  )
  adminId = Number(r.rows[0]?.id)
})

afterAll(async () => {
  await pg.query('DELETE FROM admin_user WHERE email = $1', [EMAIL])
  await pg.end()
  await ch.close()
})

describe('SessionStore', () => {
  it('issues a token that verifies back to its admin', async () => {
    const store = new SessionStore(pg)
    const { token } = await store.issue(adminId)
    const rec = await store.verify(token)
    expect(rec?.adminUserId).toBe(adminId)
  })

  it('stores the token hashed, never in plaintext', async () => {
    const store = new SessionStore(pg)
    const { token } = await store.issue(adminId)

    const raw = await pg.query('SELECT 1 FROM sessions WHERE id = $1', [token])
    expect(raw.rows).toHaveLength(0)

    const hashed = await pg.query('SELECT 1 FROM sessions WHERE id = $1', [
      createHash('sha256').update(token).digest('hex'),
    ])
    expect(hashed.rows).toHaveLength(1)
    expect(hashSessionToken(token)).toBe(createHash('sha256').update(token).digest('hex'))
  })

  it('issues a different token every time', async () => {
    const store = new SessionStore(pg)
    const a = await store.issue(adminId)
    const b = await store.issue(adminId)
    expect(a.token).not.toBe(b.token)
  })

  it('refuses an expired session', async () => {
    // ttlMs of -1000 puts expires_at in the past at the moment of issue,
    // so this needs no sleep and no clock injection.
    const store = new SessionStore(pg, -1000)
    const { token } = await store.issue(adminId)
    expect(await store.verify(token)).toBeNull()
  })

  it('refuses an unknown token', async () => {
    const store = new SessionStore(pg)
    expect(await store.verify('not-a-session')).toBeNull()
  })

  it('revokes', async () => {
    const store = new SessionStore(pg)
    const { token } = await store.issue(adminId)
    await store.revoke(token)
    expect(await store.verify(token)).toBeNull()
  })

  it('renews a session inside the renewal window and reports it', async () => {
    // TTL 10s, renew when under 60s remain: every fresh session is already
    // inside its own renewal window, so one verify() must renew.
    const store = new SessionStore(pg, 10_000, 60_000)
    const { token, expiresAt } = await store.issue(adminId)
    const rec = await store.verify(token)
    expect(rec?.renewed).toBe(true)
    expect(rec?.expiresAt.getTime()).toBeGreaterThan(expiresAt.getTime())

    const stored = await pg.query<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE id = $1',
      [hashSessionToken(token)],
    )
    expect(stored.rows[0]?.expires_at.getTime()).toBeGreaterThan(expiresAt.getTime())
  })

  it('does not renew a session outside the renewal window', async () => {
    const store = new SessionStore(pg, 10 * 60_000, 1000)
    const { token, expiresAt } = await store.issue(adminId)
    const rec = await store.verify(token)
    expect(rec?.renewed).toBe(false)
    expect(rec?.expiresAt.getTime()).toBe(expiresAt.getTime())
  })

  it('sweeps expired rows and leaves live ones', async () => {
    const dead = new SessionStore(pg, -1000)
    await dead.issue(adminId)
    const live = new SessionStore(pg)
    const { token } = await live.issue(adminId)

    const removed = await live.sweep()
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(await live.verify(token)).not.toBeNull()
  })
})
