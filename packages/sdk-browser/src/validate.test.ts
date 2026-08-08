import {
  MAX_ID_LENGTH as CORE_MAX_ID_LENGTH,
  MAX_PROPERTIES_PER_EVENT as CORE_MAX_PROPERTIES_PER_EVENT,
  IngestPayload,
} from '@lyraflow/core'
// Test files run in Node and are never bundled, so importing core here is free
// — unlike runtime code, where a value import fails the bundle.
import { describe, expect, it } from 'vitest'
import type { QueuedEvent } from './payload.js'
import { MAX_ID_LENGTH, MAX_PROPERTIES_PER_EVENT, validateEvent } from './validate.js'

const base = (over: Partial<QueuedEvent> = {}): QueuedEvent => ({
  type: 'track',
  message_id: '11111111-1111-4111-8111-111111111111',
  timestamp: '2026-08-08T10:00:00.000Z',
  anonymous_id: 'anon-1',
  context: {},
  event: 'signed_up',
  ...over,
})

describe('validateEvent', () => {
  it('passes a well-formed event', () => {
    expect(validateEvent(base())).toEqual([])
  })

  it('names the offending key for a nested value', () => {
    const problems = validateEvent(base({ properties: { plan: { tier: 'pro' } } }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('plan')
  })

  it('flags an array value', () => {
    expect(validateEvent(base({ properties: { tags: ['a', 'b'] } }))).toHaveLength(1)
  })

  it('allows exactly 250 properties, the documented limit', () => {
    const properties = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`k${i}`, i]))
    expect(validateEvent(base({ properties }))).toEqual([])
  })

  it('flags more than 250 properties', () => {
    const properties = Object.fromEntries(Array.from({ length: 251 }, (_, i) => [`k${i}`, i]))
    expect(validateEvent(base({ properties }))).toHaveLength(1)
  })

  it('flags an over-long id', () => {
    expect(validateEvent(base({ anonymous_id: 'x'.repeat(129) }))).toHaveLength(1)
  })

  it('flags a non-string id instead of letting it pass as absent', () => {
    // QueuedEvent types anonymous_id as string | undefined, but this SDK
    // ships to JavaScript callers, where that's advisory. The cast is
    // deliberate: it reaches the runtime shape TypeScript would otherwise
    // block, which is exactly the shape that broke this check.
    const problems = validateEvent(base({ anonymous_id: 12345 as unknown as string }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('anonymous_id')
  })

  it('records a problem instead of throwing when a property getter throws', () => {
    const properties: Record<string, unknown> = {}
    Object.defineProperty(properties, 'poison', {
      enumerable: true,
      get(): never {
        throw new Error('boom')
      },
    })
    const problems = validateEvent(base({ properties }))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('poison')
  })

  it('flags a track event with no name', () => {
    expect(validateEvent(base({ event: undefined }))).toHaveLength(1)
  })

  it('keeps its local constants equal to the ones the server enforces', () => {
    // The SDK cannot import these as values — a value import from core fails
    // the bundle. So they are duplicated, and this is what stops the duplicate
    // drifting: a change to core's limit that nobody mirrors here fails loudly
    // rather than producing an SDK that warns about the wrong number.
    expect(MAX_ID_LENGTH).toBe(CORE_MAX_ID_LENGTH)
    expect(MAX_PROPERTIES_PER_EVENT).toBe(CORE_MAX_PROPERTIES_PER_EVENT)
  })

  it('agrees with the server schema on a set of fixtures', () => {
    // The drift guard. The SDK cannot ship Zod (13KB gzipped against a 5KB
    // budget), so its checks are hand-written — and a hand-written copy of
    // somebody else's rules diverges silently unless something compares them.
    const fixtures: QueuedEvent[] = [
      base(),
      base({ properties: { rows: 12, source: 'csv', ok: true, note: null } }),
      base({ properties: { tags: ['a', 'b'] } }),
      base({ properties: { plan: { tier: 'pro' } } }),
      base({ event: undefined }),
      base({ anonymous_id: 'x'.repeat(129) }),
      // TypeScript types anonymous_id as string | undefined, but this SDK
      // ships to JavaScript callers where that's advisory, not enforced —
      // this is the cast that pins the runtime shape TypeScript itself
      // would otherwise prevent this fixture list from ever containing.
      base({ anonymous_id: 12345 as unknown as string }),
      base({ anonymous_id: undefined, user_id: undefined }),
      base({ type: 'identify', event: undefined, user_id: 'user-42', traits: { plan: 'pro' } }),
      base({ type: 'page', event: undefined, name: 'Pricing' }),
    ]
    for (const fixture of fixtures) {
      const sdkOk = validateEvent(fixture).length === 0
      const serverOk = IngestPayload.safeParse(fixture).success
      expect(
        { fixture: JSON.stringify(fixture).slice(0, 120), sdkOk },
        'SDK and server disagree about this fixture',
      ).toEqual({ fixture: JSON.stringify(fixture).slice(0, 120), sdkOk: serverOk })
    }
  })
})
