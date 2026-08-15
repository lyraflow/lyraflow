import { verifyPassword } from '@lyraflow/core'
import type { Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
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
    const rec = await sessions.verify(token)
    if (!rec) return reply.code(401).send({ error: 'no_session' })
    if (rec.renewed) setSessionCookie(reply, req, token, rec.expiresAt)

    const res = await pg.query<{ email: string }>('SELECT email FROM admin_user WHERE id = $1', [
      rec.adminUserId,
    ])
    reply.header('cache-control', 'no-store')
    return reply.code(200).send({ email: res.rows[0]?.email ?? null })
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
