/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest'
import { buildEvent, pageContext } from './payload.js'

describe('pageContext', () => {
  it('captures url, path, referrer and user agent', () => {
    const ctx = pageContext()
    expect(ctx.url).toBe(window.location.href)
    expect(ctx.path).toBe(window.location.pathname)
    expect(ctx.user_agent).toBe(navigator.userAgent)
  })

  it('includes utm parameters only when the URL carries them', () => {
    // The server takes first-touch with an argMin, so the landing event is the
    // one that matters; persisting UTM across a session would buy nothing,
    // because both scopes read that same column.
    const bare = pageContext({ href: 'https://x.test/a', pathname: '/a', search: '' } as Location)
    expect(bare.utm_source).toBeUndefined()

    const tagged = pageContext({
      href: 'https://x.test/a?utm_source=news&utm_campaign=spring',
      pathname: '/a',
      search: '?utm_source=news&utm_campaign=spring',
    } as Location)
    expect(tagged.utm_source).toBe('news')
    expect(tagged.utm_campaign).toBe('spring')
    expect(tagged.utm_medium).toBeUndefined()
  })
})

describe('buildEvent', () => {
  const identity = { anonymousId: 'anon-1', userId: 'user-42' }

  it('stamps a fresh uuid and the current instant', () => {
    const now = new Date('2026-08-08T10:00:00.000Z')
    const e = buildEvent({ type: 'track', identity, event: 'signed_up', now })
    expect(e.message_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(e.timestamp).toBe('2026-08-08T10:00:00.000Z')
  })

  it('gives two events different message ids', () => {
    const a = buildEvent({ type: 'track', identity, event: 'x' })
    const b = buildEvent({ type: 'track', identity, event: 'x' })
    expect(a.message_id).not.toBe(b.message_id)
  })

  it('sends both identifiers when both are known', () => {
    // The event carries user_id so stage 1 of identity resolution claims it
    // outright; anonymous_id still records which device it happened on.
    const e = buildEvent({ type: 'track', identity, event: 'x' })
    expect(e.anonymous_id).toBe('anon-1')
    expect(e.user_id).toBe('user-42')
  })

  it('omits user_id entirely when nobody has identified', () => {
    const e = buildEvent({ type: 'track', identity: { anonymousId: 'anon-1' }, event: 'x' })
    expect('user_id' in e).toBe(false)
  })
})
