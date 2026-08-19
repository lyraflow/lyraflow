import { describe, expect, it } from 'vitest'
import { IngestPayload } from './payloads.js'
import { MAX_ID_LENGTH } from './properties.js'

const base = { message_id: '0b2f6a1e-9c4d-4a1f-8f3b-2f1c7d5e6a90', anonymous_id: 'anon-1' }

describe('IngestPayload', () => {
  it('accepts a minimal track payload', () => {
    const r = IngestPayload.safeParse({ ...base, type: 'track', event: 'signup' })
    expect(r.success).toBe(true)
  })

  it('defaults properties to an empty object', () => {
    const r = IngestPayload.parse({ ...base, type: 'track', event: 'signup' })
    expect(r.type === 'track' && r.properties).toEqual({})
  })

  it('rejects a payload with neither anonymous_id nor user_id', () => {
    const r = IngestPayload.safeParse({
      message_id: base.message_id,
      type: 'track',
      event: 'signup',
    })
    expect(r.success).toBe(false)
  })

  it('accepts a user_id-only payload, which is how server-side tracking works', () => {
    const r = IngestPayload.safeParse({
      message_id: base.message_id,
      type: 'track',
      event: 'invoice_paid',
      user_id: 'u-1',
    })
    expect(r.success).toBe(true)
  })

  it('rejects a non-uuid message_id', () => {
    const r = IngestPayload.safeParse({ ...base, message_id: 'nope', type: 'track', event: 'x' })
    expect(r.success).toBe(false)
  })

  it('rejects an event name longer than 128 characters', () => {
    const r = IngestPayload.safeParse({ ...base, type: 'track', event: 'e'.repeat(129) })
    expect(r.success).toBe(false)
  })

  it('accepts an identify payload with traits', () => {
    const r = IngestPayload.safeParse({
      ...base,
      type: 'identify',
      user_id: 'u-1',
      traits: { plan: 'trial' },
    })
    expect(r.success).toBe(true)
  })

  it('rejects an identify payload without a user_id', () => {
    const r = IngestPayload.safeParse({ ...base, type: 'identify', traits: {} })
    expect(r.success).toBe(false)
  })

  // PagePayload reached IngestPayload only through the `._def.schema` unwrap,
  // which strips its `.refine()` — so nothing proved the page branch parsed at
  // all, nor that superRefine re-applied the identifier guard to it.

  it('accepts a page payload and defaults its name away rather than inventing one', () => {
    const r = IngestPayload.safeParse({ ...base, type: 'page', context: { path: '/pricing' } })
    expect(r.success).toBe(true)
    // `name` stays optional here; the '$page' fallback is the row builder's
    // job, not the schema's.
    expect(r.success && r.data.type === 'page' && r.data.name).toBeUndefined()
  })

  it('accepts a named page payload with properties', () => {
    const r = IngestPayload.parse({
      ...base,
      type: 'page',
      name: 'Pricing',
      properties: { variant: 'b' },
    })
    expect(r.type === 'page' && r.name).toBe('Pricing')
    expect(r.type === 'page' && r.properties).toEqual({ variant: 'b' })
  })

  it('rejects a page payload with neither anonymous_id nor user_id', () => {
    // The unwrap discards PagePayload's own `.refine()`, so this passes only
    // because IngestPayload's superRefine re-applies it. Deleting the
    // superRefine makes this the failing test.
    const r = IngestPayload.safeParse({ message_id: base.message_id, type: 'page' })
    expect(r.success).toBe(false)
  })
})

describe('context.library', () => {
  const base = {
    message_id: '00000000-0000-4000-8000-000000000001',
    anonymous_id: 'a',
    type: 'track' as const,
    event: 'purchase',
  }

  it('accepts a declared library', () => {
    const r = IngestPayload.safeParse({
      ...base,
      context: { library: { name: 'lyraflow-python', version: '0.1.0' } },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.context.library?.name).toBe('lyraflow-python')
  })

  // Optional, so every client that predates this field is unaffected.
  it('accepts a payload with no library at all', () => {
    const r = IngestPayload.safeParse({ ...base, context: {} })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.context.library).toBeUndefined()
  })

  // Both fields required WHEN PRESENT -- an SDK that cannot state its own
  // version is a bug, and a half-filled object is worse than an absent one:
  // it looks like a declaration while carrying nothing to support it. But
  // an unusable value is IGNORED, never fatal.
  //
  // `Context` runs in Zod's strip mode, so before `library` was a known key
  // any value under it was discarded and the event stored. Naming the key
  // would otherwise invert that in silence -- a client already sending a
  // Segment-shaped `context.library` would go from "that field is dropped"
  // to "every one of your events is destroyed", answered 202, with the only
  // trace in a dead-letter table they cannot see. `.catch(undefined)`
  // restores the old outcome for the value while keeping the rule for the
  // declaration.
  it('ignores a library missing its version rather than destroying the event', () => {
    const r = IngestPayload.safeParse({
      ...base,
      context: { library: { name: 'lyraflow-python' } },
    })
    expect(r.success).toBe(true)
    // Not a declaration: `undefined` exempts nothing from the bot filter.
    if (r.success) expect(r.data.context.library).toBeUndefined()
  })

  it('ignores a library missing its name rather than destroying the event', () => {
    const r = IngestPayload.safeParse({ ...base, context: { library: { version: '0.1.0' } } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.context.library).toBeUndefined()
  })

  // Segment's own wire format spells `context.library` as an object, but
  // libraries in the wild send the bare name string. That is the shape most
  // likely to arrive from a client that predates this field entirely.
  it('ignores a library sent as a string rather than destroying the event', () => {
    const r = IngestPayload.safeParse({ ...base, context: { library: 'analytics-node/4.0.1' } })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.context.library).toBeUndefined()
  })

  it('ignores an over-long name rather than destroying the event', () => {
    const r = IngestPayload.safeParse({
      ...base,
      context: { library: { name: 'x'.repeat(MAX_ID_LENGTH + 1), version: '0.1.0' } },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.context.library).toBeUndefined()
  })

  // The tolerance is scoped to `library` alone, and nothing wider. A
  // `.catch()` placed on `Context` itself would swallow a bad `url` or
  // `user_agent` too and silently blank the whole context object.
  it('still fails the event on an unusable value in another context field', () => {
    const r = IngestPayload.safeParse({ ...base, context: { url: 12345 } })
    expect(r.success).toBe(false)
  })
})
