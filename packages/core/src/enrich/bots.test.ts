import { describe, expect, it } from 'vitest'
import { isBot } from './bots.js'

describe('isBot', () => {
  it.each([
    'Googlebot/2.1 (+http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0)',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0)',
    'curl/8.7.1',
    'python-requests/2.32.3',
    'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/131.0',
    'Slackbot-LinkExpanding 1.0',
  ])('flags %s', (ua) => {
    expect(isBot(ua)).toBe(true)
  })

  it('does not flag a normal browser', () => {
    expect(
      isBot(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
      ),
    ).toBe(false)
  })

  it('treats a missing user agent as a bot, since real browsers always send one', () => {
    expect(isBot(undefined)).toBe(true)
  })
})
