import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  SESSION_MAX_AGE_MS,
  SESSION_RENEW_WITHIN_MS,
  SESSION_TTL_MS,
  SessionStore,
  hashSessionToken,
} from './sessions.js'

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

  it('renews a session inside the renewal window when { renew: true } is passed', async () => {
    // Issued with a 10s TTL, renewed by a store whose TTL is 10 minutes: the
    // renewed expiry is later by construction, not by however many
    // milliseconds happened to elapse between the two calls. The original
    // form compared two timestamps computed from the SAME ttl and so
    // depended on at least 1ms passing between issue() and verify() -- true
    // most of the time, and intermittently false, which is a flaky test
    // rather than a real signal.
    const issuer = new SessionStore(pg, 10_000, 60_000)
    const { token, expiresAt } = await issuer.issue(adminId)
    const renewer = new SessionStore(pg, 600_000, 60_000)
    const rec = await renewer.verify(token, { renew: true })
    expect(rec?.renewed).toBe(true)
    expect(rec?.expiresAt.getTime()).toBeGreaterThan(expiresAt.getTime())

    const stored = await pg.query<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE id = $1',
      [hashSessionToken(token)],
    )
    expect(stored.rows[0]?.expires_at.getTime()).toBeGreaterThan(expiresAt.getTime())
  })

  // IMPORTANT 2 (and its rhyme in project/admin-routes.ts's requireSession):
  // non-renewing is the DEFAULT, not something a caller has to know to ask
  // for -- verify() must not slide expires_at forward for any caller that
  // never opted in, even when the session IS inside its renewal window.
  it('does not renew a session inside the renewal window by default', async () => {
    const issuer = new SessionStore(pg, 10_000, 60_000)
    const { token, expiresAt } = await issuer.issue(adminId)
    const reader = new SessionStore(pg, 600_000, 60_000)

    const rec = await reader.verify(token)
    expect(rec?.renewed).toBe(false)
    expect(rec?.expiresAt.getTime()).toBe(expiresAt.getTime())

    const stored = await pg.query<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE id = $1',
      [hashSessionToken(token)],
    )
    // The row itself must be untouched, not merely the returned record --
    // this is the same check "renews a session inside the renewal window"
    // makes on the write side, applied here to prove the ABSENCE of one.
    expect(stored.rows[0]?.expires_at.getTime()).toBe(expiresAt.getTime())
  })

  // Companion: the same token, same store, verified with an explicit
  // { renew: true } right after, DOES renew -- proving the row was never
  // touched by the default (non-renewing) call above, not merely that this
  // particular call happened not to renew for some unrelated reason (e.g.
  // already outside the window).
  it('an explicit { renew: true } still renews after a default (non-renewing) read', async () => {
    const issuer = new SessionStore(pg, 10_000, 60_000)
    const { token, expiresAt } = await issuer.issue(adminId)
    const store = new SessionStore(pg, 600_000, 60_000)

    await store.verify(token)
    const rec = await store.verify(token, { renew: true })
    expect(rec?.renewed).toBe(true)
    expect(rec?.expiresAt.getTime()).toBeGreaterThan(expiresAt.getTime())
  })

  it('does not renew a session outside the renewal window', async () => {
    const store = new SessionStore(pg, 10 * 60_000, 1000)
    const { token, expiresAt } = await store.issue(adminId)
    // { renew: true } is load-bearing here: verify()'s default is now
    // non-renewing (see sessions.ts's own docstring), so a bare
    // store.verify(token) would report renewed: false regardless of
    // whether the session is inside or outside its renewal window --
    // pinning nothing about the window boundary this test exists to check.
    // Without the explicit opt-in, this test passed even when the mutation
    // `if (!renew || expiresAt... > this.renewWithinMs)` was collapsed to
    // `if (!renew)`, deleting the window check entirely.
    const rec = await store.verify(token, { renew: true })
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

  it('refuses a session older than the max-age cap, even with expires_at still in the future', async () => {
    // maxAgeMs of -1000 puts the cutoff 1s in the future, so a row created
    // "now" is already over-age -- the same no-sleep trick the ttlMs tests
    // use, applied to created_at instead of expires_at. ttlMs stays at its
    // normal default, so expires_at is 30 days out: the cap is what refuses
    // this session, not ordinary expiry.
    const store = new SessionStore(pg, SESSION_TTL_MS, SESSION_RENEW_WITHIN_MS, -1000)
    const { token } = await store.issue(adminId)
    expect(await store.verify(token)).toBeNull()
  })

  it('verifies and still renews a session that is within the max-age cap', async () => {
    // Same issuer/renewer split as "renews a session inside the renewal
    // window", so the renewed expiry is later by construction rather than
    // by elapsed wall-clock time -- with an explicit, generous max-age on
    // both stores, proving the cap does not interfere with a session
    // nowhere near it.
    const issuer = new SessionStore(pg, 10_000, 60_000, SESSION_MAX_AGE_MS)
    const { token, expiresAt } = await issuer.issue(adminId)
    const renewer = new SessionStore(pg, 600_000, 60_000, SESSION_MAX_AGE_MS)
    const rec = await renewer.verify(token, { renew: true })
    expect(rec?.adminUserId).toBe(adminId)
    expect(rec?.renewed).toBe(true)
    expect(rec?.expiresAt.getTime()).toBeGreaterThan(expiresAt.getTime())
  })

  it('sweep removes an over-age row whose expires_at is still in the future', async () => {
    const overAge = new SessionStore(pg, SESSION_TTL_MS, SESSION_RENEW_WITHIN_MS, -1000)
    const { token } = await overAge.issue(adminId)

    const before = await pg.query('SELECT 1 FROM sessions WHERE id = $1', [hashSessionToken(token)])
    expect(before.rows).toHaveLength(1)

    const removed = await overAge.sweep()
    expect(removed).toBeGreaterThanOrEqual(1)

    const after = await pg.query('SELECT 1 FROM sessions WHERE id = $1', [hashSessionToken(token)])
    expect(after.rows).toHaveLength(0)
  })
})
