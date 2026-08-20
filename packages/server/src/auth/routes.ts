import { hashPassword, verifyPassword } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { type Readiness, refuseIfDraining } from '../health.js'
import { SESSION_COOKIE, clearSessionCookie, requireUiHeader, setSessionCookie } from './cookie.js'
import type { AttemptLimiter } from './rate-limit.js'
import type { SessionStore } from './sessions.js'

export interface AuthDeps {
  pg: Pool
  sessions: SessionStore
  limiter: AttemptLimiter
  readiness: Readiness
}

const LoginBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
})

/**
 * The shortest new password this accepts.
 *
 * Length and nothing else. Composition rules -- a digit, a symbol, mixed
 * case -- reliably produce WORSE passwords, because people satisfy them with
 * predictable substitutions on a short word rather than by choosing a longer
 * one. Twelve is the floor NIST settled on for user-chosen secrets, and this
 * is a single-admin instance behind a login that is already rate-limited.
 *
 * Applied only to a password being SET. Login keeps `min(1)`: an existing
 * password shorter than this must still be usable, or raising the floor
 * would lock out the operator it was meant to protect -- and the length of a
 * rejected login attempt is not a thing to disclose.
 */
export const MIN_PASSWORD_LENGTH = 12

const EmailBody = z.object({
  email: z.string().min(3).max(320).includes('@'),
  current_password: z.string().min(1).max(1024),
})

const PasswordBody = z.object({
  current_password: z.string().min(1).max(1024),
  new_password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
})

export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { pg, sessions, limiter, readiness } = deps

  /**
   * Unauthenticated by necessity: the SPA cannot know whether to render a
   * login form or "run `lyraflow set-admin-password`" without asking. It
   * discloses only whether an admin exists, which a login form discloses
   * anyway.
   *
   * MINOR A: deliberately EXEMPT from the drain gate. This is an
   * unauthenticated, readiness-shaped probe -- not a mutation and not a
   * credential check -- so there is nothing here a drain needs to protect
   * against, unlike login (which would start a new session) or the
   * cookie-bearing routes below (which touch the sessions table).
   */
  app.get('/v1/auth/state', async (_req, reply) => {
    const res = await pg.query('SELECT 1 FROM admin_user LIMIT 1')
    reply.header('cache-control', 'no-store')
    return reply.code(200).send({ configured: res.rows.length > 0 })
  })

  app.post('/v1/auth/login', async (req, reply) => {
    if (!requireUiHeader(req, reply)) return
    if (refuseIfDraining(readiness, reply)) return

    const body = LoginBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' })
    const { email, password } = body.data

    const keys = [`ip:${req.ip}`, `email:${email.toLowerCase()}`]
    if (!limiter.check(keys)) {
      return reply.code(429).header('retry-after', '900').send({ error: 'too_many_attempts' })
    }

    // Case-folded: the limiter's own key already lowercases the submitted
    // email, and the installer writes LYRAFLOW_ADMIN_EMAIL verbatim into
    // admin_user (ensureAdminUser never normalises it). Without this, an
    // operator who types `Admin@localhost` for a stored `admin@localhost`
    // gets `invalid_credentials` forever, and the identical body this route
    // deliberately returns for "no such account" means they cannot tell a
    // case mismatch from a wrong password. admin_user holds at most one row
    // in practice, so folding at read time is unambiguous and needs no
    // migration of what's already stored.
    const res = await pg.query<{ id: string; password_hash: string }>(
      'SELECT id, password_hash FROM admin_user WHERE lower(email) = lower($1)',
      [email],
    )
    const row = res.rows[0]
    // The unknown-email branch still runs a verify against a throwaway
    // digest, so that "no such account" and "wrong password" cost roughly
    // the same wall-clock time as well as returning the same body. Without
    // it the response time alone is the enumeration oracle the identical
    // body was written to close.
    let ok: boolean
    if (row) {
      ok = await verifyPassword(password, row.password_hash)
    } else {
      await verifyPassword(password, 'scrypt$16384$8$1$00$00')
      ok = false
    }

    if (!ok) {
      limiter.record(keys)
      reply.header('cache-control', 'no-store')
      return reply.code(401).send({ error: 'invalid_credentials' })
    }

    limiter.reset(keys)
    const { token, expiresAt } = await sessions.issue(Number(row?.id))
    setSessionCookie(reply, req, token, expiresAt)
    reply.header('cache-control', 'no-store')
    return reply.code(200).send({ email })
  })

  app.get('/v1/auth/session', async (req, reply) => {
    if (!requireUiHeader(req, reply)) return
    // MINOR A: this route performs SessionStore's renewal WRITE (see
    // sessions.ts) whenever the session is inside its renewal window, so
    // skipping the drain gate here would let a request during shutdown
    // still mutate the sessions table -- exactly the kind of new-traffic
    // side effect the gate exists to stop.
    if (refuseIfDraining(readiness, reply)) return
    const token = req.cookies?.[SESSION_COOKIE]
    if (!token) return reply.code(401).send({ error: 'no_session' })
    // The one deliberate opt-in: this is the only route that can act on
    // `renewed` by re-sending the cookie below, so it is the only caller
    // that asks verify() for the renewing form rather than relying on its
    // (non-renewing) default. See SessionStore.verify's own docstring.
    const rec = await sessions.verify(token, { renew: true })
    if (!rec) return reply.code(401).send({ error: 'no_session' })
    if (rec.renewed) setSessionCookie(reply, req, token, rec.expiresAt)

    const res = await pg.query<{ email: string }>('SELECT email FROM admin_user WHERE id = $1', [
      rec.adminUserId,
    ])
    reply.header('cache-control', 'no-store')
    return reply.code(200).send({ email: res.rows[0]?.email ?? null })
  })

  /**
   * The session's own admin id, or null after answering 401 itself.
   *
   * Shared by both routes below because they have identical gates and the
   * gates are the security-relevant part: a copy that drifted on the drain
   * check or the UI header would be the kind of difference nobody notices
   * until it matters.
   *
   * NON-RENEWING, like every route but `GET /v1/auth/session`: neither of
   * these re-sends the cookie, and `verify`'s renewing form is documented as
   * being only for the one caller that can.
   */
  async function requireAdmin(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ adminUserId: number; token: string } | null> {
    if (!requireUiHeader(req, reply)) return null
    if (refuseIfDraining(readiness, reply)) return null
    const token = req.cookies?.[SESSION_COOKIE]
    if (!token) {
      reply.code(401).send({ error: 'no_session' })
      return null
    }
    const rec = await sessions.verify(token)
    if (!rec) {
      reply.code(401).send({ error: 'no_session' })
      return null
    }
    return { adminUserId: rec.adminUserId, token }
  }

  /**
   * Confirms the caller knows the CURRENT password, under the same limiter
   * the login form uses.
   *
   * Both routes below take a current password, and without a limiter they
   * are a password oracle sitting behind a session -- a strictly easier
   * target than the login form, because it needs no email and answers with
   * a clean 401/200 split. Keyed by IP and by admin id so neither a single
   * host nor a single account can be ground down.
   *
   * A missing row cannot happen here -- a verified session guarantees one --
   * and the comparison inside `verifyPassword` is constant-time either way,
   * so a wrong password is not distinguishable from a right one by timing.
   *
   * Returns a plain boolean: it has already answered the caller's request
   * when it returns false, so a caller's only job is to stop.
   */
  async function confirmPassword(
    req: FastifyRequest,
    reply: FastifyReply,
    adminUserId: number,
    password: string,
  ): Promise<boolean> {
    const keys = [`ip:${req.ip}`, `admin:${adminUserId}`]
    if (!limiter.check(keys)) {
      reply.code(429).header('retry-after', '900').send({ error: 'too_many_attempts' })
      return false
    }
    const res = await pg.query<{ password_hash: string }>(
      'SELECT password_hash FROM admin_user WHERE id = $1',
      [adminUserId],
    )
    const hash = res.rows[0]?.password_hash
    if (hash === undefined || !(await verifyPassword(password, hash))) {
      limiter.record(keys)
      reply.code(401).send({ error: 'invalid_credentials' })
      return false
    }
    return true
  }

  /**
   * Change the admin's email address.
   *
   * Requires the current password: a session cookie is enough to READ this
   * account's data, and not enough to change the address that recovers it --
   * an unattended browser would otherwise be a full account takeover.
   *
   * Sessions are deliberately NOT revoked. An email change is an identity
   * change, not a credential one; the password that authenticates every
   * session is untouched, so ending them would be theatre.
   */
  app.patch('/v1/auth/email', async (req, reply) => {
    const admin = await requireAdmin(req, reply)
    if (!admin) return

    const body = EmailBody.safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'invalid_body' })
    const email = body.data.email.trim()
    if (email.length === 0) return reply.code(400).send({ error: 'invalid_body' })

    if (!(await confirmPassword(req, reply, admin.adminUserId, body.data.current_password))) return

    // Checked case-insensitively BEFORE the write, because
    // `admin_user_email_lower_key` is a lower(email) unique index: an
    // unchecked collision surfaces as a 23505 and a 500, which tells the
    // operator nothing about what to do. Excludes this admin's own row so
    // re-saving your own address in a different case is not a conflict.
    const clash = await pg.query(
      'SELECT 1 FROM admin_user WHERE lower(email) = lower($1) AND id <> $2',
      [email, admin.adminUserId],
    )
    if (clash.rows.length > 0) return reply.code(409).send({ error: 'email_taken' })

    await pg.query('UPDATE admin_user SET email = $1 WHERE id = $2', [email, admin.adminUserId])
    reply.header('cache-control', 'no-store')
    return reply.code(200).send({ email })
  })

  /**
   * Change the admin's password, and end every other session.
   *
   * The revocation is the point, not a courtesy. A password is changed most
   * urgently when the old one may be known to someone else, and a change
   * that left their session alive would have revoked nobody -- the stolen
   * cookie keeps working until it expires on its own.
   *
   * The browser making the change gets a FRESH session rather than keeping
   * its own: `revokeAllFor` takes the lot, so the cookie that authenticated
   * this request is dead by the time the response is written, and issuing a
   * new one is what keeps the operator from being logged out by their own
   * deliberate action.
   */
  app.patch('/v1/auth/password', async (req, reply) => {
    const admin = await requireAdmin(req, reply)
    if (!admin) return

    const body = PasswordBody.safeParse(req.body)
    // The minimum length is stated rather than left as a bare 400: a form
    // that refuses without saying what would be accepted is a guessing game.
    if (!body.success) {
      return reply.code(400).send({
        error: 'invalid_body',
        detail: `A new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      })
    }
    const { current_password, new_password } = body.data

    if (!(await confirmPassword(req, reply, admin.adminUserId, current_password))) return

    // Refused rather than accepted as a no-op: "change my password" that
    // ends with the same password is not what the operator meant, and
    // silently succeeding would tell them the old one was retired when it
    // was not.
    if (new_password === current_password) {
      return reply.code(400).send({ error: 'password_unchanged' })
    }

    await pg.query('UPDATE admin_user SET password_hash = $1 WHERE id = $2', [
      await hashPassword(new_password),
      admin.adminUserId,
    ])

    // Everything, including this request's own cookie -- then a new session
    // for this browser. Ordered this way so there is no instant in which the
    // old token is valid against the new password.
    await sessions.revokeAllFor(admin.adminUserId)
    const fresh = await sessions.issue(admin.adminUserId)
    setSessionCookie(reply, req, fresh.token, fresh.expiresAt)
    reply.header('cache-control', 'no-store')
    return reply.code(200).send({ ok: true })
  })

  app.post('/v1/auth/logout', async (req, reply) => {
    if (!requireUiHeader(req, reply)) return
    if (refuseIfDraining(readiness, reply)) return
    const token = req.cookies?.[SESSION_COOKIE]
    // Idempotent: logging out twice, or with no cookie, is a 204. There is
    // nothing to report and nothing an operator can do differently.
    if (token) await sessions.revoke(token)
    clearSessionCookie(reply, req)
    return reply.code(204).send()
  })
}
