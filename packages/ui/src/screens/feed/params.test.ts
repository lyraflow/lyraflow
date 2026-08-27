import { describe, expect, it } from 'vitest'
import {
  EVENT_PARAM,
  MAX_EVENT_LENGTH,
  RANGE_PARAM,
  readFeedParams,
  writeFeedParams,
} from './params.js'
import { DEFAULT_RANGE_ID, rangeById } from './range.js'

const q = (s: string) => new URLSearchParams(s)

describe('readFeedParams', () => {
  it('reads a range and an event from the query string', () => {
    const p = readFeedParams(q('range=7d&event=checkout'))
    expect(p.range.id).toBe('7d')
    expect(p.event).toBe('checkout')
  })

  it('falls back to the defaults when the query string is empty', () => {
    const p = readFeedParams(q(''))
    expect(p.range.id).toBe(DEFAULT_RANGE_ID)
    expect(p.event).toBe('')
  })

  it('opens the feed on an unknown range rather than breaking on it', () => {
    // A link outlives the option list it was made from, and a URL is the one
    // input path a person can hand-edit.
    expect(readFeedParams(q('range=42y')).range.id).toBe(DEFAULT_RANGE_ID)
  })

  it('clamps an event name to the ceiling both routes enforce', () => {
    // `/v1/events` and `/v1/events/stats` both cap this at 128. Unclamped, a
    // pasted URL would 400 every poll and surface as "could not load the
    // feed" with nothing pointing at the address bar.
    const long = 'x'.repeat(MAX_EVENT_LENGTH + 50)
    expect(readFeedParams(q(`event=${long}`)).event).toHaveLength(MAX_EVENT_LENGTH)
  })
})

describe('writeFeedParams', () => {
  it('writes a non-default range and event', () => {
    const out = writeFeedParams(q(''), { range: rangeById('30d'), event: 'signup' })
    expect(out.get(RANGE_PARAM)).toBe('30d')
    expect(out.get(EVENT_PARAM)).toBe('signup')
  })

  it('omits the default range and an empty filter entirely', () => {
    // A feed nobody has filtered stays at `/feed`, so a URL carrying
    // parameters always means somebody chose them.
    const out = writeFeedParams(q('range=7d&event=x'), {
      range: rangeById(DEFAULT_RANGE_ID),
      event: '',
    })
    expect(out.has(RANGE_PARAM)).toBe(false)
    expect(out.has(EVENT_PARAM)).toBe(false)
    expect(out.toString()).toBe('')
  })

  it('carries any other parameter through untouched', () => {
    // This screen does not own the whole query string. A future one that
    // adds its own must not have it silently deleted on the next keystroke.
    const out = writeFeedParams(q('tab=rejected&range=7d'), {
      range: rangeById('1h'),
      event: '',
    })
    expect(out.get('tab')).toBe('rejected')
  })

  it('clamps on the way out as well as on the way in', () => {
    const out = writeFeedParams(q(''), {
      range: rangeById(DEFAULT_RANGE_ID),
      event: 'y'.repeat(MAX_EVENT_LENGTH + 10),
    })
    expect(out.get(EVENT_PARAM)).toHaveLength(MAX_EVENT_LENGTH)
  })

  it('round-trips every range through the URL', () => {
    // The pairing that matters: what `write` produces, `read` must return.
    // A range whose id did not survive the trip would silently reset the
    // window on every refresh.
    for (const id of ['1h', '24h', '7d', '30d', '90d']) {
      const range = rangeById(id)
      const out = writeFeedParams(q(''), { range, event: 'e' })
      expect(readFeedParams(out).range.id).toBe(id)
      expect(readFeedParams(out).event).toBe('e')
    }
  })
})
