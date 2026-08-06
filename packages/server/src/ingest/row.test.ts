import { describe, expect, it } from 'vitest'
import { toEventRow } from './row.js'

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
