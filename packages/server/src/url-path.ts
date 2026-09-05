/**
 * Reduces `req.url` to the single normalized path every decision in this
 * server makes against a path — `isApiPath` and `looksLikeFile` in
 * static.ts, and `redactShareToken` in shared/redact.ts. Important 8 from
 * the whole-branch review: the first two used to normalize independently
 * (one stripped the query string, the other matched `req.url` verbatim,
 * query string and all), and that seam let three shapes through the
 * fallback that should never reach it:
 *
 * - `/v1?x=1` — `isApiPath` compared the WHOLE url including `?x=1` against
 *   the bare `/v1` prefix, which never matches a string with a query string
 *   appended.
 * - `//v1/events` — a routine client bug (joining a base URL ending in `/`
 *   with a path beginning with `/`) that used to produce a clean JSON 404
 *   and, unnormalized, no longer matched any `API_PREFIXES` entry at all.
 * - `/v1%2Fnope` — an encoded slash that never matches a literal `/`
 *   comparison, letting a caller dodge the prefix check by encoding it away.
 *
 * One function, called from every such decision, is what keeps them from
 * drifting apart again the way they did the first time. It lives in its own
 * module rather than in static.ts for exactly that reason: the share-token
 * redactor needs it too, and importing static.ts would drag
 * `@fastify/static` into a pure-string unit test — which is the kind of
 * friction that produces a second copy.
 *
 * The same three shapes are how a token slipped past a literal-prefix
 * redactor: `//v1/shared/<token>` and `/v1%2Fshared/<token>` both 404 at
 * the router, and `req.url` is logged raw on a 404 too.
 */
export function normalizePath(url: string): string {
  const withoutQuery = url.split('?')[0] ?? url
  let decoded = withoutQuery
  try {
    decoded = decodeURIComponent(withoutQuery)
  } catch {
    // Malformed percent-encoding (e.g. a lone `%`) — fall back to the
    // undecoded path rather than throwing. Nothing downstream assumes a
    // successful decode; worst case this path simply fails to match an API
    // prefix and falls through to the file/SPA decision on its raw form,
    // which is the same as the behaviour before decoding was added.
  }
  // Collapse repeated slashes so `//v1/events` normalizes to `/v1/events` —
  // what a correctly-joined caller would have sent.
  return decoded.replace(/\/{2,}/g, '/')
}
