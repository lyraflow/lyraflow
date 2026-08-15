import { createHash, randomBytes } from 'node:crypto'
import type { Pool } from '@lyraflow/db'

/** 30 days. Long enough that a solo operator is not re-authenticating weekly. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Re-issued when this much or less remains, so an active admin never expires mid-use. */
export const SESSION_RENEW_WITHIN_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The hard ceiling on a session's total age, regardless of renewal.
 *
 * Renewal is sliding, so without this a cookie replayed once inside every
 * renewal window lives forever -- and the threat this product actually
 * documents is a stolen cookie, which grants every project on the install.
 * 90 days is generous for a solo operator's dashboard and still bounds that
 * exposure to a quarter rather than to "until someone notices".
 *
 * Enforced in the same WHERE clause as `expires_at`, for the same reason:
 * an over-age row must be unusable the instant it is over-age, whether or
 * not the sweeper has reached it.
 */
export const SESSION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000

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
  /**
   * True when this verify() call actually extended the row -- which only
   * ever happens when the caller asked to renew (the default) AND the
   * session was inside its renewal window. `false` covers both "outside
   * the window" and "renewal not requested"; a caller that cannot itself
   * re-send the cookie (see `verify`'s `renew` option) must never see
   * `true` here, because nothing downstream of it will act on it.
   */
  renewed: boolean
}

export class SessionStore {
  constructor(
    private readonly pg: Pool,
    // Overridable so a test can prove expiry and renewal without sleeping
    // for the production values. Production passes neither.
    private readonly ttlMs: number = SESSION_TTL_MS,
    private readonly renewWithinMs: number = SESSION_RENEW_WITHIN_MS,
    private readonly maxAgeMs: number = SESSION_MAX_AGE_MS,
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
   * Expiry and the max-age cap are both decided HERE, in SQL, rather than by
   * reading the row and comparing in JS -- `expires_at > now()` and
   * `created_at > $2` in the WHERE clause mean a row the sweeper has not
   * reached yet is already unusable, so the sweeper is housekeeping rather
   * than a security control. If it stops running, no expired or over-age
   * session becomes valid.
   *
   * `renew` (default `false`) governs whether landing inside the renewal
   * window actually performs the `UPDATE` -- pass `{ renew: true }` to opt
   * IN to a write. Non-renewing is the default, not an option a caller has
   * to know to reach for, because renewal is a cookie-lifecycle concern,
   * not a session-validity one: the only reason to slide `expires_at`
   * forward is that a client's cookie is about to follow it, and the only
   * two things true about a caller that can actually make that happen are
   * (a) it is the browser-facing route the cookie was set on, and (b) it
   * can call `setSessionCookie` on the SAME response.
   *
   * This codebase already had THREE separate places that verify a session
   * cookie -- `GET /v1/auth/session`, `auth/bridge.ts`'s project-scoped
   * authenticator, and `project/admin-routes.ts`'s `requireSession` -- and
   * they drifted: the bridge and `requireSession` both called the renewing
   * form for years before anyone noticed neither could act on `renewed`
   * (no `Set-Cookie` ever followed), which meant EVERY authenticated
   * request during a session's last 7 days (`SESSION_RENEW_WITHIN_MS`)
   * silently wrote to the `sessions` table -- on a route (`GET
   * /v1/projects`) a project switcher polls routinely. Defaulting to
   * non-renewing means a FOURTH caller gets the safe behaviour without
   * knowing to ask for it; `GET /v1/auth/session` is the one place that
   * opts in, with `{ renew: true }`, because it is the one place that can
   * actually re-send the cookie.
   */
  async verify(token: string, opts: { renew?: boolean } = {}): Promise<SessionRecord | null> {
    const renew = opts.renew ?? false
    const res = await this.pg.query<{ admin_user_id: string; expires_at: Date }>(
      'SELECT admin_user_id, expires_at FROM sessions WHERE id = $1 AND expires_at > now() AND created_at > $2',
      [hashSessionToken(token), new Date(Date.now() - this.maxAgeMs)],
    )
    const row = res.rows[0]
    if (!row) return null

    const expiresAt = row.expires_at
    if (!renew || expiresAt.getTime() - Date.now() > this.renewWithinMs) {
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

  /**
   * Removes both expired rows and over-age rows -- a row past the max-age
   * cap but with a future `expires_at` (kept alive by renewal) would
   * otherwise sit dead in the table for up to `ttlMs` more. Served by
   * `sessions_expires_at_idx` for the first condition.
   */
  async sweep(): Promise<number> {
    const res = await this.pg.query(
      'DELETE FROM sessions WHERE expires_at <= now() OR created_at <= $1',
      [new Date(Date.now() - this.maxAgeMs)],
    )
    return res.rowCount ?? 0
  }
}
