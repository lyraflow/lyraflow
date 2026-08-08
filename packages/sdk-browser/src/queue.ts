import type { QueuedEvent } from './payload.js'

export const MAX_QUEUE_EVENTS = 500
/**
 * The ingest clamps a client timestamp more than `MAX_CLOCK_SKEW_MS` (24h,
 * `packages/core/src/ingest/timestamp.ts`) from server time, in EITHER
 * direction. This value is that skew minus a one-hour margin, so an event
 * cannot cross the clamp line while it's sitting in this queue. The margin
 * is pinned in queue.test.ts against core's own constant — see the test
 * named for it before changing this number.
 */
export const MAX_EVENT_AGE_MS = 23 * 60 * 60 * 1000
export const STORAGE_KEY = 'lyraflow_queue'

/**
 * `e` came from `JSON.parse` on adversarial storage, so it can be anything
 * JSON-shaped: corrupt text (handled by the caller's try/catch), valid JSON
 * that isn't an array, an array of nulls, a bare object, or an object that
 * merely resembles an event. This is the full contract for "resembles an
 * event enough to be treated as one":
 *
 *  - a non-null object (a null or primitive element would throw when
 *    `#prune` reads `.timestamp` off it — property access on null/undefined
 *    always throws)
 *  - a string `message_id` (this is the only field `remove()` matches
 *    against; a missing or non-string one is silently unremovable forever —
 *    an object `message_id`, since `Set.has` compares by reference, would
 *    never equal anything a real caller passes to `remove()`)
 *  - a `timestamp` that actually parses (anything else is indistinguishable
 *    from corruption, and `#prune`'s age math needs a real instant)
 */
function isQueuedEventShape(e: unknown): e is QueuedEvent {
  if (typeof e !== 'object' || e === null) return false
  const candidate = e as Record<string, unknown>
  return (
    typeof candidate.message_id === 'string' &&
    typeof candidate.timestamp === 'string' &&
    !Number.isNaN(Date.parse(candidate.timestamp))
  )
}

/** Every storage access goes through these two. Neither can throw. */
function readStore(): QueuedEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isQueuedEventShape)
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
  #corrupt = 0

  constructor(opts: { persist?: boolean } = {}) {
    this.#persist = opts.persist ?? true
    this.#events = this.#persist ? readStore() : []
    this.#prune()
  }

  /**
   * Age cap first, then size cap. Both are enforced on every mutation rather
   * than on a timer, because an unbounded client queue is its own outage.
   *
   * The age cap is symmetric: it drops events more than `MAX_EVENT_AGE_MS`
   * either behind OR ahead of now. The ingest clamps both directions, and
   * the future side is the WORSE half to miss — a too-old event ages out of
   * this cap and stops being retried, but a too-future event's timestamp
   * only gets closer to valid as real time passes, so it can sit at the
   * head of the queue indefinitely, get clamped to a different instant on
   * every send, and land as a permanent extra row each time (the
   * `ReplacingMergeTree` merge key is the timestamp, so replays that keep
   * landing on a different clamped instant never collapse). A device clock
   * running days fast is the ordinary way there: events queue with
   * future timestamps, then NTP corrects the clock and time no longer
   * catches up to them within the skew window on its own.
   *
   * What this does NOT catch: a uniformly skewed clock, where every
   * timestamp this SDK stamps is off by the same fixed offset. `Date.now()`
   * is skewed identically in that case, so nothing client-side can tell the
   * difference — that class of error belongs to the server's clamp, not
   * this cap. This one catches the clock-was-corrected, tampered-storage,
   * and DST-jump cases, which is most of what's actually reachable, for one
   * extra comparison.
   *
   * By construction (`isQueuedEventShape`), every event reaching this
   * method already has a `timestamp` that parsed once, at read time — but
   * an event added directly via `add()` at runtime isn't filtered through
   * that gate, so a caller ignoring the `QueuedEvent` type can still hand
   * this an unparseable timestamp. `Date.parse` on it yields `NaN`, which
   * fails both comparisons below; that's counted separately from the age
   * drops (`#corrupt`, not `#expired`) because it's a different failure —
   * a debug signal that reads "40 corrupt" should not look identical to
   * "40 expired".
   */
  #prune(): void {
    const now = Date.now()
    const cutoff = now - MAX_EVENT_AGE_MS
    const futureCutoff = now + MAX_EVENT_AGE_MS
    const kept: QueuedEvent[] = []
    for (const e of this.#events) {
      const t = Date.parse(e.timestamp)
      if (Number.isNaN(t)) {
        this.#corrupt += 1
      } else if (t < cutoff || t > futureCutoff) {
        this.#expired += 1
      } else {
        kept.push(e)
      }
    }
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

  /**
   * Events dropped for being outside the plausible age window — too old, OR
   * timestamped implausibly far in the future — since construction. Debug
   * signal only.
   */
  expiredCount(): number {
    return this.#expired
  }

  /**
   * Events dropped because their timestamp didn't parse at all, since
   * construction. Kept apart from `expiredCount()` so a developer looking
   * at a nonzero number knows whether to suspect an old queue or corrupt
   * data — see `#prune`. Debug signal only.
   */
  corruptCount(): number {
    return this.#corrupt
  }
}
