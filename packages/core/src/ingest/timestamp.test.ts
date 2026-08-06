import { describe, expect, it } from 'vitest'
import { clampTimestamp } from './timestamp.js'

const now = new Date('2026-08-06T12:00:00.000Z')

describe('clampTimestamp', () => {
  it('falls back to server time when the client sends nothing', () => {
    expect(clampTimestamp(undefined, now)).toEqual(now)
  })

  it('accepts a client timestamp inside the skew window', () => {
    const ts = '2026-08-06T09:00:00.000Z'
    expect(clampTimestamp(ts, now)).toEqual(new Date(ts))
  })

  it('clamps a client clock running far ahead', () => {
    expect(clampTimestamp('2027-01-01T00:00:00.000Z', now)).toEqual(
      new Date('2026-08-07T12:00:00.000Z'),
    )
  })

  it('clamps a client clock running far behind', () => {
    expect(clampTimestamp('2020-01-01T00:00:00.000Z', now)).toEqual(
      new Date('2026-08-05T12:00:00.000Z'),
    )
  })

  it('falls back to server time when the client sends garbage', () => {
    expect(clampTimestamp('not-a-date', now)).toEqual(now)
  })
})
