import { ConsentGate } from './consent.js'
import type { Identity } from './identity.js'
import { loadIdentity, newUuid, probeCookieDomain, resetIdentity, setUserId } from './identity.js'
import { buildEvent } from './payload.js'
import type { QueuedEvent } from './payload.js'
import { EventQueue } from './queue.js'
import { Transport } from './transport.js'
import { validateEvent } from './validate.js'

export const VERSION = '0.1.0'

export interface InitOptions {
  host: string
  writeKey: string
  cookieDomain?: string
  requireConsent?: boolean
  autoPageView?: boolean
  debug?: boolean
  fetchImpl?: typeof fetch // tests only; undocumented in the README
}

interface State {
  cookieDomainOption: string | undefined
  cookieDomainProbed: boolean
  cookieDomain: string | undefined
  debug: boolean
  gate: ConsentGate
  queue: EventQueue
  transport: Transport
  identity: Identity
}

let state: State | undefined

/**
 * Always-on. Validation problems and the two loud transport failures (a
 * rejected write key, a dropped batch) are the only feedback a developer
 * building against a 202-always ingest ever gets, so they are never gated
 * behind `debug`.
 */
function warn(message: string): void {
  console.warn(`[lyraflow] ${message}`)
}

/**
 * Off unless `debug: true`. A library that chatters into a customer's
 * console by default is a library people remove.
 */
function debugLog(message: string): void {
  if (state?.debug) console.debug(`[lyraflow] ${message}`)
}

/**
 * Wraps every public method body. A guard that swallows an internal error
 * must still say so — silently eating both the error AND the event it was
 * trying to record would be strictly worse than letting the host see it.
 */
function guard(fn: () => void): void {
  try {
    fn()
  } catch (err) {
    warn(`swallowed an internal error: ${String(err)}`)
  }
}

/**
 * Resolved lazily and cached, not eagerly at `init`: the probe itself writes
 * and deletes a throwaway cookie per candidate label, and "nothing touches a
 * cookie while the gate is closed" has to hold for the probe too, not just
 * for identity. The common case — no consent gate, or consent already
 * granted — still resolves this on the very first call, at `init`, matching
 * "probe once, at init, and thread it through." A gate that starts closed
 * defers the probe until the first call that is actually allowed to touch a
 * cookie (a `consent(true)`), and it is still only ever probed once from
 * that point on.
 */
function resolveCookieDomain(): string | undefined {
  if (!state) return undefined
  if (!state.cookieDomainProbed) {
    state.cookieDomain = state.cookieDomainOption ?? probeCookieDomain(location.hostname)
    state.cookieDomainProbed = true
  }
  return state.cookieDomain
}

function enqueueOrHold(e: QueuedEvent): void {
  if (!state) return
  for (const problem of validateEvent(e)) warn(problem)
  if (state.gate.allowed()) {
    state.queue.add(e)
    debugLog(`enqueued ${e.type} event ${e.message_id}`)
  } else {
    state.gate.hold(e)
    debugLog(`held ${e.type} event ${e.message_id} pending consent`)
  }
}

/**
 * Calls queued by the snippet stub (`window.lyraflow.q`) before this script
 * finished loading — the script tag is async, so the call most likely to
 * land here is the one a host least wants to lose. Cleared once read so a
 * hypothetical second `init()` never replays it.
 */
function drainSnippetQueue(): void {
  const stub = (globalThis as unknown as { lyraflow?: { q?: unknown[] } }).lyraflow
  const queued = stub?.q
  if (!Array.isArray(queued)) return
  if (stub) stub.q = []
  for (const call of queued) {
    if (!Array.isArray(call) || call.length === 0) continue
    const [method, ...args] = call as [unknown, ...unknown[]]
    switch (method) {
      case 'track':
        track(args[0] as string, args[1] as Record<string, unknown> | undefined)
        break
      case 'page':
        page(args[0] as string | undefined, args[1] as Record<string, unknown> | undefined)
        break
      case 'identify':
        identify(args[0] as string, args[1] as Record<string, unknown> | undefined)
        break
      case 'consent':
        consent(Boolean(args[0]))
        break
      case 'reset':
        reset()
        break
      case 'flush':
        void flush()
        break
      default:
        break
    }
  }
}

export function init(options: InitOptions): void {
  guard(() => {
    const gate = new ConsentGate({ required: options.requireConsent ?? false })
    // Loaded, and the cookie domain probed, only when the gate allows it:
    // both loadIdentity and the probe behind it write a cookie, and a
    // closed gate must not touch one. A closed gate still needs SOME
    // identity to stamp held events with, so it gets an ephemeral,
    // never-persisted one instead.
    let cookieDomain: string | undefined
    let cookieDomainProbed = false
    let identity: Identity
    if (gate.allowed()) {
      cookieDomain = options.cookieDomain ?? probeCookieDomain(location.hostname)
      cookieDomainProbed = true
      identity = loadIdentity({ cookieDomain })
    } else {
      identity = { anonymousId: newUuid() }
    }
    const queue = new EventQueue()
    const transport = new Transport({
      host: options.host,
      writeKey: options.writeKey,
      queue,
      warn,
      fetchImpl: options.fetchImpl,
    })
    state = {
      cookieDomainOption: options.cookieDomain,
      cookieDomainProbed,
      cookieDomain,
      debug: options.debug ?? false,
      gate,
      queue,
      transport,
      identity,
    }
    transport.start()
    drainSnippetQueue()
    if (typeof window !== 'undefined') {
      ;(window as unknown as { lyraflow?: unknown }).lyraflow = api
    }
    if (options.autoPageView) page()
  })
}

export function track(event: string, properties?: Record<string, unknown>): void {
  guard(() => {
    if (!state) return
    const e = buildEvent({ type: 'track', identity: state.identity, event, properties })
    enqueueOrHold(e)
  })
}

export function page(name?: string, properties?: Record<string, unknown>): void {
  guard(() => {
    if (!state) return
    const e = buildEvent({ type: 'page', identity: state.identity, name, properties })
    enqueueOrHold(e)
  })
}

export function identify(userId: string, traits?: Record<string, unknown>): void {
  guard(() => {
    if (!state) return
    // Persisted only when the gate allows it — see the note in init(). The
    // in-memory identity is updated either way, so a later track() call in
    // the same (still-gated) session carries the same user id.
    if (state.gate.allowed()) setUserId(userId, { cookieDomain: resolveCookieDomain() })
    state.identity = { ...state.identity, userId }
    const e = buildEvent({ type: 'identify', identity: state.identity, traits })
    enqueueOrHold(e)
  })
}

export function consent(granted: boolean): void {
  guard(() => {
    if (!state) return
    const released = state.gate.decide(granted)
    if (!granted) return
    state.identity = loadIdentity({ cookieDomain: resolveCookieDomain() })
    for (const e of released) state.queue.add(e)
    void flush()
  })
}

/** Flushes before rotating, so events already queued keep the identity they were recorded under. */
export function reset(): void {
  guard(() => {
    if (!state) return
    void flush()
    state.identity = state.gate.allowed()
      ? resetIdentity({ cookieDomain: resolveCookieDomain() })
      : { anonymousId: newUuid() }
  })
}

/**
 * Delegates to the transport, which never rejects. The try/catch below is a
 * second layer for the same "nothing throws into the host app" promise the
 * synchronous `guard()` gives every other public method.
 */
export async function flush(): Promise<void> {
  if (!state) return
  debugLog('flush attempt')
  try {
    const outcome = await state.transport.flush()
    debugLog(`flush outcome: ${outcome}`)
  } catch (err) {
    warn(`swallowed an internal error: ${String(err)}`)
  }
}

const api = { init, track, page, identify, consent, reset, flush }

export default api
