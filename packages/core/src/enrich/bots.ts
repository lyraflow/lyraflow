/**
 * Substring match against a lowercased UA. Deliberately coarse: false
 * positives cost one visitor, while false negatives quietly corrupt every
 * person count in the product.
 */
const BOT_TOKENS = [
  'bot',
  'crawler',
  'spider',
  'crawling',
  'slurp',
  'headless',
  'curl/',
  'wget/',
  'python-requests',
  'python-urllib',
  'go-http-client',
  'java/',
  'okhttp',
  'axios/',
  'node-fetch',
  'got (',
  'phantomjs',
  'lighthouse',
  'pingdom',
  'uptimerobot',
  'monitoring',
  'preview',
  'facebookexternalhit',
  'embedly',
  'quora link preview',
  'whatsapp',
  'telegrambot',
  'discordbot',
  'linkedinbot',
  'archive.org_bot',
] as const

export function isBot(ua: string | undefined): boolean {
  if (!ua) return true
  const lower = ua.toLowerCase()
  return BOT_TOKENS.some((token) => lower.includes(token))
}
