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

  // Both fields required WHEN PRESENT. An SDK that cannot state its own
  // version is a bug, and a half-filled object is worse than an absent one
  // -- it looks like a declaration while carrying nothing to support.
  it('rejects a library missing its version', () => {
    const r = IngestPayload.safeParse({
      ...base,
      context: { library: { name: 'lyraflow-python' } },
    })
    expect(r.success).toBe(false)
  })

  it('rejects a library missing its name', () => {
    const r = IngestPayload.safeParse({ ...base, context: { library: { version: '0.1.0' } } })
    expect(r.success).toBe(false)
  })

  it('rejects a name longer than MAX_ID_LENGTH', () => {
    const r = IngestPayload.safeParse({
      ...base,
      context: { library: { name: 'x'.repeat(MAX_ID_LENGTH + 1), version: '0.1.0' } },
    })
    expect(r.success).toBe(false)
  })
})
