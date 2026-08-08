import type { QueuedEvent } from './payload.js'

export const MAX_HELD_EVENTS = 100

export type ConsentState = 'granted' | 'refused' | 'pending'

/**
 * `navigator` is host-controlled, not spec-controlled: `doNotTrack` alone has
 * shipped as the string `'1'` (current browsers), the string `'yes'` (old
 * IE), and the number `1` (old Chrome) — never as a boolean. Anything else,
 * including `'0'`, `'no'`, `0`, `'unspecified'`, `null` and `undefined`, is
 * "not signalled". Reading either signal can also throw outright: a hostile
 * or merely unusual embedding can hand this a `navigator` whose properties
 * are throwing getters, and this function's whole job is to never let that
 * escape — an unreadable signal is treated the same as an absent one, not as
 * a crash and not as a refusal.
 */
function readNavProp<T>(read: () => T): T | undefined {
  try {
    return read()
  } catch {
    return undefined
  }
}

function isDoNotTrackSignal(value: unknown): boolean {
  return value === '1' || value === 'yes' || value === 1
}

function isRefusalSignalled(nav: Navigator | undefined): boolean {
  if (nav === undefined) return false
  if (isDoNotTrackSignal(readNavProp(() => nav.doNotTrack))) return true
  const gpc = readNavProp(
    () => (nav as Navigator & { globalPrivacyControl?: unknown }).globalPrivacyControl,
  )
  return gpc === true
}

/**
 * The gate is opt-in. Tools that advertise "no consent banner needed" earn it
 * by never identifying anyone; Lyraflow stitches identities and keeps person
 * profiles, so the gate is worth shipping — and worth not forcing on someone
 * tracking their own internal tooling. With the gate off, Do Not Track and
 * Global Privacy Control are ignored outright: the integrator has taken that
 * compliance decision themselves, and reading `navigator` at all here would
 * mean this SDK silently overriding it.
 *
 * A refusal CANNOT be remembered, because remembering it means writing the
 * storage the refusal just declined. The host app owns persisting that choice
 * and passing it back on the next load (typically as `requireConsent: false`
 * once they know, or by calling `decide` again before anything is tracked).
 * Any other answer is us deciding that our own bookkeeping does not count as
 * tracking.
 */
export class ConsentGate {
  #state: ConsentState
  #held: QueuedEvent[] = []

  constructor(opts: { required: boolean; nav?: Navigator }) {
    if (!opts.required) {
      this.#state = 'granted'
      return
    }
    // navigator itself can be absent (SSR, a worker, a non-browser embed) —
    // typeof is the only safe way to probe a global that may not exist.
    const nav = opts.nav ?? (typeof navigator === 'undefined' ? undefined : navigator)
    this.#state = isRefusalSignalled(nav) ? 'refused' : 'pending'
  }

  state(): ConsentState {
    return this.#state
  }

  /** True when the caller may touch cookies, storage and the network. */
  allowed(): boolean {
    return this.#state === 'granted'
  }

  /**
   * Held in memory only — the gate being closed is precisely the situation in
   * which this must not touch storage. Bounded the same way the persisted
   * queue is: a page where consent is never granted must not grow without
   * bound either.
   */
  hold(e: QueuedEvent): void {
    this.#held.push(e)
    if (this.#held.length > MAX_HELD_EVENTS) {
      this.#held = this.#held.slice(this.#held.length - MAX_HELD_EVENTS)
    }
  }

  /** Grants or refuses. Returns held events on grant, empty on refusal. */
  decide(granted: boolean): QueuedEvent[] {
    this.#state = granted ? 'granted' : 'refused'
    const released = granted ? this.#held : []
    this.#held = []
    return released
  }
}
