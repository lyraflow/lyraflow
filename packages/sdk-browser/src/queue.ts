import type { QueuedEvent } from './payload.js'

export const MAX_QUEUE_EVENTS = 500
export const MAX_EVENT_AGE_MS = 23 * 60 * 60 * 1000
export const STORAGE_KEY = 'lyraflow_queue'

/**
 * Storage is adversarial as well as unreliable: it can throw on read or
 * write, be disabled outright, or hand back anything JSON-shaped — corrupt
 * text, valid JSON that isn't an array, an array of nulls, a bare object
 * where an event should be. Every storage access goes through these two.
 * Neither can throw, and neither can hand #prune anything that would throw
 * when it reads `.timestamp` off it (a null or primitive array element
 * would — property access on null/undefined always throws), so this also
 * filters the parsed array down to non-null objects before it goes further.
 */
function readStore(): QueuedEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((e): e is QueuedEvent => typeof e === 'object' && e !== null)
  } catch {
    return []
  }
}

function writeStore(events: QueuedEvent[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events))
  } catch {
    // Quota, private mode, or storage disabled. Degrade to memory-only.
  }
}

export class EventQueue {
  #events: QueuedEvent[]
  #persist: boolean
  #expired = 0

  constructor(opts: { persist?: boolean } = {}) {
    this.#persist = opts.persist ?? true
    this.#events = this.#persist ? readStore() : []
    this.#prune()
  }

  /**
   * Age cap first, then size cap. Both are enforced on every mutation rather
   * than on a timer, because an unbounded client queue is its own outage.
   *
   * A stored event's `timestamp` can be any string once storage is treated
   * as adversarial (readStore only guarantees "non-null object", not a valid
   * date) — `Date.parse` on garbage yields `NaN`, which fails the `>=`
   * comparison and drops the event as expired rather than throwing. That's
   * an acceptable outcome for data this SDK didn't recognise the shape of.
   */
  #prune(): void {
    const cutoff = Date.now() - MAX_EVENT_AGE_MS
    const kept = this.#events.filter((e) => Date.parse(e.timestamp) >= cutoff)
    this.#expired += this.#events.length - kept.length
    this.#events =
      kept.length > MAX_QUEUE_EVENTS ? kept.slice(kept.length - MAX_QUEUE_EVENTS) : kept
  }

  #flushStore(): void {
    if (this.#persist) writeStore(this.#events)
  }

  add(e: QueuedEvent): void {
    this.#events.push(e)
    this.#prune()
    this.#flushStore()
  }

  /** Up to `n` events, oldest first, still in the queue until `remove`. */
  peek(n: number): QueuedEvent[] {
    this.#prune()
    return this.#events.slice(0, n)
  }

  remove(messageIds: string[]): void {
    const sent = new Set(messageIds)
    this.#events = this.#events.filter((e) => !sent.has(e.message_id))
    this.#flushStore()
  }

  size(): number {
    this.#prune()
    return this.#events.length
  }

  /** Events dropped for age, since construction. Debug signal only. */
  expiredCount(): number {
    return this.#expired
  }
}
