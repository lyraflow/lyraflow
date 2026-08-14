import type { FastifyReply, FastifyRequest } from 'fastify'

export const SESSION_COOKIE = 'lf_session'

/**
 * Required on EVERY session-authenticated request, read or write. An HTML
 * form cannot set a custom header, and a cross-origin XHR that tries
 * triggers a preflight -- which these routes answer with no CORS headers at
 * all, because @fastify/cors is deliberately scoped to the four write-key
 * ingest routes only (see ingest/routes.ts's own long comment). So this one
 * header, together with SameSite=Lax, is the whole CSRF story, and it is one
 * rule rather than a token to mint, store and compare.
 */
export const UI_HEADER = 'x-lyraflow-ui'

/**
 * Names the project a session is acting on. Carries the numeric project id,
 * not the slug: a slug is a display value a rename changes, and every
 * foreign key in Postgres already means the id by "project".
 */
export const PROJECT_HEADER = 'x-lyraflow-project'

/**
 * `Secure` is CONDITIONAL, and getting this wrong in the safe-looking
 * direction breaks the product. The default install in the README is plain
 * HTTP on localhost:3000; a browser silently discards a `Secure` cookie sent
 * over HTTP, so an unconditional flag makes every login fail with no error
 * in any log, presenting exactly as a wrong password.
 *
 * `req.protocol` is the only signal available: TLS terminates at a reverse
 * proxy, which forwards to this process over HTTP, and the domain the
 * operator configured is a value the server never reads for this purpose.
 * `trustProxy: true` is already set in app.ts, so `req.protocol` reflects
 * `X-Forwarded-Proto`.
 */
export function setSessionCookie(
  reply: FastifyReply,
  req: FastifyRequest,
  token: string,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: req.protocol === 'https',
    expires: expiresAt,
  })
}

export function clearSessionCookie(reply: FastifyReply, req: FastifyRequest): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: req.protocol === 'https',
  })
}

/** Sends 403 and returns false when the CSRF header is absent. */
export function requireUiHeader(req: FastifyRequest, reply: FastifyReply): boolean {
  if (req.headers[UI_HEADER] === undefined) {
    reply.code(403).send({ error: 'missing_ui_header' })
    return false
  }
  return true
}
