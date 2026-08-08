/**
 * The keyset cursor for GET /v1/events.
 *
 * Deliberately NOT signed, unlike the segment cursor (segments/routes.ts),
 * which is HMAC-signed because it carries a page counter enforcing a product
 * limit — an unsigned segment cursor could be forged to walk past that
 * limit. This cursor enforces nothing at all: `--follow` is meant to page
 * forever, and a forged position only lets a key holder read their own
 * project's events in a different order than they could already, by
 * supplying their own `since`/`until`. Signing it would imply a guarantee
 * this cursor does not make.
 */

export class FeedCursorError extends Error {
  constructor() {
    super('invalid cursor')
    this.name = 'FeedCursorError'
  }
}

export interface FeedCursor {
  timestamp: string
  eventId: string
}

export function encodeFeedCursor(c: FeedCursor): string {
  return Buffer.from(JSON.stringify([c.timestamp, c.eventId])).toString('base64url')
}

// The exact shape `chDateTime` (@lyraflow/core) always produces, and the
// only shape a real `FeedRow.timestamp` round-tripped through this cursor
// ever has: 'YYYY-MM-DD HH:MM:SS.mmm'. Checked structurally AND for real
// calendar validity (an out-of-range month/day/hour still matches this
// regex) below, by handing it to `Date` the same way `parseChDateTime`
// does.
const TIMESTAMP_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Every failure — malformed base64, malformed JSON, the wrong shape, or a
 * value that is a string but not one this route could ever have produced —
 * collapses to the single `FeedCursorError`. A caller cannot act
 * differently on "not a cursor" than on "a cursor from a different shape",
 * and the distinction would only ever reach a log.
 *
 * The timestamp/UUID shape checks below matter *because* this cursor is
 * deliberately unsigned (see the module docstring): a truncated or
 * hand-edited `--follow` position is an expected input, not an attack, and
 * without them a shape-valid-but-semantically-invalid cursor (a non-date
 * `timestamp`, a non-UUID `eventId`) sailed straight through this function
 * and only failed once it reached ClickHouse as a bound parameter — which
 * surfaces through this route as a generic `503 {"error":"unavailable"}`
 * (app.ts's catch-all for an unexpected throw), indistinguishable from a
 * real outage, for what is actually an ordinary client error. Validating
 * here turns that into the same `400 {"error":"invalid_cursor"}` every
 * other malformed cursor already gets.
 */
export function decodeFeedCursor(s: string): FeedCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    throw new FeedCursorError()
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string'
  ) {
    throw new FeedCursorError()
  }
  const [timestamp, eventId] = parsed
  if (
    !TIMESTAMP_SHAPE.test(timestamp) ||
    Number.isNaN(Date.parse(`${timestamp.replace(' ', 'T')}Z`))
  ) {
    throw new FeedCursorError()
  }
  if (!UUID_SHAPE.test(eventId)) {
    throw new FeedCursorError()
  }
  return { timestamp, eventId }
}
