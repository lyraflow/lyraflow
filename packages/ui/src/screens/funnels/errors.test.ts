import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client.js'
import { describeError } from './errors.js'

describe('describeError', () => {
  it('maps 400 to a message naming the server-supplied code', () => {
    expect(describeError(new ApiError(400, 'bad_definition'))).toBe(
      'This funnel could not be read: bad_definition',
    )
  })

  // MINOR (whole-branch review): a validation 400 carries a per-path
  // `detail[]` naming exactly which field was wrong -- discarding it left an
  // operator reading "This funnel could not be read: invalid funnel" with no
  // way to tell which of the fields they just submitted was the problem.
  it('maps 400 with a detail[] to the per-path message, against the offending field', () => {
    expect(
      describeError(
        new ApiError(400, 'invalid funnel', [
          { path: 'window_seconds', message: 'Expected positive integer' },
        ]),
      ),
    ).toBe('This funnel could not be read: window_seconds -- Expected positive integer')
  })

  it('joins multiple detail[] entries rather than showing only the first', () => {
    expect(
      describeError(
        new ApiError(400, 'invalid funnel', [
          { path: 'steps', message: 'Required' },
          { path: 'window_seconds', message: 'Expected positive integer' },
        ]),
      ),
    ).toBe(
      'This funnel could not be read: steps -- Required; window_seconds -- Expected positive integer',
    )
  })

  it('falls back to the code when a 400 carries no detail[]', () => {
    expect(describeError(new ApiError(400, 'bad_definition', []))).toBe(
      'This funnel could not be read: bad_definition',
    )
  })

  it('maps 404 to "no longer exists"', () => {
    expect(describeError(new ApiError(404, 'not_found'))).toBe('This funnel no longer exists.')
  })

  it('maps 409 to a name-collision message', () => {
    expect(describeError(new ApiError(409, 'duplicate_name'))).toBe(
      'A funnel with that name already exists.',
    )
  })

  it('maps 422 to an actionable message telling the operator to narrow the range', () => {
    expect(describeError(new ApiError(422, 'segment query timed out'))).toBe(
      'That query took too long to finish. Narrow the range and run it again.',
    )
  })

  it('maps 503 to a temporary-outage message', () => {
    expect(describeError(new ApiError(503, 'unavailable'))).toBe(
      'Lyraflow is temporarily unavailable. Try again shortly.',
    )
  })

  it('maps an unrecognized ApiError status to the generic message', () => {
    expect(describeError(new ApiError(500, 'boom'))).toBe(
      'Something went wrong. Reload to try again.',
    )
  })

  it('maps a non-ApiError to the generic message', () => {
    expect(describeError(new Error('network down'))).toBe(
      'Something went wrong. Reload to try again.',
    )
  })

  it('has no case for a stale/deleted segment_id -- that is a 200 with a warning, not a thrown ApiError', () => {
    // Nothing to map: 401 is routed to onUnauthorized before this function is
    // ever called (see FunnelDetail), and there is no status code standing
    // in for "segment_id could not be read" -- Task 1's probe found that
    // case answers 200. This test exists so a future case added "just in
    // case" gets caught: any status this switch doesn't recognize -- 401
    // included -- must fall through to the generic message, not silently
    // grow a segment-shaped branch that duplicates the warnings signal.
    expect(describeError(new ApiError(401, 'unauthorized'))).toBe(
      'Something went wrong. Reload to try again.',
    )
  })
})
