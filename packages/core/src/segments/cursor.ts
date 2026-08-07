/**
 * The position of the last row of a page: the `(last_seen, person_id)` pair
 * the next page continues after.
 *
 * Deliberately carries nothing tenant-scoped. `project_id` and the
 * suppression filter are re-injected on every request from the authenticated
 * key, never read from here, so a caller who tampers with a cursor can only
 * move around inside a segment they already have access to.
 */
export interface Cursor {
  /** ClickHouse DateTime64(3) text, e.g. `2026-08-06 10:00:00.000`. */
  lastSeen: string
  personId: string
  /**
   * The instant the WALK began, minted on page 1 and echoed by every later
   * page. Carried here rather than recovered from the cache because the cache
   * can evict mid-walk: if `as_of` came from whatever produced each page, an
   * eviction would silently mint a fresh timestamp and the pages of one walk
   * would claim different instants. Putting it in the cursor makes
   * "one walk, one as_of" structural instead of dependent on a cache hit.
   *
   * Not tenant-scoped: tampering with it only mislabels the tamperer's own
   * response.
   */
  asOf: string
}

export class CursorError extends Error {
  constructor() {
    super('cursor is malformed')
    this.name = 'CursorError'
  }
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify([c.lastSeen, c.personId, c.asOf])).toString('base64url')
}

/**
 * Every failure mode collapses to one error type: a caller cannot act
 * differently on "not base64" than on "wrong shape", and the distinction
 * would only ever reach a log.
 *
 * The shape check is not optional. Base64 that decodes to valid JSON of the
 * wrong shape is the dangerous input — it passes a `try/catch` around
 * `JSON.parse` and then hands the compiler `undefined`, which becomes SQL
 * with a missing bound parameter rather than a rejected request.
 */
export function decodeCursor(s: string): Cursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    throw new CursorError()
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw new CursorError()
  const [lastSeen, personId, asOf] = parsed
  if (typeof lastSeen !== 'string' || typeof personId !== 'string' || typeof asOf !== 'string') {
    throw new CursorError()
  }
  return { lastSeen, personId, asOf }
}
