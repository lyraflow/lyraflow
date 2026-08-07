import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chDateTime, parseChDateTime, toEventRow } from './row.js'

const now = new Date('2026-08-06T12:00:00.000Z')

const base = {
  projectId: 7,
  now,
  trusted: false,
  geo: { country: 'DE', region: 'BE', city: 'Berlin' },
  ua: { device_type: 'desktop', os: 'macos', browser: 'chrome' },
}

describe('toEventRow', () => {
  it('maps a track payload into the ClickHouse row shape', () => {
    const row = toEventRow({
      ...base,
      payload: {
        type: 'track',
        message_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90',
        anonymous_id: 'a-1',
        event: 'import_started',
        properties: { source: 'csv', rows: 4021, ok: true },
        context: { url: 'https://x.test/import', utm_source: 'google' },
      },
    })

    expect(row).toMatchObject({
      project_id: 7,
      event_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90',
      anonymous_id: 'a-1',
      user_id: '',
      event_name: 'import_started',
      trusted: 0,
      properties: { source: 'csv', ok: 'true' },
      properties_num: { rows: 4021 },
      url: 'https://x.test/import',
      utm_source: 'google',
      country: 'DE',
      device_type: 'desktop',
    })
  })

  it('names an identify payload $identify so the people universe stays derivable from events', () => {
    const row = toEventRow({
      ...base,
      payload: {
        type: 'identify',
        message_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90',
        anonymous_id: 'a-1',
        user_id: 'u-1',
        traits: { plan: 'trial' },
        context: {},
      },
    })
    expect(row.event_name).toBe('$identify')
    expect(row.user_id).toBe('u-1')
    expect(row.properties).toEqual({ plan: 'trial' })
  })

  it('clamps a client timestamp from a badly skewed clock', () => {
    const row = toEventRow({
      ...base,
      payload: {
        type: 'track',
        message_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90',
        anonymous_id: 'a-1',
        event: 'x',
        properties: {},
        timestamp: '2030-01-01T00:00:00.000Z',
        context: {},
      },
    })
    expect(row.timestamp).toBe('2026-08-07 12:00:00.000')
  })

  it('marks server-side events as trusted', () => {
    const row = toEventRow({
      ...base,
      trusted: true,
      payload: {
        type: 'track',
        message_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90',
        user_id: 'u-1',
        event: 'invoice_paid',
        properties: {},
        context: {},
      },
    })
    expect(row.trusted).toBe(1)
    expect(row.anonymous_id).toBe('')
  })
})

describe('parseChDateTime', () => {
  const originalTz = process.env.TZ

  // Forced to a non-UTC, non-zero offset for every test in this block. A
  // string with no timezone designator (what chDateTime produces) is parsed
  // by JS's Date as *local* time when the designator is absent — so on a
  // host whose local zone already happens to be UTC (the common case for CI
  // runners), an implementation that forgot to re-append 'Z' would produce
  // an identical result to a correct one, and no assertion here could ever
  // tell the two apart. Forcing a real offset makes that class of bug
  // observable regardless of which machine or CI runner executes this file.
  beforeEach(() => {
    process.env.TZ = 'America/New_York'
  })
  afterEach(() => {
    process.env.TZ = originalTz
  })

  // Would catch: parseChDateTime built without re-appending 'Z' (or with a
  // fixed offset instead of 'Z'), which would parse the string as local
  // time in whatever zone the process happens to be running in — America/
  // New_York is UTC-4 in March (EDT), so that mutation is off by exactly
  // 4 hours here, nowhere close to a rounding or flakiness margin. Uses a
  // literal instant, not one derived from Date.now(), so the assertion is
  // reproducible independent of when the suite runs.
  it('is UTC-anchored regardless of the host default timezone', () => {
    const expectedMs = Date.UTC(2026, 2, 15, 9, 42, 17, 321) // 2026-03-15T09:42:17.321Z
    expect(parseChDateTime('2026-03-15 09:42:17.321').getTime()).toBe(expectedMs)
  })

  // Would catch: chDateTime and parseChDateTime drifting out of sync on the
  // separator/format between them (e.g. one using 'T' and the other still
  // expecting a space) — a regression neither function's own isolated
  // correctness would surface.
  it('round-trips an arbitrary instant through chDateTime and back exactly', () => {
    const original = new Date('2026-03-15T09:42:17.321Z')
    expect(parseChDateTime(chDateTime(original)).getTime()).toBe(original.getTime())
  })
})
