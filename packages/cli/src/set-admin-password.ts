import { hashPassword } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'

export class EmptyPasswordError extends Error {
  constructor() {
    super(
      'Refusing to set an empty password. Pipe one in, e.g. `... | lyraflow set-admin-password you@example.com`.',
    )
    this.name = 'EmptyPasswordError'
  }
}

/**
 * The only way to change the admin password, and the recovery path for an
 * install that upgraded into the admin account without one in its `.env`.
 *
 * There is at most one admin row (`admin_user` is a singleton by product
 * decision, not by constraint), so this replaces whichever row is there
 * rather than matching on email -- an operator who has forgotten the
 * password has usually also forgotten which address it was under, and
 * matching on email would answer that with a silent no-op.
 */
export async function setAdminPassword(
  pg: Pool,
  email: string,
  password: string,
): Promise<'created' | 'updated'> {
  const trimmed = password.trim()
  if (trimmed.length === 0) throw new EmptyPasswordError()
  const hash = await hashPassword(trimmed)

  const existing = await pg.query<{ id: string }>('SELECT id FROM admin_user LIMIT 1')
  const row = existing.rows[0]
  if (!row) {
    await pg.query('INSERT INTO admin_user (email, password_hash) VALUES ($1, $2)', [email, hash])
    return 'created'
  }

  await pg.query('UPDATE admin_user SET email = $2, password_hash = $3 WHERE id = $1', [
    Number(row.id),
    email,
    hash,
  ])
  // Every live session was issued against the credential this call just
  // replaced. See the test for why leaving them alive defeats the point of
  // the command.
  await pg.query('DELETE FROM sessions WHERE admin_user_id = $1', [Number(row.id)])
  return 'updated'
}
