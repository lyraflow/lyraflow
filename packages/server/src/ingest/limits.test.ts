import type { IngestPayload } from '@lyraflow/core'
import { describe, expect, it } from 'vitest'
import {
  CardinalityTracker,
  MAX_EVENT_NAMES_PER_PROJECT,
  MAX_PROPERTIES_PER_EVENT,
  MAX_PROPERTY_KEYS_PER_EVENT_NAME,
  checkLimits,
} from './limits.js'

function track(event: string, properties: Record<string, string> = {}): IngestPayload {
  return {
    type: 'track',
    message_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90',
    anonymous_id: 'a-1',
    event,
    properties,
    context: {},
  } as IngestPayload
}

describe('checkLimits', () => {
  it('accepts an ordinary event', () => {
    expect(checkLimits(track('signup', { plan: 'trial' }), new CardinalityTracker()).ok).toBe(true)
  })

  it('rejects an event carrying too many properties', () => {
    const properties = Object.fromEntries(
      Array.from({ length: MAX_PROPERTIES_PER_EVENT + 1 }, (_, i) => [`k${i}`, 'v']),
    )
    const r = checkLimits(track('signup', properties), new CardinalityTracker())
    expect(r).toMatchObject({ ok: false, reason: 'too_many_properties' })
  })

  it('rejects a new event name once the project cardinality cap is reached', () => {
    const tracker = new CardinalityTracker()
    for (let i = 0; i < MAX_EVENT_NAMES_PER_PROJECT; i++) tracker.observe(1, `evt_${i}`, [])
    const r = checkLimits(track('one_too_many'), tracker, 1)
    expect(r).toMatchObject({ ok: false, reason: 'event_name_cardinality' })
  })

  it('still accepts an already-known event name at the cap', () => {
    const tracker = new CardinalityTracker()
    for (let i = 0; i < MAX_EVENT_NAMES_PER_PROJECT; i++) tracker.observe(1, `evt_${i}`, [])
    expect(checkLimits(track('evt_0'), tracker, 1).ok).toBe(true)
  })

  it('rejects a new property key once the per-event-name cap is reached', () => {
    const tracker = new CardinalityTracker()
    const keys = Array.from({ length: MAX_PROPERTY_KEYS_PER_EVENT_NAME }, (_, i) => `k${i}`)
    tracker.observe(1, 'signup', keys)
    const r = checkLimits(track('signup', { brand_new_key: 'v' }), tracker, 1)
    expect(r).toMatchObject({ ok: false, reason: 'property_key_cardinality' })
  })

  it('still accepts an event whose property keys are all already known, at the cap', () => {
    const tracker = new CardinalityTracker()
    const keys = Array.from({ length: MAX_PROPERTY_KEYS_PER_EVENT_NAME }, (_, i) => `k${i}`)
    tracker.observe(1, 'signup', keys)
    expect(checkLimits(track('signup', { k0: 'v', k1: 'v' }), tracker, 1).ok).toBe(true)
  })

  it('rejects an event whose novel keys alone would push the per-event-name count past the cap, even though the pre-existing count is below it', () => {
    const tracker = new CardinalityTracker()
    // Chosen so existing + MAX_PROPERTIES_PER_EVENT lands exactly one over
    // the cap: a single event can carry up to MAX_PROPERTIES_PER_EVENT brand
    // new keys, which must be caught even though the pre-existing count
    // (251) is nowhere near MAX_PROPERTY_KEYS_PER_EVENT_NAME (500) on its own.
    const existingKeyCount = MAX_PROPERTY_KEYS_PER_EVENT_NAME - MAX_PROPERTIES_PER_EVENT + 1
    const keys = Array.from({ length: existingKeyCount }, (_, i) => `k${i}`)
    tracker.observe(1, 'signup', keys)
    const properties = Object.fromEntries(
      Array.from({ length: MAX_PROPERTIES_PER_EVENT }, (_, i) => [`new_${i}`, 'v']),
    )
    const r = checkLimits(track('signup', properties), tracker, 1)
    expect(r).toMatchObject({ ok: false, reason: 'property_key_cardinality' })
  })
})
