import { type IngestPayload, eventNameFor, propertyBagFor } from '@lyraflow/core'
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

describe('page views cost one event-name slot, not one per page (#53)', () => {
  const page = (name?: string): IngestPayload =>
    ({
      type: 'page',
      message_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a92',
      anonymous_id: 'a-1',
      ...(name === undefined ? {} : { name }),
      properties: {},
      context: {},
    }) as IngestPayload

  /**
   * The route's own two steps, in order: `checkLimits` decides, then
   * `cardinality.observe` records -- and `routes.ts` records `row.event_name`,
   * the value `toEventRow` produced, not the payload's. Reproducing both here
   * is what makes this a test of the PIPELINE rather than of one function's
   * return value.
   */
  const ingest = (tracker: CardinalityTracker, payload: IngestPayload) => {
    const result = checkLimits(payload, tracker)
    if (result.ok) {
      tracker.observe(0, eventNameFor(payload), Object.keys(propertyBagFor(payload)))
    }
    return result
  }

  it("spends ONE of the project's event names across many distinct pages", () => {
    // The storage form of the same defect. Page names are unbounded by
    // construction -- one per URL -- so every page view used to consume a slot
    // from a budget of 1000, and its own per-event-name property-key budget
    // with it. A busy marketing site would exhaust the project.
    const tracker = new CardinalityTracker()
    for (let i = 0; i < 200; i++) {
      expect(ingest(tracker, page(`page-${i}`)).ok).toBe(true)
    }
    expect(tracker.eventNameCount(0)).toBe(1)
  })

  it('accounts a page view under the name the ROW will carry', () => {
    // The two used to be separate copies of the same three-line function, each
    // commented "these must move together". They did not have to move
    // together; they merely both happened to be right. Now `checkLimits` and
    // `toEventRow` call one exported function, so cardinality accounting and
    // storage cannot disagree about what an event is called.
    const tracker = new CardinalityTracker()
    ingest(tracker, page('Pricing'))
    expect(tracker.knowsEventName(0, '$page')).toBe(true)
    expect(tracker.knowsEventName(0, 'Pricing')).toBe(false)
  })

  it('does not refuse a NEW page name once the project is at its event-name cap', () => {
    // The guard that catches a divergent copy of the name rule, which the two
    // tests above do NOT: they observe through `eventNameFor`, so the tracker
    // records `$page` whatever `checkLimits` computed internally.
    //
    // This one reaches the branch where the name actually decides something.
    // At the cap, an event is refused when its name is one the project has not
    // used before -- so a `checkLimits` that still derived `Pricing` from a
    // page payload would refuse it, while the row it accompanies would have
    // been stored under `$page`, a name the project already has. Cardinality
    // accounting and storage disagreeing about what an event is called is
    // exactly what one shared function exists to prevent.
    const tracker = new CardinalityTracker()
    tracker.observe(0, '$page', [])
    for (let i = 0; i < MAX_EVENT_NAMES_PER_PROJECT - 1; i++) tracker.observe(0, `e${i}`, [])
    expect(tracker.eventNameCount(0)).toBe(MAX_EVENT_NAMES_PER_PROJECT)

    // A brand-new page name, at the cap. Accepted, because the name that
    // reaches storage is `$page` and the project already uses it.
    expect(checkLimits(page('A Page Never Seen Before'), tracker).ok).toBe(true)
    // ...while a genuinely new TRACK name is still refused, so the cap works.
    expect(checkLimits(track('never_seen_before'), tracker).ok).toBe(false)
  })

  it("does not spend the caller's property budget on $page_name", () => {
    // `MAX_PROPERTIES_PER_EVENT` is the CALLER'S budget. A page() carrying
    // exactly the maximum must not be throttled because the product added a
    // property of its own -- so the limit is checked on the caller's bag and
    // `$page_name` is written after routing.
    const properties: Record<string, string> = {}
    for (let i = 0; i < MAX_PROPERTIES_PER_EVENT; i++) properties[`k${i}`] = 'v'
    const payload = { ...page('Pricing'), properties } as IngestPayload
    expect(checkLimits(payload, new CardinalityTracker()).ok).toBe(true)
  })
})
