import { hashPassword } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'

export type BootstrapOutcome = 'created' | 'exists' | 'not_configured'

export interface AdminEnv {
  email: string | undefined
  password: string | undefined
}

/**
 * Creates the single admin account from the installer-generated environment,
 * exactly once, and never touches it again.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the one that matters. An install
 * that predates the admin account has no LYRAFLOW_ADMIN_PASSWORD in its
 * `.env`, and it must still boot -- so a missing value is `not_configured`,
 * not a fatal. What must NEVER happen is inventing a password (nobody could
 * log in, and an attacker gains a live account) or writing an empty hash
 * (which `verifyPassword` would refuse, leaving a permanently unusable row
 * that `exists` then protects from ever being replaced). The UI renders
 * `not_configured` as a runnable `set-admin-password` invocation -- the
 * containerised one, since that is what the documented install produces
 * (#129).
 *
 * `exists` deliberately ignores the environment entirely, including a
 * DIFFERENT email. Reconciling from `.env` on every boot would look helpful
 * and would silently revert a password changed by the CLI on the next
 * restart -- the operator would have no way to tell that from "the change
 * did not take".
 */
export async function ensureAdminUser(pg: Pool, env: AdminEnv): Promise<BootstrapOutcome> {
  const existing = await pg.query('SELECT 1 FROM admin_user LIMIT 1')
  if (existing.rows.length > 0) return 'exists'

  const email = env.email?.trim()
  const password = env.password?.trim()
  if (!email || !password) return 'not_configured'

  const hash = await hashPassword(password)
  // ON CONFLICT DO NOTHING, not because two processes race today -- there is
  // one -- but because this runs on every boot and the check above is a
  // separate statement from the insert. A crash-looping container restarted
  // twice in the same second must not turn a unique violation into a fatal.
  const res = await pg.query(
    'INSERT INTO admin_user (email, password_hash) VALUES ($1, $2) ON CONFLICT (email) DO NOTHING',
    [email, hash],
  )
  return (res.rowCount ?? 0) > 0 ? 'created' : 'exists'
}
