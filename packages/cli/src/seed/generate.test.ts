import { describe, expect, it } from 'vitest'
import { UsageError } from '../api/args.js'
import {
  FUNNEL_EVENTS,
  type SeedOptions,
  allocate,
  eventNameOf,
  generateDemoData,
  summarise,
} from './generate.js'

const ANCHOR = new Date('2026-08-17T12:00:00.000Z')
const DAY = 86_400_000

function opts(over: Partial<SeedOptions> = {}): SeedOptions {
  return { seed: 7, persons: 120, events: 1_500, days: 90, anchor: ANCHOR, ...over }
}

/** Every event's name, exactly as `toEventRow` will derive it. */
function names(data: ReturnType<typeof generateDemoData>): string[] {
  return data.events.map((e) => eventNameOf(e.payload))
}

describe('generateDemoData determinism', () => {
  it('produces byte-identical data for the same seed and anchor', () => {
    const a = generateDemoData(opts({ seed: 4242 }))
    const b = generateDemoData(opts({ seed: 4242 }))
    expect(JSON.stringify(b)).toEqual(JSON.stringify(a))
  })

  /**
   * THE POINT OF `--seed`, and the test that fails if the seed is threaded
   * nowhere. Deliberately compares two DIFFERENT seeds: a determinism test
   * that runs the same seed twice passes just as happily against a generator
   * that ignores its seed entirely.
   *
   * Asserts the sizes are IDENTICAL alongside the content differing, so this
   * cannot be satisfied by a generator that merely produces a different
   * amount of data.
   */
  it('produces different data for a different seed, at the same size', () => {
    const a = generateDemoData(opts({ seed: 4242 }))
    const b = generateDemoData(opts({ seed: 4243 }))

    expect(b.events).toHaveLength(a.events.length)
    expect(b.persons).toHaveLength(a.persons.length)
    expect(JSON.stringify(b)).not.toEqual(JSON.stringify(a))

    // Named divergences rather than only the whole-object compare, so a
    // change that made ONLY the ids seed-dependent could not pass this.
    expect(b.events.map((e) => e.at.getTime())).not.toEqual(a.events.map((e) => e.at.getTime()))
    expect(b.persons.map((p) => p.funnelDepth)).not.toEqual(a.persons.map((p) => p.funnelDepth))
    expect(b.persons.map((p) => p.traits.plan)).not.toEqual(a.persons.map((p) => p.traits.plan))
  })

  it('scopes every id to the seed, so two seeds cannot share a person', () => {
    const a = generateDemoData(opts({ seed: 1 }))
    const b = generateDemoData(opts({ seed: 2 }))
    const aIds = new Set(a.persons.map((p) => p.anonymousId))
    for (const p of b.persons) expect(aIds.has(p.anonymousId)).toBe(false)

    const aMessages = new Set(a.events.map((e) => e.payload.message_id))
    for (const e of b.events) expect(aMessages.has(e.payload.message_id)).toBe(false)
  })

  it('mints a distinct, well-formed uuid for every event', () => {
    const data = generateDemoData(opts())
    const ids = data.events.map((e) => e.payload.message_id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-0000-4000-8000-[0-9a-f]{12}$/)
    }
  })
})

describe('generateDemoData counts', () => {
  it('creates exactly the requested number of events', () => {
    for (const events of [900, 1_500, 4_001]) {
      expect(generateDemoData(opts({ events })).events).toHaveLength(events)
    }
  })

  it('creates exactly the requested number of persons', () => {
    for (const persons of [1, 37, 250]) {
      const data = generateDemoData(opts({ persons, events: 4_000 }))
      expect(data.persons).toHaveLength(persons)
      // And every one of them actually shows up in the events.
      const devices = new Set(data.events.map((e) => e.payload.anonymous_id ?? ''))
      expect(devices.size).toBe(persons)
    }
  })

  it('refuses an events count too small to hold the funnel, without connecting to anything', () => {
    expect(() => generateDemoData(opts({ persons: 200, events: 10 }))).toThrow(UsageError)
    expect(() => generateDemoData(opts({ persons: 200, events: 10 }))).toThrow(/at least \d+/)
  })

  it('rejects a non-positive or fractional count', () => {
    expect(() => generateDemoData(opts({ persons: 0 }))).toThrow(UsageError)
    expect(() => generateDemoData(opts({ days: 0 }))).toThrow(UsageError)
    expect(() => generateDemoData(opts({ events: 0 }))).toThrow(UsageError)
    expect(() => generateDemoData(opts({ persons: 2.5 }))).toThrow(UsageError)
  })
})

describe('allocate', () => {
  it('sums to exactly the total, whatever the weights', () => {
    for (const total of [0, 1, 7, 1_000, 4_321]) {
      const weights = [1, 2, 3, 4, 5, 6, 7]
      const counts = allocate(weights, total)
      expect(counts.reduce((a, b) => a + b, 0)).toBe(total)
      for (const c of counts) expect(c).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('generateDemoData timeline', () => {
  it('spreads events across the whole requested window', () => {
    const data = generateDemoData(opts({ persons: 300, events: 5_000, days: 90 }))
    const summary = summarise(data)

    // The oldest event must genuinely be near the far end of the window --
    // 80% of it, conservatively, since the oldest person's first touch is a
    // draw. Without this the whole tool is pointless: history that all lands
    // in one day is what seeding through the ingest API already gives.
    expect(summary.earliest.getTime()).toBeLessThanOrEqual(ANCHOR.getTime() - 72 * DAY)
    // And the newest must be recent, so `last 7 days` is not empty.
    expect(summary.latest.getTime()).toBeGreaterThanOrEqual(ANCHOR.getTime() - 3 * DAY)
    // Never in the future: an event after the anchor would sit outside every
    // window the UI offers.
    expect(summary.latest.getTime()).toBeLessThanOrEqual(ANCHOR.getTime())
  })

  it('gives last 7 days, last 30 days and ever three different answers', () => {
    const summary = summarise(generateDemoData(opts({ persons: 300, events: 5_000, days: 90 })))
    expect(summary.windows.last7).toBeGreaterThan(0)
    expect(summary.windows.last30).toBeGreaterThan(summary.windows.last7)
    expect(summary.windows.ever).toBeGreaterThan(summary.windows.last30)
  })

  it('honours a shorter window', () => {
    const data = generateDemoData(opts({ days: 14 }))
    const summary = summarise(data)
    expect(summary.earliest.getTime()).toBeGreaterThanOrEqual(ANCHOR.getTime() - 14 * DAY)
    expect(summary.earliest.getTime()).toBeLessThanOrEqual(ANCHOR.getTime() - 11 * DAY)
  })

  it('emits events in ascending instant order', () => {
    const data = generateDemoData(opts())
    const times = data.events.map((e) => e.at.getTime())
    expect([...times].sort((a, b) => a - b)).toEqual(times)
  })
})

describe('generateDemoData funnel', () => {
  it('loses persons at every step', () => {
    const summary = summarise(generateDemoData(opts({ persons: 400, events: 6_000 })))
    expect(summary.funnel.map((s) => s.event)).toEqual([...FUNNEL_EVENTS])
    for (let i = 1; i < summary.funnel.length; i++) {
      const prev = summary.funnel[i - 1]?.persons ?? 0
      const here = summary.funnel[i]?.persons ?? 0
      expect(here).toBeLessThan(prev)
      // A step that keeps nobody is as uninformative as one that keeps
      // everybody.
      expect(here).toBeGreaterThan(0)
    }
    expect(summary.funnel[0]?.persons).toBe(400)
  })

  it('walks the funnel steps in order, in time, per person', () => {
    const data = generateDemoData(opts({ persons: 60, events: 700 }))
    for (const person of data.persons) {
      const walk = data.events.filter(
        (e) =>
          e.payload.anonymous_id === person.anonymousId &&
          (FUNNEL_EVENTS as readonly string[]).includes(eventNameOf(e.payload)),
      )

      // Take the person's FIRST occurrence of each funnel step; filler
      // `page_view`s repeat step 0 later, which is expected.
      const firstAt = new Map<string, number>()
      for (const e of walk) {
        const name = eventNameOf(e.payload)
        if (!firstAt.has(name)) firstAt.set(name, e.at.getTime())
      }
      let previous = Number.NEGATIVE_INFINITY
      for (let step = 0; step < person.funnelDepth; step++) {
        const name = FUNNEL_EVENTS[step] as string
        const at = firstAt.get(name)
        expect(at, `${person.anonymousId} is missing ${name}`).toBeDefined()
        expect(at as number).toBeGreaterThan(previous)
        previous = at as number
      }
      // Nothing beyond the person's depth exists at all.
      for (let step = person.funnelDepth; step < FUNNEL_EVENTS.length; step++) {
        expect(firstAt.has(FUNNEL_EVENTS[step] as string)).toBe(false)
      }
    }
  })
})

describe('generateDemoData identity', () => {
  it('binds every identified person, and only those, at the identify instant', () => {
    const data = generateDemoData(opts({ persons: 150, events: 2_000 }))
    const identified = data.persons.filter((p) => p.identified)

    expect(identified.length).toBeGreaterThan(0)
    expect(identified.length).toBeLessThan(data.persons.length)
    expect(data.bindings).toHaveLength(identified.length)

    const byDevice = new Map(data.bindings.map((b) => [b.anonymousId, b]))
    for (const person of identified) {
      const binding = byDevice.get(person.anonymousId)
      expect(binding, `${person.anonymousId} has no binding`).toBeDefined()
      expect(binding?.personId).toBe(person.personId)
      expect(binding?.boundAt.getTime()).toBe(person.identifyAt?.getTime())
    }
    for (const person of data.persons.filter((p) => !p.identified)) {
      expect(byDevice.has(person.anonymousId)).toBe(false)
      expect(person.personId).toBe('')
    }
  })

  /**
   * The reason identity resolution is exercised rather than merely mentioned.
   * If every event carried its `user_id` from the start there would be
   * nothing for the binding to attach retroactively, and the funnel's first
   * step would resolve to the same person as its last by luck rather than by
   * the dictionary doing its job.
   */
  it('leaves every pre-identify event anonymous, and identifies the rest', () => {
    const data = generateDemoData(opts({ persons: 150, events: 2_000 }))
    let anonymousBeforeIdentify = 0

    for (const person of data.persons.filter((p) => p.identified)) {
      const identifyMs = person.identifyAt?.getTime() as number
      const own = data.events.filter((e) => e.payload.anonymous_id === person.anonymousId)
      for (const e of own) {
        const userId = e.payload.user_id ?? ''
        if (e.at.getTime() < identifyMs) {
          expect(userId, `${person.anonymousId} leaked a user_id before identifying`).toBe('')
          anonymousBeforeIdentify++
        } else {
          expect(userId).toBe(person.personId)
        }
      }
    }
    expect(anonymousBeforeIdentify).toBeGreaterThan(0)
  })

  it('never puts a user_id on a person who stayed anonymous', () => {
    const data = generateDemoData(opts({ persons: 150, events: 2_000 }))
    const anonymousOnly = data.persons.filter((p) => !p.identified)
    // Non-emptiness first, or this whole test is vacuously true against a
    // population with nobody in it -- which is exactly what it did against a
    // stubbed generator during the stub check.
    expect(anonymousOnly.length).toBeGreaterThan(0)
    for (const person of anonymousOnly) {
      const own = data.events.filter((e) => e.payload.anonymous_id === person.anonymousId)
      expect(own.length).toBeGreaterThan(0)
      for (const e of own) expect(e.payload.user_id ?? '').toBe('')
    }
  })
})

describe('generateDemoData traits and properties', () => {
  it('gives every identified person the documented trait set, string and numeric', () => {
    const data = generateDemoData(opts({ persons: 150, events: 2_000 }))
    const plans = new Set<unknown>()
    const countries = new Set<unknown>()

    for (const person of data.persons.filter((p) => p.identified)) {
      expect(Object.keys(person.traits).sort()).toEqual([
        'country',
        'display_name',
        'is_trial',
        'mrr_usd',
        'plan',
        'seats',
        'signup_source',
      ])
      expect(typeof person.traits.plan).toBe('string')
      expect(typeof person.traits.country).toBe('string')
      expect(typeof person.traits.signup_source).toBe('string')
      expect(typeof person.traits.is_trial).toBe('boolean')
      expect(typeof person.traits.seats).toBe('number')
      expect(typeof person.traits.mrr_usd).toBe('number')
      plans.add(person.traits.plan)
      countries.add(person.traits.country)
    }

    // Low cardinality, but more than one value -- a trait predicate needs
    // something to include AND something to exclude.
    expect([...plans].sort()).toEqual(['enterprise', 'free', 'pro'])
    expect(countries.size).toBeGreaterThan(3)
  })

  it('carries the traits on the $identify event itself', () => {
    const data = generateDemoData(opts({ persons: 60, events: 800 }))
    const identifies = data.events.filter((e) => e.payload.type === 'identify')
    expect(identifies).toHaveLength(data.bindings.length)
    for (const e of identifies) {
      if (e.payload.type !== 'identify') throw new Error('unreachable')
      expect(e.payload.user_id).not.toBe('')
      expect(typeof e.payload.traits.seats).toBe('number')
      expect(typeof e.payload.traits.plan).toBe('string')
    }
  })

  it('puts a numeric amount on every purchase', () => {
    const data = generateDemoData(opts({ persons: 200, events: 3_000 }))
    const purchases = data.events.filter((e) => eventNameOf(e.payload) === 'purchase')
    expect(purchases.length).toBeGreaterThan(0)
    for (const e of purchases) {
      if (e.payload.type !== 'track') throw new Error('unreachable')
      expect(typeof e.payload.properties.amount).toBe('number')
      expect(e.payload.properties.currency).toBe('USD')
      expect(typeof e.payload.properties.items).toBe('number')
    }
  })

  it('produces more than just the funnel, so the feed has variety', () => {
    const distinct = new Set(names(generateDemoData(opts({ persons: 200, events: 3_000 }))))
    expect(distinct).toContain('$identify')
    for (const name of FUNNEL_EVENTS) expect(distinct).toContain(name)
    for (const name of ['feature_used', 'docs_search', 'invite_sent']) {
      expect(distinct).toContain(name)
    }
  })
})

describe('generateDemoData context', () => {
  it('attaches the acquisition campaign to the first event only', () => {
    const data = generateDemoData(opts({ persons: 120, events: 1_600 }))
    let withCampaign = 0

    for (const person of data.persons) {
      const own = data.events.filter((e) => e.payload.anonymous_id === person.anonymousId)
      const [first, ...rest] = own
      expect(first).toBeDefined()
      // `utm_source` is PRESENT on the first event (possibly empty, which is
      // direct traffic) and ABSENT on every later one -- device_index reads it
      // with argMin, so a later copy would be dead weight that also made
      // "first touch" a property of the query instead of the data.
      expect(first?.payload.context).toHaveProperty('utm_source')
      if ((first?.payload.context.utm_source ?? '') !== '') withCampaign++
      for (const e of rest) {
        expect(e.payload.context.utm_source).toBeUndefined()
        expect(e.payload.context.utm_campaign).toBeUndefined()
      }
    }
    // Some persons must actually carry a campaign, or a context predicate on
    // utm_source has nothing to match.
    expect(withCampaign).toBeGreaterThan(10)
    expect(withCampaign).toBeLessThan(data.persons.length)
  })

  it('gives some persons a later location than their first, so the two scopes differ', () => {
    const data = generateDemoData(opts({ persons: 200, events: 3_000 }))
    let moved = 0
    for (const person of data.persons) {
      const own = data.events.filter((e) => e.payload.anonymous_id === person.anonymousId)
      const first = own[0]?.geo.country
      if (own.some((e) => e.geo.country !== first)) moved++
    }
    expect(moved).toBeGreaterThan(0)
    expect(moved).toBeLessThan(data.persons.length)
  })

  it('spreads devices, operating systems and browsers, derived by the real parser', () => {
    const data = generateDemoData(opts({ persons: 200, events: 3_000 }))
    const devices = new Set(data.events.map((e) => e.ua.device_type))
    const oses = new Set(data.events.map((e) => e.ua.os))
    // Lowercased, because `parseUserAgent` lowercases -- proof these came
    // through it rather than from a hand-written triple.
    expect([...devices].sort()).toEqual(['desktop', 'mobile', 'tablet'])
    expect(oses.size).toBeGreaterThanOrEqual(4)
    for (const os of oses) expect(os).toBe(os.toLowerCase())
  })
})

describe('generateDemoData is obviously synthetic', () => {
  it('never emits an email address or a resolvable hostname', () => {
    const data = generateDemoData(opts({ persons: 120, events: 1_600 }))
    const text = JSON.stringify(data)
    expect(text).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
    for (const url of data.events.map((e) => e.payload.context.url ?? '')) {
      if (url === '') continue
      expect(new URL(url).hostname.endsWith('.invalid')).toBe(true)
    }
  })

  it('prefixes every identifier with demo-', () => {
    const data = generateDemoData(opts({ persons: 40, events: 500 }))
    for (const person of data.persons) {
      expect(person.anonymousId.startsWith('demo-device-')).toBe(true)
      if (person.identified) expect(person.personId.startsWith('demo-person-')).toBe(true)
      expect(String(person.traits.display_name).startsWith('Demo Person ')).toBe(true)
    }
  })
})

describe('summarise', () => {
  it('counts what was actually generated, not what the rates predict', () => {
    const data = generateDemoData(opts({ persons: 90, events: 1_100 }))
    const summary = summarise(data)
    expect(summary.events).toBe(1_100)
    expect(summary.persons).toBe(90)
    expect(summary.identifiedPersons + summary.anonymousPersons).toBe(90)
    expect(summary.bindings).toBe(summary.identifiedPersons)
    expect(summary.byEvent.reduce((a, b) => a + b.count, 0)).toBe(1_100)
    expect(summary.byEvent.map((e) => e.event)).toEqual(
      [...summary.byEvent.map((e) => e.event)].sort(),
    )
  })
})
