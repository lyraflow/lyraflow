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

/**
 * Every failure — malformed base64, malformed JSON, the wrong shape —
 * collapses to the single `FeedCursorError`. A caller cannot act
 * differently on "not a cursor" than on "a cursor from a different shape",
 * and the distinction would only ever reach a log.
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
  return { timestamp: parsed[0], eventId: parsed[1] }
}
