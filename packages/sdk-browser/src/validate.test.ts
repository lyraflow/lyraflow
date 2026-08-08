import {
  MAX_ID_LENGTH as CORE_MAX_ID_LENGTH,
  MAX_PROPERTIES_PER_EVENT as CORE_MAX_PROPERTIES_PER_EVENT,
  MAX_URL_LENGTH as CORE_MAX_URL_LENGTH,
  MAX_USER_AGENT_LENGTH as CORE_MAX_USER_AGENT_LENGTH,
  IngestPayload,
} from '@lyraflow/core'
// Test files run in Node and are never bundled, so importing core here is free
// — unlike runtime code, where a value import fails the bundle.
import { describe, expect, it } from 'vitest'
import type { QueuedEvent } from './payload.js'
import {
  MAX_ID_LENGTH,
  MAX_PROPERTIES_PER_EVENT,
  MAX_URL_LENGTH,
  MAX_USER_AGENT_LENGTH,
  clampContext,
  validateEvent,
} from './validate.js'

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
    expect(MAX_URL_LENGTH).toBe(CORE_MAX_URL_LENGTH)
    expect(MAX_USER_AGENT_LENGTH).toBe(CORE_MAX_USER_AGENT_LENGTH)
  })

  it('flags an over-long url, path, referrer and user_agent', () => {
    // The server caps all four and rejects the whole event over any of them.
    // Nothing in the SDK knew these limits existed.
    const problems = validateEvent(
      base({
        context: {
          url: 'u'.repeat(MAX_URL_LENGTH + 1),
          path: 'p'.repeat(MAX_URL_LENGTH + 1),
          referrer: 'r'.repeat(MAX_URL_LENGTH + 1),
          user_agent: 'a'.repeat(MAX_USER_AGENT_LENGTH + 1),
        },
      }),
    )
    expect(problems).toHaveLength(4)
    expect(problems.join(' ')).toContain('context.url')
  })

  it('leaves a context at exactly the limit alone', () => {
    const e = base({
      context: { url: 'u'.repeat(MAX_URL_LENGTH), user_agent: 'a'.repeat(MAX_USER_AGENT_LENGTH) },
    })
    expect(clampContext(e)).toEqual([])
    expect(validateEvent(e)).toEqual([])
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
      // The shape the whole-branch review found: a context field over the
      // server's cap. Every fixture above was about the event body, so the
      // guard had nothing to say about context and the SDK's checks and the
      // server's schema disagreed here in silence.
      base({ context: { url: `https://shop.example.com/callback?to=${'y'.repeat(2100)}` } }),
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

describe('clampContext', () => {
  it('truncates an over-long url instead of letting the server discard the event', () => {
    // An OAuth callback carrying a long `redirect_uri`, the shape the review
    // reproduced this with. Sent whole, the server answers 202, stores
    // nothing, and writes one dead letter; the event, its properties and its
    // identity are all gone for one long query string.
    const url = `https://shop.example.com/callback?redirect_uri=${'x'.repeat(2100)}`
    expect(url.length).toBeGreaterThan(MAX_URL_LENGTH)
    const e = base({ context: { url, path: '/callback' } })

    const messages = clampContext(e)

    expect(e.context.url).toHaveLength(MAX_URL_LENGTH)
    expect(e.context.url).toBe(url.slice(0, MAX_URL_LENGTH))
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('truncated')
    // And the truncated event is now something the server will actually store.
    expect(IngestPayload.safeParse(e).success).toBe(true)
  })

  it('says nothing about a context that is already within the limits', () => {
    expect(clampContext(base({ context: { url: 'https://shop.example.com/' } }))).toEqual([])
  })

  it('does not throw on a missing or malformed context', () => {
    expect(clampContext(base({ context: undefined as unknown as Record<string, string> }))).toEqual(
      [],
    )
    expect(clampContext(base({ context: 'nope' as unknown as Record<string, string> }))).toEqual([])
  })
})
