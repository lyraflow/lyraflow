import { describe, expect, it } from 'vitest'
import { redactShareToken } from './redact.js'

const TOKEN = 'aB3-_xY9zQwErTyUiOpAsDfGhJkLzXcVbNm1234567_x'.slice(0, 43)

describe('redactShareToken', () => {
  it('redacts a bare token', () => {
    expect(redactShareToken(`/v1/shared/${TOKEN}`)).toBe('/v1/shared/[redacted]')
  })

  it('redacts a token with a tiles path, keeping the tail', () => {
    expect(redactShareToken(`/v1/shared/${TOKEN}/tiles/2/run`)).toBe(
      '/v1/shared/[redacted]/tiles/2/run',
    )
  })

  it('redacts a token with a query string, keeping the query', () => {
    expect(redactShareToken(`/v1/shared/${TOKEN}?range=7d`)).toBe('/v1/shared/[redacted]?range=7d')
    expect(redactShareToken(`/v1/shared/${TOKEN}?x=1`)).toBe('/v1/shared/[redacted]?x=1')
  })

  it('redacts a token with a trailing slash', () => {
    expect(redactShareToken(`/v1/shared/${TOKEN}/`)).toBe('/v1/shared/[redacted]/')
  })

  it('redacts every shape that dodges a literal prefix match', () => {
    // All four 404 at the router, and Fastify logs `req.url` raw on a 404
    // exactly as it does on a 200 -- so each of these used to put a whole
    // credential in the log. Matched through `normalizePath`, the same
    // normalizer static.ts's API-prefix check uses.
    for (const url of [
      `//v1/shared/${TOKEN}`,
      `/v1/shared//${TOKEN}`,
      `/v1%2Fshared/${TOKEN}`,
      `/V1/shared/${TOKEN}`,
      `//v1//shared//${TOKEN}//tiles//0//run`,
    ]) {
      const out = redactShareToken(url)
      expect(out).not.toContain(TOKEN)
      expect(out).toContain('[redacted]')
    }
    // The path emitted is the normalized one, so the doubled slash is gone;
    // the case of the prefix as the caller sent it survives.
    expect(redactShareToken(`//v1/shared/${TOKEN}`)).toBe('/v1/shared/[redacted]')
    expect(redactShareToken(`/V1/shared/${TOKEN}`)).toBe('/V1/shared/[redacted]')
  })

  it('redacts a malformed segment too', () => {
    // By position, not by `SHARE_TOKEN_PATTERN`: a near-miss in a log is a
    // record of how close a guesser got, which is the thing worth hiding.
    expect(redactShareToken('/v1/shared/not-a-token')).toBe('/v1/shared/[redacted]')
    expect(redactShareToken(`/v1/shared/${'A'.repeat(200)}`)).toBe('/v1/shared/[redacted]')
  })

  it('redacts the viewer page URL, which is the link people actually hold', () => {
    // `/shared/<token>` is what `shareUrl` (ui/src/screens/dashboards/
    // ShareCard.tsx) builds and what an operator copies out of the Share
    // card; `/v1/shared/<token>` is only what that page then calls. The
    // page URL is served by static.ts's SPA fallback, and Fastify logs
    // `req.url` on it exactly as it does on an API route -- so while this
    // prefix went unmatched, every single viewer page load wrote a whole
    // working credential into the request log.
    expect(redactShareToken(`/shared/${TOKEN}`)).toBe('/shared/[redacted]')
    expect(redactShareToken(`/shared/${TOKEN}/`)).toBe('/shared/[redacted]/')
    expect(redactShareToken(`/shared/${TOKEN}?range=7d`)).toBe('/shared/[redacted]?range=7d')
    // The same four dodges the `/v1/shared/` case is pinned against, since
    // both prefixes are matched through the one `normalizePath`.
    for (const url of [
      `//shared/${TOKEN}`,
      `/shared//${TOKEN}`,
      `/shared%2F${TOKEN}`,
      `/SHARED/${TOKEN}`,
    ]) {
      const out = redactShareToken(url)
      expect(out).not.toContain(TOKEN)
      expect(out).toContain('[redacted]')
    }
    expect(redactShareToken(`//shared/${TOKEN}`)).toBe('/shared/[redacted]')
    expect(redactShareToken(`/SHARED/${TOKEN}`)).toBe('/SHARED/[redacted]')
  })

  it('leaves /shared with no segment, and an unrelated path, alone', () => {
    // Same reasoning as `/v1/shared` below: there is no token in any of
    // these, and rewriting one would make the log claim a request carried
    // a credential when it did not.
    expect(redactShareToken('/shared')).toBe('/shared')
    expect(redactShareToken('/shared/')).toBe('/shared/')
    expect(redactShareToken('/shared//')).toBe('/shared//')
    expect(redactShareToken('/dashboards/1')).toBe('/dashboards/1')
  })

  it('leaves an unrelated URL alone', () => {
    for (const url of [
      '/v1/dashboards/1/share',
      '/v1/dashboards',
      '/v1/events/stats?interval=1d',
      '/v1/sharedish/x',
      '/health',
      '/',
      '',
    ]) {
      expect(redactShareToken(url)).toBe(url)
    }
  })

  it('leaves /v1/shared with no segment alone', () => {
    // Nothing to hide, and rewriting it would make the log claim a request
    // carried a credential when it did not.
    expect(redactShareToken('/v1/shared')).toBe('/v1/shared')
    expect(redactShareToken('/v1/shared/')).toBe('/v1/shared/')
    expect(redactShareToken('/v1/shared/?x=1')).toBe('/v1/shared/?x=1')
    expect(redactShareToken('/v1/shared//')).toBe('/v1/shared//')
  })
})
