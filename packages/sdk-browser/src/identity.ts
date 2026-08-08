export const AID_COOKIE = 'lyraflow_aid'
export const UID_COOKIE = 'lyraflow_uid'

const TWO_YEARS_SECONDS = 63_072_000

/**
 * A v4 UUID. The server validates `message_id` with `z.string().uuid()`, so a
 * "close enough" random string is dead-lettered — and the ingest answers 202
 * either way, so nothing would ever report it.
 */
export function newUuid(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  const bytes = new Uint8Array(16)
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    // No Web Crypto API at all — not even getRandomValues. An analytics SDK
    // must never throw during init and break the host page, so this still
    // has to produce a v4-shaped id. Math.random is weaker, but the ingest
    // server only checks shape, and this path is for an embedding context
    // with no crypto API, not the common case.
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  // Set the version (4) and variant (10xx) bits the format requires.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function readCookie(name: string, doc: Document): string | undefined {
  for (const part of doc.cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function writeCookie(name: string, value: string, domain: string | undefined, doc: Document): void {
  const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : ''
  const scope = domain ? `; Domain=${domain}` : ''
  doc.cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${TWO_YEARS_SECONDS}; SameSite=Lax${secure}${scope}`
}

// Deletion uses `Expires` in the past rather than `Max-Age=0`. Both are valid
// per RFC 6265, but happy-dom's cookie jar (used by this package's own tests)
// does not honour `Max-Age=0` as an immediate-expiry signal — it leaves an
// empty-value cookie behind, which `readCookie` then reads back as `''`
// instead of `undefined`. `Expires` in the past removes the cookie outright
// in both happy-dom and real browsers, so it is the one deletion form that is
// actually provable under test.
function deleteCookie(name: string, domain: string | undefined, doc: Document): void {
  const scope = domain ? `; Domain=${domain}` : ''
  doc.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT${scope}`
}

/**
 * The broadest domain this browser will actually accept a cookie on.
 *
 * Doing this properly needs the Public Suffix List, which is far larger than
 * this entire SDK. The naive "last two labels" rule breaks on example.co.uk: it
 * attempts `.co.uk`, the browser rejects it silently, and the result is no
 * cookie at all and a new visitor id on every page load.
 *
 * So: walk up the labels, try a throwaway cookie at each level, read it back,
 * and keep the broadest that actually persisted. No list to ship or keep
 * current, and it self-corrects on domains nobody anticipated.
 */
export function probeCookieDomain(hostname: string, doc: Document = document): string | undefined {
  if (/^[\d.]+$/.test(hostname) || !hostname.includes('.')) return undefined
  const labels = hostname.split('.')
  for (let i = labels.length - 2; i >= 0; i -= 1) {
    const candidate = `.${labels.slice(i).join('.')}`
    const probe = `lyraflow_probe_${Math.floor(Math.random() * 1e9)}`
    doc.cookie = `${probe}=1; Path=/; Domain=${candidate}`
    const accepted = readCookie(probe, doc) !== undefined
    deleteCookie(probe, candidate, doc)
    if (accepted) return candidate
  }
  return undefined
}

export interface Identity {
  anonymousId: string
  userId?: string
}

function domainFor(opts: { cookieDomain?: string }): string | undefined {
  return opts.cookieDomain ?? probeCookieDomain(location.hostname)
}

export function loadIdentity(opts: { cookieDomain?: string }): Identity {
  const existing = readCookie(AID_COOKIE, document)
  // `||`, not `??`: a cookie that is present but empty (a stale value left by a
  // deletion that only blanked rather than removed it) must not be adopted as
  // a real anonymous id — it isn't UUID-shaped, and it would silently persist
  // forever once rewritten below.
  const anonymousId = existing || newUuid()
  // Written on every load, not only when minted. This cookie's entire job is
  // long-lived identity, so its two-year window should measure from the
  // visitor's most recent visit, not their first — otherwise a daily visitor
  // still drops off the far end of the window on day 731. The cost is one
  // extra cookie write per page load; that's a deliberate trade, not an
  // oversight. (Caller's note: `domainFor` re-probes on every call unless
  // `opts.cookieDomain` is supplied — a caller that loads identity on every
  // page should probe once and pass the result back in, not rely on this
  // function to cache it.)
  writeCookie(AID_COOKIE, anonymousId, domainFor(opts), document)
  const uid = readCookie(UID_COOKIE, document)
  return { anonymousId, userId: uid || undefined }
}

export function setUserId(userId: string, opts: { cookieDomain?: string }): void {
  writeCookie(UID_COOKIE, userId, domainFor(opts), document)
}

/**
 * Logout. The caller flushes BEFORE calling this, so queued events keep the
 * identity they were recorded under.
 */
export function resetIdentity(opts: { cookieDomain?: string }): Identity {
  const domain = domainFor(opts)
  deleteCookie(UID_COOKIE, domain, document)
  const anonymousId = newUuid()
  writeCookie(AID_COOKIE, anonymousId, domain, document)
  return { anonymousId }
}
