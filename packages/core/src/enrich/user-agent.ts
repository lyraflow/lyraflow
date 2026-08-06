export interface UserAgentInfo {
  device_type: string
  os: string
  browser: string
}

const UNKNOWN: UserAgentInfo = { device_type: 'unknown', os: 'unknown', browser: 'unknown' }

// Order matters throughout: more specific tokens must be tested first, because
// most browsers impersonate their predecessors in the UA string.
const BROWSERS: Array<[string, RegExp]> = [
  ['edge', /\bedg[ea]?\//i],
  ['opera', /\b(opr|opera)\//i],
  ['samsung', /\bsamsungbrowser\//i],
  ['firefox', /\bfirefox\//i],
  ['chrome', /\bchrome\//i],
  ['safari', /\bsafari\//i],
]

const OSES: Array<[string, RegExp]> = [
  ['ios', /\b(iphone|ipad|ipod)\b/i],
  ['android', /\bandroid\b/i],
  ['macos', /\bmac os x\b/i],
  ['windows', /\bwindows nt\b/i],
  ['linux', /\blinux\b/i],
]

function match(ua: string, table: Array<[string, RegExp]>): string {
  for (const [name, re] of table) if (re.test(ua)) return name
  return 'unknown'
}

function deviceType(ua: string, os: string): string {
  if (/\bipad\b/i.test(ua)) return 'tablet'
  if (os === 'android' && !/\bmobile\b/i.test(ua)) return 'tablet'
  if (/\b(iphone|ipod)\b/i.test(ua) || /\bmobile\b/i.test(ua)) return 'mobile'
  if (os === 'unknown') return 'unknown'
  return 'desktop'
}

export function parseUserAgent(ua: string | undefined): UserAgentInfo {
  if (!ua) return UNKNOWN
  const os = match(ua, OSES)
  return { device_type: deviceType(ua, os), os, browser: match(ua, BROWSERS) }
}
