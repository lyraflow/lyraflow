import { describe, expect, it } from 'vitest'
import { FeedCursorError, decodeFeedCursor, encodeFeedCursor } from './cursor.js'

describe('feed cursor', () => {
  it('round-trips a position', () => {
    const c = {
      timestamp: '2026-08-08 10:00:00.123',
      eventId: '11111111-1111-4111-8111-111111111111',
    }
    expect(decodeFeedCursor(encodeFeedCursor(c))).toEqual(c)
  })

  it('rejects anything that is not one of ours', () => {
    // Every failure collapses to one error: a caller cannot act differently on
    // "not a cursor" than on "a cursor from a different shape", and the
    // distinction would only ever reach a log.
    //
    // The last two are shape-valid (an array of two strings) but
    // semantically invalid — a non-date timestamp, a non-UUID event id.
    // Without the timestamp/UUID checks in `decodeFeedCursor`, both of
    // these previously sailed through this function and only failed once
    // bound into the ClickHouse query, which this route's generic error
    // handler turns into a 503 rather than the 400 every other malformed
    // cursor gets — see that function's own docstring.
    for (const bad of [
      '',
      'not-base64!!',
      btoa('{}'),
      btoa('["only-one"]'),
      btoa('[1,2]'),
      encodeFeedCursor({
        timestamp: 'not-a-date',
        eventId: '11111111-1111-4111-8111-111111111111',
      }),
      encodeFeedCursor({ timestamp: '2026-08-08 10:00:00.123', eventId: 'not-a-uuid' }),
    ]) {
      expect(() => decodeFeedCursor(bad)).toThrow(FeedCursorError)
    }
  })
})
