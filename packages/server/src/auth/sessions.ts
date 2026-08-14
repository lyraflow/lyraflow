import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from '@lyraflow/db'

/** 30 days. Long enough that a solo operator is not re-authenticating weekly. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Re-issued when this much or less remains, so an active admin never expires mid-use. */
export const SESSION_RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000

const TOKEN_BYTES = 32

/**
 * What lands in `sessions.id` is the SHA-256 of the cookie's token, never
 * the token. Same reasoning as `projects.server_key_hash`: a Postgres read
 * leak -- a backup on a laptop, a `SELECT *` in a support thread -- must not
 * be a set of live sessions. SHA-256 unsalted is correct here and would not
 * be for a password: the input is 32 bytes of CSPRNG output, so there is no
 * dictionary to attack and no work factor worth paying.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface SessionRecord {
  adminUserId: number
  expiresAt: Date
  /** True when this verify() extended the row; the route re-sends the cookie. */
  renewed: boolean
}

export class SessionStore {
  constructor(
    private readonly pg: Pool,
    // Overridable so a test can prove expiry and renewal without sleeping
    // for the production values. Production passes neither.
    private readonly ttlMs: number = SESSION_TTL_MS,
    private readonly renewWithinMs: number = SESSION_RENEW_WITHIN_MS,
  ) {}

  async issue(adminUserId: number): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    const expiresAt = new Date(Date.now() + this.ttlMs)
    await this.pg.query(
      'INSERT INTO sessions (id, admin_user_id, expires_at) VALUES ($1, $2, $3)',
      [hashSessionToken(token), adminUserId, expiresAt],
    )
    return { token, expiresAt }
  }

  /**
   * Expiry is decided HERE, in SQL, rather than by reading the row and
   * comparing in JS -- `expires_at > now()` in the WHERE clause means a row
   * the sweeper has not reached yet is already unusable, so the sweeper is
   * housekeeping rather than a security control. If it stops running, no
   * expired session becomes valid.
   */
  async verify(token: string): Promise<SessionRecord | null> {
    const res = await this.pg.query<{ admin_user_id: string; expires_at: Date }>(
      'SELECT admin_user_id, expires_at FROM sessions WHERE id = $1 AND expires_at > now()',
      [hashSessionToken(token)],
    )
    const row = res.rows[0]
    if (!row) return null

    const expiresAt = row.expires_at
    if (expiresAt.getTime() - Date.now() > this.renewWithinMs) {
      return { adminUserId: Number(row.admin_user_id), expiresAt, renewed: false }
    }

    const renewedTo = new Date(Date.now() + this.ttlMs)
    await this.pg.query('UPDATE sessions SET expires_at = $2 WHERE id = $1', [
      hashSessionToken(token),
      renewedTo,
    ])
    return { adminUserId: Number(row.admin_user_id), expiresAt: renewedTo, renewed: true }
  }

  async revoke(token: string): Promise<void> {
    await this.pg.query('DELETE FROM sessions WHERE id = $1', [hashSessionToken(token)])
  }

  /** Returns how many rows it removed. Served by `sessions_expires_at_idx`. */
  async sweep(): Promise<number> {
    const res = await this.pg.query('DELETE FROM sessions WHERE expires_at <= now()')
    return res.rowCount ?? 0
  }
}
