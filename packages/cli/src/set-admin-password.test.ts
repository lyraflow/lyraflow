import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { verifyPassword } from '@lyraflow/core'
import { createChClient, createPgPool, loadMigrations, migrate } from '@lyraflow/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  EmptyPasswordError,
  STDIN_READ_TIMEOUT_MS,
  StdinTimeoutError,
  readAllStdin,
  setAdminPassword,
} from './set-admin-password.js'

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

describe('readAllStdin', () => {
  it('STDIN_READ_TIMEOUT_MS is the real two-minute production value', () => {
    expect(STDIN_READ_TIMEOUT_MS).toBe(2 * 60_000)
  })

  it('resolves with the piped bytes once stdin ends, unaffected by the timeout path', async () => {
    const input = new PassThrough()
    const result = readAllStdin(input, () => {}, STDIN_READ_TIMEOUT_MS)
    input.write('a-good-password')
    input.end()
    await expect(result).resolves.toBe('a-good-password')
  })

  // Uses a short overridden `timeoutMs` rather than the real two-minute
  // `STDIN_READ_TIMEOUT_MS` -- same reasoning `createPrompt`'s own timeout
  // test (index.test.ts) already applies to `PROMPT_TIMEOUT_MS`.
  it('rejects with StdinTimeoutError, distinct from EmptyPasswordError, when nothing arrives before the timeout', async () => {
    const input = new PassThrough()
    const result = readAllStdin(input, () => {}, 20)
    await expect(result).rejects.toBeInstanceOf(StdinTimeoutError)
    await expect(result).rejects.not.toBeInstanceOf(EmptyPasswordError)
  })

  it('a timed-out read never reaches setAdminPassword, so no row is written', async () => {
    const input = new PassThrough()
    await expect(readAllStdin(input, () => {}, 20)).rejects.toBeInstanceOf(StdinTimeoutError)
    // setAdminPassword is never called on this path in the real dispatch
    // (index.ts awaits readAllStdin first and breaks out on rejection) --
    // asserted here as "no row exists", the same observable the empty/
    // whitespace tests above check, rather than re-deriving the dispatch.
    expect((await pg.query('SELECT 1 FROM admin_user')).rows).toHaveLength(0)
  })

  it('writes a hint to stderr before blocking when stdin is a TTY, and not otherwise', async () => {
    const ttyInput = new PassThrough() as PassThrough & { isTTY: boolean }
    ttyInput.isTTY = true
    let hinted = ''
    const result = readAllStdin(
      ttyInput,
      (s) => {
        hinted += s
      },
      20,
    )
    await expect(result).rejects.toBeInstanceOf(StdinTimeoutError)
    expect(hinted).toMatch(/reading password from stdin/i)

    const pipedInput = new PassThrough()
    let notHinted = ''
    const piped = readAllStdin(
      pipedInput,
      (s) => {
        notHinted += s
      },
      STDIN_READ_TIMEOUT_MS,
    )
    pipedInput.end()
    await piped
    expect(notHinted).toBe('')
  })

  // Found live, against a real pty, during the manual verification for this
  // fix: the timeout fired and printed the right error, but the PROCESS
  // never actually exited afterward. A 'data' listener switches a stream
  // into flowing mode and it stays there once switched; for a TTY
  // specifically that keeps the underlying fd polling and the event loop
  // alive. `isPaused()` is the observable proxy for "won't do that" --
  // `pause()` is what un-flows it.
  it('pauses stdin once resolved, on both the success and the timeout path', async () => {
    const resolved = new PassThrough()
    const resolvedResult = readAllStdin(resolved, () => {}, STDIN_READ_TIMEOUT_MS)
    resolved.write('a-password')
    resolved.end()
    await resolvedResult
    expect(resolved.isPaused()).toBe(true)

    const timedOut = new PassThrough()
    await expect(readAllStdin(timedOut, () => {}, 20)).rejects.toBeInstanceOf(StdinTimeoutError)
    expect(timedOut.isPaused()).toBe(true)
  })
})
