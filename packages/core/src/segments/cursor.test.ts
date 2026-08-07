import { describe, expect, it } from 'vitest'
import { CursorError, decodeCursor, encodeCursor } from './cursor.js'

const cursor = {
  lastSeen: '2026-08-06 10:00:00.000',
  personId: 'alice',
  asOf: '2026-08-07T00:00:00.000Z',
}

describe('cursor', () => {
  it('round-trips', () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  it('is opaque text a client will not try to read', () => {
    expect(encodeCursor(cursor)).not.toContain('alice')
  })

  it('rejects text that is not a cursor', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(CursorError)
  })

  it('rejects valid base64 that decodes to the wrong shape', () => {
    // The dangerous case: it decodes cleanly, so a naive implementation
    // hands the compiler `undefined` and emits SQL with a missing parameter.
    const wrong = Buffer.from(JSON.stringify({ nope: 1 })).toString('base64url')
    expect(() => decodeCursor(wrong)).toThrow(CursorError)
  })

  it('rejects a cursor whose fields are the wrong type', () => {
    const wrong = Buffer.from(JSON.stringify([5, 'a', 'x'])).toString('base64url')
    expect(() => decodeCursor(wrong)).toThrow(CursorError)
  })

  it('rejects a cursor whose personId is not a string', () => {
    const wrong = Buffer.from(
      JSON.stringify(['2026-08-06 10:00:00.000', 5, '2026-08-07T00:00:00.000Z']),
    ).toString('base64url')
    expect(() => decodeCursor(wrong)).toThrow(CursorError)
  })

  it('rejects a two-element cursor from before as_of was carried', () => {
    // Arity is checked, not just types: an older cursor decodes cleanly and
    // would otherwise leave asOf undefined, which is how a walk silently
    // starts minting a fresh timestamp per page again.
    const old = Buffer.from(JSON.stringify(['2026-08-06 10:00:00.000', 'alice'])).toString(
      'base64url',
    )
    expect(() => decodeCursor(old)).toThrow(CursorError)
  })

  it('rejects a cursor with more elements than it should have', () => {
    // Extra elements are not harmless: destructuring would bind the first
    // three and silently discard the rest, so a cursor from a future format
    // would be accepted and half-interpreted rather than rejected.
    const tooLong = Buffer.from(
      JSON.stringify(['2026-08-06 10:00:00.000', 'alice', '2026-08-07T00:00:00.000Z', 'extra']),
    ).toString('base64url')
    expect(() => decodeCursor(tooLong)).toThrow(CursorError)
  })

  it('carries the walk instant so every page reports one as_of', () => {
    expect(decodeCursor(encodeCursor(cursor)).asOf).toBe('2026-08-07T00:00:00.000Z')
  })

  it('decodes to exactly the three fields, so nothing tenant-scoped can ride along', () => {
    // project_id and the suppression filter are re-injected per request from
    // the authenticated key. A decoder that surfaced a fourth field would be a
    // tenancy hole, so the assertion is on what decodeCursor RETURNS, not on a
    // literal written in this file.
    expect(Object.keys(decodeCursor(encodeCursor(cursor))).sort()).toEqual([
      'asOf',
      'lastSeen',
      'personId',
    ])
  })
})
