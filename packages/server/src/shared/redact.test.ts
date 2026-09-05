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
  })

  it('redacts a malformed segment too', () => {
    // By position, not by `SHARE_TOKEN_PATTERN`: a near-miss in a log is a
    // record of how close a guesser got, which is the thing worth hiding.
    expect(redactShareToken('/v1/shared/not-a-token')).toBe('/v1/shared/[redacted]')
    expect(redactShareToken(`/v1/shared/${'A'.repeat(200)}`)).toBe('/v1/shared/[redacted]')
  })

  it('leaves an unrelated URL alone', () => {
    for (const url of [
      '/v1/dashboards/1/share',
      '/v1/dashboards',
      '/v1/events/stats?interval=1d',
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
  })
})
