import { MAX_CLOCK_SKEW_MS } from '@lyraflow/core'
import { toEventRow } from '@lyraflow/core'
import { describe, expect, it } from 'vitest'
import { type DemoEvent, generateDemoData } from './generate.js'
import { toDemoRow } from './rows.js'

const ANCHOR = new Date('2026-08-17T12:00:00.000Z')
const DAY = 86_400_000
const PROJECT = 42

function ninetyDaysAgo(): DemoEvent {
  return {
    at: new Date(ANCHOR.getTime() - 90 * DAY),
    payload: {
      type: 'track',
      event: 'purchase',
      message_id: '00000000-0000-4000-8000-000000000001',
      anonymous_id: 'demo-device-00000001-0001',
      user_id: 'demo-person-00000001-0001',
      properties: { plan: 'pro', amount: 129.5, currency: 'USD', items: 2, refunded: false },
      context: { url: 'https://app.lyraflow-demo.invalid/pricing', path: '/pricing' },
    },
    geo: { country: 'GB', region: 'ENG', city: 'Demo Bridge' },
    ua: { device_type: 'desktop', os: 'macos', browser: 'chrome' },
  }
}

describe('toDemoRow and the ingest clamp', () => {
  /**
   * THE FINDING THIS WHOLE COMMAND IS SHAPED AROUND, pinned from both sides.
   *
   * `toEventRow` clamps every payload timestamp to within MAX_CLOCK_SKEW_MS
   * of the `now` it is given. Handed the wall clock — which is what the ingest
   * route hands it, correctly — a ninety-day-old event lands twenty-four hours
   * ago, and ninety days of backdated events would pile up inside a single day.
   * Handed the event's OWN instant, the clamp has nothing to correct.
   *
   * Remove `now: ev.at` from `toDemoRow` and this test is the one that fails.
   */
  it('keeps a ninety-day-old instant, where the wall clock would have clamped it', () => {
    const ev = ninetyDaysAgo()

    const clamped = toEventRow({
      projectId: PROJECT,
      payload: { ...ev.payload, timestamp: ev.at.toISOString() },
      now: ANCHOR,
      trusted: false,
      geo: ev.geo,
      ua: ev.ua,
    })
    expect(clamped.timestamp).toBe('2026-08-16 12:00:00.000')
    expect(ANCHOR.getTime() - new Date(`${clamped.timestamp}Z`).getTime()).toBe(MAX_CLOCK_SKEW_MS)

    const kept = toDemoRow(ev, PROJECT)
    expect(kept.timestamp).toBe('2026-05-19 12:00:00.000')
    expect(ANCHOR.getTime() - new Date(`${kept.timestamp}Z`).getTime()).toBe(90 * DAY)
  })

  it('records the event as received when it happened, and as server-authored', () => {
    const row = toDemoRow(ninetyDaysAgo(), PROJECT)
    expect(row.received_at).toBe(row.timestamp)
    expect(row.trusted).toBe(1)
    expect(row.project_id).toBe(PROJECT)
  })

  it('derives the row through toEventRow rather than a second row builder', () => {
    const ev = ninetyDaysAgo()
    expect(toDemoRow(ev, PROJECT)).toEqual(
      toEventRow({
        projectId: PROJECT,
        payload: { ...ev.payload, timestamp: ev.at.toISOString() },
        now: ev.at,
        trusted: true,
        geo: ev.geo,
        ua: ev.ua,
      }),
    )
  })
})

describe('toDemoRow property routing', () => {
  /**
   * Numeric and string properties go to two different ClickHouse Map columns
   * (`routeProperties`), and a predicate reads only one of them. Data that
   * exercised one column would leave half the predicate surface with nothing
   * to match.
   */
  it('routes numbers to properties_num and everything else to properties', () => {
    const row = toDemoRow(ninetyDaysAgo(), PROJECT)
    expect(row.properties_num).toEqual({ amount: 129.5, items: 2 })
    expect(row.properties).toEqual({ plan: 'pro', currency: 'USD', refunded: 'false' })
  })

  it('routes numeric traits the same way, on the $identify row', () => {
    const data = generateDemoData({
      seed: 3,
      persons: 40,
      events: 500,
      days: 30,
      anchor: ANCHOR,
    })
    const identify = data.events.find((e) => e.payload.type === 'identify')
    expect(identify).toBeDefined()

    const row = toDemoRow(identify as DemoEvent, PROJECT)
    expect(row.event_name).toBe('$identify')
    expect(Object.keys(row.properties_num).sort()).toEqual(['mrr_usd', 'seats'])
    expect(Object.keys(row.properties).sort()).toEqual([
      'country',
      'display_name',
      'is_trial',
      'plan',
      'signup_source',
    ])
    expect(typeof row.properties_num.seats).toBe('number')
    expect(['true', 'false']).toContain(row.properties.is_trial)
  })

  it('carries the context columns a segment builder filters on', () => {
    const data = generateDemoData({ seed: 5, persons: 30, events: 400, days: 30, anchor: ANCHOR })
    const rows = data.events.map((e) => toDemoRow(e, PROJECT))

    const withSource = rows.filter((r) => r.utm_source !== '')
    expect(withSource.length).toBeGreaterThan(0)
    expect(new Set(rows.map((r) => r.country)).size).toBeGreaterThan(3)
    expect(new Set(rows.map((r) => r.device_type))).toContain('mobile')
    // Every event except `$identify` names a page. identify carries no context
    // at all, exactly as the SDK's own identify() call does.
    const pageful = rows.filter((r) => r.event_name !== '$identify')
    expect(pageful.length).toBeGreaterThan(0)
    expect(pageful.every((r) => r.path.startsWith('/'))).toBe(true)
    expect(rows.filter((r) => r.event_name === '$identify').every((r) => r.path === '')).toBe(true)
  })

  it('gives every row the event name the schema catalogue will show', () => {
    const data = generateDemoData({ seed: 9, persons: 60, events: 900, days: 60, anchor: ANCHOR })
    const names = new Set(data.events.map((e) => toDemoRow(e, PROJECT).event_name))
    // `$page`, not 'page_view': every page view is stored under one name now,
    // with the page's own name as the `$page_name` property (#53).
    expect(names).toContain('$page')
    expect(names).toContain('purchase')
    expect(names).toContain('$identify')
    // The seeder's page payloads carry a page NAME, and none of those names
    // may become an event name any more -- that was the defect (#53). Checking
    // the whole PAGES list rather than one example, because a single missed
    // call site would still pass a spot check.
    for (const slug of [
      'home',
      'pricing',
      'docs',
      'docs-segments',
      'changelog',
      'signup',
      'dashboard',
    ])
      expect(names, `${slug} leaked into event_name`).not.toContain(slug)
  })
})
