import { createHmac, timingSafeEqual } from 'node:crypto'
import { type Cursor, CursorError } from '@lyraflow/core'
import type { Project } from '../auth/project-cache.js'

export interface WalkCursor {
  cursor: Cursor
  /**
   * How many pages this walk has already served. Carried IN the cursor so the
   * ceiling survives a stateless server: nothing here remembers a walk between
   * requests, so a count the client hands back — signed, therefore
   * unforgeable — is the only place it can live.
   */
  pagesServed: number
}

/**
 * A signed keyset cursor, per project and per route.
 *
 * Extracted from the segment preview route so the funnel drop-off can page the
 * same way without a second implementation. It was already generic apart from
 * its label; only the label moves into a parameter.
 *
 * `label` makes each route's cursors cryptographically independent: a cursor
 * minted for one walk cannot be replayed against another, even within a
 * project. Changing an existing label invalidates every cursor already issued
 * under it, which is a compatibility break rather than a refactor.
 */
export function makeWalkCursorCodec(label: string) {
  /**
   * Derives a per-project HMAC key from `project.serverKeyHash` — already a
   * per-project, server-side, stable secret this process holds for every
   * authenticated request — via a labelled subkey rather than the raw hash,
   * so this specific use stays cryptographically independent of any other
   * future use of the same stored value. Needs no new configuration and
   * nothing is generated or stored beyond what auth already required.
   */
  function signingKey(project: Pick<Project, 'serverKeyHash'>): Buffer {
    return createHmac('sha256', project.serverKeyHash).update(label).digest()
  }

  function sign(payload: string, key: Buffer): string {
    return createHmac('sha256', key).update(payload).digest('base64url')
  }

  /**
   * Encodes a wire cursor. Only this function ever produces one — see
   * `decode` for why nothing else, including core's public `encodeCursor`,
   * is accepted back.
   */
  function encode(cursor: Cursor, pagesServed: number, key: Buffer): string {
    const payload = JSON.stringify([cursor.lastSeen, cursor.personId, cursor.asOf, pagesServed])
    const signature = sign(payload, key)
    return Buffer.from(
      JSON.stringify([cursor.lastSeen, cursor.personId, cursor.asOf, pagesServed, signature]),
    ).toString('base64url')
  }

  /**
   * Decodes and verifies a wire cursor. Anything that is not a validly signed
   * cursor issued by THIS route for THIS project is rejected outright —
   * including a well-formed, unsigned cursor built with core's public
   * `encodeCursor`. That function's existence and export do not obligate a
   * route to accept its output: a route mints its own cursors and a caller
   * gets no credit for reconstructing something that merely looks like one.
   *
   * Every failure — malformed base64/JSON, wrong shape, or a signature that
   * does not verify — collapses to `CursorError`, same as core's
   * `decodeCursor`: a caller cannot act differently on "not a cursor" than on
   * "forged cursor", and the distinction would only ever reach a log.
   */
  function decode(s: string, key: Buffer): WalkCursor {
    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
    } catch {
      throw new CursorError()
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 5 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      typeof parsed[2] !== 'string' ||
      typeof parsed[3] !== 'number' ||
      !Number.isInteger(parsed[3]) ||
      parsed[3] < 0 ||
      typeof parsed[4] !== 'string'
    ) {
      throw new CursorError()
    }
    const [lastSeen, personId, asOf, pagesServed, signature] = parsed
    const payload = JSON.stringify([lastSeen, personId, asOf, pagesServed])
    const expected = Buffer.from(sign(payload, key))
    const given = Buffer.from(signature)

    // timingSafeEqual throws on a length mismatch instead of returning false —
    // and a length mismatch already means "not a valid signature" — so it is
    // handled explicitly rather than letting a short/long forged signature
    // crash the request instead of 400ing it.
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new CursorError()
    }

    return { cursor: { lastSeen, personId, asOf }, pagesServed }
  }

  return { signingKey, encode, decode }
}
