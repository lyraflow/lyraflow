import { describe, expect, it } from 'vitest'
import { parseUserAgent } from './user-agent.js'

describe('parseUserAgent', () => {
  it('classifies desktop Chrome on macOS', () => {
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
      ),
    ).toEqual({ device_type: 'desktop', os: 'macos', browser: 'chrome' })
  })

  it('classifies mobile Safari on iOS', () => {
    expect(
      parseUserAgent(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      ),
    ).toEqual({ device_type: 'mobile', os: 'ios', browser: 'safari' })
  })

  it('classifies an Android tablet', () => {
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      ),
    ).toEqual({ device_type: 'tablet', os: 'android', browser: 'chrome' })
  })

  it('does not report Chrome for Edge, which contains the Chrome token', () => {
    expect(
      parseUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36 Edg/131.0',
      ),
    ).toEqual({ device_type: 'desktop', os: 'windows', browser: 'edge' })
  })

  it('returns unknown for a missing user agent', () => {
    expect(parseUserAgent(undefined)).toEqual({
      device_type: 'unknown',
      os: 'unknown',
      browser: 'unknown',
    })
  })
})
