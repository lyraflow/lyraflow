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
  host: string
  writeKey: string
  fetchImpl: typeof fetch | undefined
  cookieDomainOption: string | undefined
  cookieDomainProbed: boolean
  cookieDomain: string | undefined
  debug: boolean
  gate: ConsentGate
  // Undefined until the gate first allows sending. Nothing that reaches a
  // cookie, localStorage or the network exists before that point — see
  // activateSending().
  queue: EventQueue | undefined
  transport: Transport | undefined
  identity: Identity
  // Captured by identify() while the gate is still pending, so a signup
  // behind a not-yet-answered banner isn't lost the moment consent arrives.
  pendingUserId: string | undefined
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

/** Every public method's "nothing happened yet" branch goes through this, so it's never silent. */
function warnNotInitialized(method: string): void {
  warn(`${method}() was called before init() — this call was dropped, not queued`)
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

/**
 * Creates the queue and transport and starts sending, the FIRST time the
 * gate allows it — from `init()` if consent is already granted (or not
 * required), or from `consent(true)` otherwise. Never re-entered once a
 * queue/transport already exist, so a later call is a cheap no-op.
 *
 * Nothing in this module constructs an `EventQueue` — which reads
 * `localStorage` in its constructor — or a `Transport` — which starts a
 * timer and unload listeners that read from and remove out of that queue —
 * before this runs. A closed gate must not gain access to stored
 * information any more than it may write it, and it must not have anything
 * capable of transmitting sitting armed in the background either.
 */
function activateSending(): void {
  if (!state) return
  if (!state.queue) state.queue = new EventQueue()
  state.identity = loadIdentity({ cookieDomain: resolveCookieDomain() })
  if (state.pendingUserId !== undefined) {
    setUserId(state.pendingUserId, { cookieDomain: resolveCookieDomain() })
    state.identity = { ...state.identity, userId: state.pendingUserId }
    state.pendingUserId = undefined
  }
  if (!state.transport) {
    state.transport = new Transport({
      host: state.host,
      writeKey: state.writeKey,
      queue: state.queue,
      warn,
      fetchImpl: state.fetchImpl,
    })
  }
  state.transport.start()
}

/**
 * Retries `activateSending()` from the send path whenever the gate allows
 * sending but no transport exists yet — the one way that combination can
 * arise is `activateSending()` throwing (inside `consent(true)`, if
 * `loadIdentity` fails) before it ever got as far as building a
 * `Transport`. Without this, that single failed attempt is terminal: the
 * gate is already `'granted'`, `activateSending()` is only ever called from
 * `init()` and `consent()`, and neither runs again — so nothing sends for
 * the rest of the page's life, and events already durably queued (see the
 * ordering in `consent()`) simply sit in storage until the next load.
 *
 * A cheap no-op on the (overwhelmingly common) path where activation
 * already succeeded, since `state.transport` is set by then.
 */
function ensureActivated(): void {
  if (!state) return
  if (state.gate.allowed() && !state.transport) activateSending()
}

function enqueueOrHold(e: QueuedEvent): void {
  if (!state) return
  const gateState = state.gate.state()
  if (gateState === 'refused') {
    // Checked before validating, not after: an event that is about to be
    // dropped unconditionally shouldn't produce validation noise on the
    // way out. identify()'s own "requires a user_id" rule is guaranteed to
    // fire here (a refused gate never sets identity.userId), which without
    // this check meant every identify() call during a refusal logged a
    // warning about a problem nobody could act on.
    debugLog(`dropped ${e.type} event ${e.message_id}: consent was refused`)
    return
  }
  for (const problem of validateEvent(e)) warn(problem)
  if (gateState === 'granted') {
    // Retries activation if a previous attempt (inside consent(true))
    // threw before a transport ever got built — otherwise a transient
    // loadIdentity failure on grant would strand every event in storage
    // for the rest of the page's life, with nothing left to ever flush
    // them.
    ensureActivated()
    state.queue?.add(e)
    debugLog(`enqueued ${e.type} event ${e.message_id}`)
  } else {
    // 'pending'
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
    // A second init() must not leave a first Transport's interval and
    // pagehide/visibilitychange listeners running alongside a second one,
    // draining a queue nothing here references any more — that's a
    // lost-update hazard on the shared storage key, not just a leak.
    // Transport.start() already guards re-entry into a SINGLE instance;
    // this guards against two different instances existing at once by
    // fully retiring the old one before anything below builds a new state.
    if (state) {
      warn('init() was called again; the SDK is being reconfigured from scratch')
      state.transport?.stop()
    }
    const gate = new ConsentGate({ required: options.requireConsent ?? false })
    state = {
      host: options.host,
      writeKey: options.writeKey,
      fetchImpl: options.fetchImpl,
      cookieDomainOption: options.cookieDomain,
      cookieDomainProbed: false,
      cookieDomain: undefined,
      debug: options.debug ?? false,
      gate,
      queue: undefined,
      transport: undefined,
      // A closed gate still needs SOME identity to stamp held events with;
      // this is ephemeral and never persisted. activateSending() replaces
      // it with the real, cookie-backed one the moment the gate allows it.
      identity: { anonymousId: newUuid() },
      pendingUserId: undefined,
    }
    if (gate.allowed()) activateSending()
    drainSnippetQueue()
    if (typeof window !== 'undefined') {
      ;(window as unknown as { lyraflow?: unknown }).lyraflow = api
    }
    if (options.autoPageView) page()
  })
}

export function track(event: string, properties?: Record<string, unknown>): void {
  guard(() => {
    if (!state) {
      warnNotInitialized('track')
      return
    }
    const e = buildEvent({ type: 'track', identity: state.identity, event, properties })
    enqueueOrHold(e)
  })
}

export function page(name?: string, properties?: Record<string, unknown>): void {
  guard(() => {
    if (!state) {
      warnNotInitialized('page')
      return
    }
    const e = buildEvent({ type: 'page', identity: state.identity, name, properties })
    enqueueOrHold(e)
  })
}

export function identify(userId: string, traits?: Record<string, unknown>): void {
  guard(() => {
    if (!state) {
      warnNotInitialized('identify')
      return
    }
    const gateState = state.gate.state()
    if (gateState === 'granted') {
      setUserId(userId, { cookieDomain: resolveCookieDomain() })
      state.identity = { ...state.identity, userId }
    } else if (gateState === 'pending') {
      // Carried across so consent(true) can persist it — without this, a
      // signup behind a still-open banner is anonymous forever the moment
      // consent DOES arrive, because loadIdentity() on grant never learns
      // about it.
      state.pendingUserId = userId
      state.identity = { ...state.identity, userId }
    }
    // 'refused': identity is left untouched — a refusal stops collection,
    // so there is nothing to carry forward for a grant that may never come.
    const e = buildEvent({ type: 'identify', identity: state.identity, traits })
    enqueueOrHold(e)
  })
}

export function consent(granted: boolean): void {
  guard(() => {
    if (!state) {
      warnNotInitialized('consent')
      return
    }
    const released = state.gate.decide(granted)
    if (!granted) {
      // An explicit refusal must stop any further sending immediately, not
      // merely defer it — leaving the transport running would keep
      // draining whatever was already queued from a prior grant. It must
      // also discard a user id captured while the gate was still pending —
      // a refusal stops collection, so persisting an identifier gathered
      // during the window the visitor then declined is exactly what it
      // exists to prevent.
      state.transport?.stop()
      state.pendingUserId = undefined
      return
    }
    // Get the released events into a durable queue BEFORE doing anything
    // that can throw (loadIdentity, inside activateSending) — losing them
    // to an internal error would be strictly worse than shipping them
    // under their pre-consent, ephemeral anonymous_id.
    if (!state.queue) state.queue = new EventQueue()
    for (const e of released) state.queue.add(e)
    activateSending()
    // Re-stamp anonymous_id only, now that the real identity is loaded —
    // held events never had a persisted id, so nothing here is a resend of
    // anything already on the wire. user_id is left exactly as each event
    // was recorded under: retro-stamping a user id onto events from before
    // identify() would violate the same principle reset()'s flush-first
    // ordering protects.
    const anonymousId = state.identity.anonymousId
    for (const e of released) {
      state.queue.remove([e.message_id])
      state.queue.add({ ...e, anonymous_id: anonymousId })
    }
    void flush()
  })
}

/** Flushes before rotating, so events already queued keep the identity they were recorded under. */
export function reset(): void {
  guard(() => {
    if (!state) {
      warnNotInitialized('reset')
      return
    }
    void flush()
    // A user id captured by identify() while the gate was still pending
    // must not survive a reset — otherwise a logout is silently undone the
    // moment a later consent(true) persists it, since activateSending()
    // only ever clears this on a SUCCESSFUL grant, which reset() itself is
    // not.
    state.pendingUserId = undefined
    state.identity = state.gate.allowed()
      ? resetIdentity({ cookieDomain: resolveCookieDomain() })
      : { anonymousId: newUuid() }
  })
}

/**
 * Delegates to the transport, which never rejects. The try/catch below is a
 * second layer for the same "nothing throws into the host app" promise the
 * synchronous `guard()` gives every other public method.
 *
 * A no-op while the gate is closed: there is no queue or transport before
 * `activateSending()` has ever run, and even after a later refusal — where
 * `transport.stop()` has already silenced the timer and unload listeners —
 * an explicit `flush()` call must not reach around that and send anyway.
 */
export async function flush(): Promise<void> {
  if (!state) {
    warnNotInitialized('flush')
    return
  }
  if (!state.gate.allowed()) return
  try {
    // Retries activation (see ensureActivated's own doc) — the send path
    // is exactly where a stalled first attempt needs to get another
    // chance, and an explicit flush() is the one call a host is certain to
    // make eventually even if nothing else retries it first.
    ensureActivated()
  } catch (err) {
    warn(`swallowed an internal error: ${String(err)}`)
    return
  }
  if (!state.transport) return
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
