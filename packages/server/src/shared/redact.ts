import { normalizePath } from '../url-path.js'

/** The one path prefix in this server whose next segment is a credential.
 *  Compared against a LOWERCASED normalized path, so `/V1/Shared/<token>`
 *  -- which 404s at the router, and whose `req.url` is logged just the same
 *  -- cannot dodge the match on case. */
const SHARED_PREFIX = '/v1/shared/'
const REDACTED = '[redacted]'

/**
 * `/v1/shared/<token>` and `/v1/shared/<token>/tiles/0/run` with the token
 * replaced by `[redacted]`; every other URL returned unchanged.
 *
 * The share token is the first credential this product carries in a URL
 * PATH. Every other one travels in a header -- a project server key in
 * `x-lyraflow-server-key`, a browser session in `Cookie` -- and Fastify's
 * default request serializer logs no headers at all, so nothing before the
 * viewer routes could put a credential in a log line. `req.url` it does
 * log, on every request, at `info`.
 *
 * MATCHED AGAINST THE NORMALIZED PATH, never the raw string. A literal
 * prefix comparison is bypassable, and every bypass still reaches the log:
 * `//v1/shared/<token>`, `/v1/shared//<token>`, `/v1%2Fshared/<token>` and
 * `/V1/shared/<token>` all 404 at the router, and Fastify logs `req.url`
 * raw on a 404 exactly as it does on a 200. `normalizePath` (url-path.ts)
 * is the SAME normalizer `static.ts`'s API-prefix check uses, deliberately
 * -- see its docstring for why a second copy is the failure being avoided.
 *
 * The segment is matched BY POSITION, not against `SHARE_TOKEN_PATTERN`. A
 * malformed segment is still somebody's guess at a credential, and a log of
 * near-misses is a log of how close a guesser got. Redacting only what
 * parses would also make the redaction itself a readable test of the
 * token's shape.
 *
 * The QUERY STRING is carried over from the original URL rather than
 * dropped: `normalizePath` strips it, and a log line that loses every
 * request's query would be a real loss of the thing logs are for. The path
 * that is emitted is the normalized one, so a doubled slash or an encoded
 * separator is no longer visible in the log -- a small, deliberate trade
 * against leaking the credential those shapes were hiding behind.
 *
 * Deliberately NOT rewriting `/v1/shared`, or a path whose every segment
 * after the prefix is empty: there is no token there to hide, and
 * rewriting them would make the log claim a request carried a credential
 * when it did not.
 */
export function redactShareToken(url: string): string {
  const path = normalizePath(url)
  if (!path.toLowerCase().startsWith(SHARED_PREFIX)) return url
  const segments = path.slice(SHARED_PREFIX.length).split('/')
  // `normalizePath` has already collapsed repeated slashes, so an empty
  // first segment can now only be a trailing one (`/v1/shared/`). The scan
  // is kept anyway rather than assuming that: this function's whole point
  // is that it must not depend on the shape it was handed.
  const at = segments.findIndex((s) => s !== '')
  if (at === -1) return url
  segments[at] = REDACTED
  const query = url.slice(url.indexOf('?'))
  return path.slice(0, SHARED_PREFIX.length) + segments.join('/') + (url.includes('?') ? query : '')
}
