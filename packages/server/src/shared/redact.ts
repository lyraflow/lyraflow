/** The one path prefix in this server whose NEXT segment is a credential. */
const SHARED_PREFIX = '/v1/shared/'

/**
 * `/v1/shared/<token>` and `/v1/shared/<token>/tiles/0/run` with the token
 * replaced by `[redacted]`; every other URL returned unchanged.
 *
 * The share token is the first credential this product carries in a URL
 * PATH. Every other one travels in a header -- a server key in
 * `x-lyraflow-server-key`, a session in `Cookie` -- and Fastify's default
 * request serializer logs no headers at all, so nothing before this route
 * existed could put a credential in a log line. `req.url` it does log, on
 * every request, at `info`.
 *
 * The segment is matched BY POSITION, not against `SHARE_TOKEN_PATTERN`. A
 * malformed segment is still somebody's guess at a credential, and a log of
 * near-misses is a log of how close an attacker got -- which is exactly the
 * thing an attacker with read access to the logs would want. Redacting only
 * what parses would also mean the redaction was itself a test of the token's
 * shape, readable off the log.
 *
 * Deliberately NOT redacting `/v1/shared` with no segment, or an empty one:
 * there is no token there to hide, and rewriting those would make the log
 * claim a request carried a credential when it did not.
 */
export function redactShareToken(url: string): string {
  if (!url.startsWith(SHARED_PREFIX)) return url
  const rest = url.slice(SHARED_PREFIX.length)
  // The token segment ends at the next `/`, `?` or `#` -- whichever comes
  // first -- so a query string and a `/tiles/...` tail both survive intact.
  const end = rest.search(/[/?#]/)
  if (rest === '' || end === 0) return url
  return `${SHARED_PREFIX}[redacted]${end === -1 ? '' : rest.slice(end)}`
}
