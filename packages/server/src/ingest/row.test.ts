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

describe('page views are one event name with the name as a property (#53)', () => {
  const page = (extra: Record<string, unknown> = {}) =>
    toEventRow({
      ...base,
      payload: {
        type: 'page',
        message_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a91',
        anonymous_id: 'a-1',
        properties: {},
        context: {},
        ...extra,
      } as never,
    })

  it('names a NAMED page view $page, not the page name', () => {
    const row = page({ name: 'Pricing' })
    // The defect: `event_name: 'Pricing'` made the page view its own event
    // type, indistinguishable from `track('Pricing')` once stored, and put an
    // unbounded set of names into a LowCardinality column.
    expect(row.event_name).toBe('$page')
    expect(row.properties.$page_name).toBe('Pricing')
  })

  it('adds no $page_name at all when the page view has no name', () => {
    const row = page()
    expect(row.event_name).toBe('$page')
    expect('$page_name' in row.properties).toBe(false)
  })

  it('a caller cannot displace the real page name with their own string', () => {
    const row = page({ name: 'Pricing', properties: { $page_name: 'forged' } })
    expect(row.properties.$page_name).toBe('Pricing')
  })

  it('...nor smuggle it into the other map as a number', () => {
    // The half that matters. `routeProperties` sends numbers to
    // `properties_num`, so a guard on the string map alone would let this
    // land in a different column entirely -- present, unfindable, and
    // contradicting the real one.
    const row = page({ name: 'Pricing', properties: { $page_name: 42 } })
    expect(row.properties.$page_name).toBe('Pricing')
    expect('$page_name' in row.properties_num).toBe(false)
  })

  it("keeps the caller's own ordinary properties", () => {
    const row = page({ name: 'Pricing', properties: { variant: 'b', seats: 3 } })
    expect(row.properties).toEqual({ $page_name: 'Pricing', variant: 'b' })
    expect(row.properties_num).toEqual({ seats: 3 })
  })
})
