import type { EventQueue } from './queue.js'

export const BATCH_SIZE = 20
export const FLUSH_INTERVAL_MS = 5_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_MAX_MS = 30_000
/**
 * A ceiling on a server-advised `retry-after`. The real ingest only ever
 * sends `5` — both its draining and batch-overload paths
 * (packages/server/src/ingest/routes.ts) hardcode `retry-after: 5`. This
 * exists so a malformed or hostile header (a stray extra digit, something
 * between the SDK and the ingest rewriting it) cannot switch retrying off
 * for days by being merely a very large, otherwise-well-formed number — the
 * one shape `Number.isFinite` alone would wave straight through. It never
 * bites a well-behaved server.
 */
const MAX_HONOURED_RETRY_AFTER_MS = 5 * 60_000
/**
 * Shared by both quota paths — the `429` a proxy in front of the ingest may
 * return, and the `over_quota` tally `/v1/batch` reports inside its `202`.
 * One string, because the developer-facing fact is identical in both cases
 * and a second phrasing would cost bundle bytes to say the same thing twice.
 *
 * It names the condition rather than the status code on purpose: "the server
 * rejected a batch with 429" tells a developer nothing they can act on,
 * whereas this tells them their operator has to raise
 * `projects.monthly_event_quota` or wait for the month to roll over.
 */
const QUOTA_NOTICE =
  'this project is over its monthly event quota; events will be refused until the month rolls over'

export type SendOutcome = 'sent' | 'retry' | 'dropped' | 'stopped'

export class Transport {
  #opts: {
    host: string
    writeKey: string
    queue: EventQueue
    warn: (message: string) => void
    fetchImpl: typeof fetch
  }
  #timer: ReturnType<typeof setInterval> | null = null
  #onHide: (() => void) | null = null
  #onVisibility: (() => void) | null = null
  #stopped = false
  #inFlight = false
  #failures = 0
  #nextAttemptAt = 0

  constructor(opts: {
    host: string
    writeKey: string
    queue: EventQueue
    warn: (message: string) => void
    fetchImpl?: typeof fetch
  }) {
    this.#opts = { ...opts, fetchImpl: opts.fetchImpl ?? globalThis.fetch.bind(globalThis) }
  }

  isStopped(): boolean {
    return this.#stopped
  }

  /**
   * Idempotent: a second call while already running is a no-op. Without
   * that guard, a caller that invokes `start()` defensively (e.g. on every
   * SPA route change) would accumulate a fresh `setInterval` and a fresh
   * pair of `pagehide`/`visibilitychange` listeners on every call, none of
   * which `stop()` could ever fully undo.
   *
   * The two listeners are deliberately NOT symmetric in how they call
   * flush. `visibilitychange` fires every time a tab is backgrounded —
   * switching tabs, minimising, a mobile OS suspending the app — which is
   * common and is not a reliable signal the page is actually going away, so
   * it runs an ordinary, backoff-respecting flush. `pagehide` is a much
   * stronger unload signal and may be the last chance this visitor's data
   * ever gets to leave the browser, so it bypasses an active backoff once
   * (see the `bypassBackoff` parameter on `#run`). Bypassing backoff on
   * `visibilitychange` too would let a visitor who merely alt-tabs during a
   * server-side outage re-hammer the server on every tab switch — exactly
   * what the backoff exists to prevent.
   */
  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS)
    this.#onHide = () => void this.#run(true)
    this.#onVisibility = () => {
      if (document.visibilityState === 'hidden') void this.flush()
    }
    addEventListener('pagehide', this.#onHide)
    addEventListener('visibilitychange', this.#onVisibility)
  }

  /**
   * Undoes exactly what `start()` added, including the two listeners. Only
   * clearing the timer here (leaving the listeners attached) would mean a
   * page that calls `stop()` keeps firing `flush()` from `pagehide` and
   * `visibilitychange` forever, and a later `start()` would layer a second
   * pair of listeners on top of the still-live first pair.
   */
  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    if (this.#onHide) removeEventListener('pagehide', this.#onHide)
    if (this.#onVisibility) removeEventListener('visibilitychange', this.#onVisibility)
    this.#onHide = null
    this.#onVisibility = null
  }

  /**
   * NEVER REJECTS — the whole call, not just the network leg. Called
   * fire-and-forget from a timer and from pagehide/visibilitychange, so a
   * rejection anywhere inside is an unhandled rejection inside the
   * customer's page, and on the unload path it lands exactly where their
   * own error reporting will attribute it to us.
   */
  async flush(): Promise<SendOutcome> {
    return this.#run(false)
  }

  /**
   * `bypassBackoff` is true only for the `pagehide` listener in `start()` —
   * see its docstring for why `visibilitychange` does not get the same
   * treatment. Everything else about a bypassed run is identical: it still
   * respects `#stopped` and the in-flight guard, and a failed attempt still
   * recomputes a fresh backoff for whatever comes next.
   *
   * The in-flight guard exists because `remove()` only happens after the
   * response comes back: without it, a second `flush()` arriving while one
   * is still awaiting `fetchImpl` (a keepalive POST outliving the 5s
   * interval, or a pagehide flush racing the timer) would `peek()` the same
   * unremoved events and send them again. The ingest dedupes by
   * `message_id` → `event_id`, so a duplicate send costs bandwidth rather
   * than correctness, but there is no reason to pay for it.
   */
  async #run(bypassBackoff: boolean): Promise<SendOutcome> {
    if (this.#stopped) return 'stopped'
    if (!bypassBackoff && Date.now() < this.#nextAttemptAt) return 'retry'
    if (this.#inFlight) return 'retry'

    this.#inFlight = true
    try {
      return await this.#attempt()
    } catch {
      // A catch-all for anything not already handled inside #attempt:
      // queue.peek, any of the three queue.remove calls, or the
      // host-supplied `warn` callback throwing. None of those are
      // hypothetical — `warn` is wired by the caller (Task 8), and
      // `message_id` is read off events that this very file has already
      // established can carry throwing getters on other properties.
      return 'retry'
    } finally {
      this.#inFlight = false
    }
  }

  async #attempt(): Promise<SendOutcome> {
    const batch = this.#opts.queue.peek(BATCH_SIZE)
    if (batch.length === 0) return 'sent'

    // Serialise BEFORE the try that handles network failure, so an
    // unserialisable event is discarded rather than retried. Left inside
    // that try, a throwing getter looks identical to a network error, and
    // the same poison event returns to the head of the queue on every
    // flush — blocking every healthy event behind it, forever, with
    // nothing reporting it.
    let body: string
    try {
      body = JSON.stringify({ batch })
    } catch {
      // At least one event in this batch can't be converted to JSON.
      // Isolate exactly which one(s) with a per-event JSON.stringify each,
      // and drop only those — dropping the WHOLE batch here would silently
      // destroy every healthy event sitting next to the poison one too,
      // which is barely better than the wedge this exists to prevent. This
      // flush ends here with no network attempt for the survivors; the next
      // flush (timer tick or pagehide) re-peeks the now-clean queue and
      // sends them normally.
      const poisoned: string[] = []
      for (const e of batch) {
        try {
          JSON.stringify(e)
        } catch {
          poisoned.push(e.message_id)
        }
      }
      // poisoned can legitimately come back empty: the whole-batch
      // stringify can fail for a reason no single element reproduces alone
      // (e.g. a getter that only throws on a second read). Fall back to
      // dropping the whole batch rather than looping with nothing removed.
      const toDrop = poisoned.length > 0 ? poisoned : batch.map((e) => e.message_id)
      this.#opts.queue.remove(toDrop)
      this.#opts.warn(
        poisoned.length > 0
          ? `${poisoned.length} event(s) could not be serialised and were dropped; a property getter threw`
          : 'a batch could not be serialised and was dropped',
      )
      return 'dropped'
    }

    let res: Response
    try {
      res = await this.#opts.fetchImpl(`${this.#opts.host}/v1/batch`, {
        method: 'POST',
        keepalive: true,
        headers: {
          'content-type': 'application/json',
          'x-lyraflow-write-key': this.#opts.writeKey,
        },
        body,
      })
    } catch {
      this.#backoff()
      return 'retry'
    }

    // `res` came back through an injected fetchImpl, which a test — or a
    // browser extension shimming `fetch` in production — can hand back
    // anything. Reading `.status` off something that isn't Response-shaped
    // must fail the same way a network error does, not crash the caller.
    let status: number
    try {
      status = res.status
    } catch {
      this.#backoff()
      return 'retry'
    }
    if (!Number.isFinite(status)) {
      this.#backoff()
      return 'retry'
    }

    if (status === 202) {
      this.#opts.queue.remove(batch.map((e) => e.message_id))
      this.#failures = 0
      this.#nextAttemptAt = 0
      await this.#reportBody(res)
      return 'sent'
    }
    if (status === 401) {
      // The key is wrong; retrying forever hammers somebody's server for
      // nothing and will never succeed.
      this.#stopped = true
      this.stop()
      this.#opts.warn('the write key was rejected; no further events will be sent')
      return 'stopped'
    }
    // `429` joins the drop branch, and must NOT reach `#backoff` below.
    // A quota refusal is not transient: it holds until the month rolls over
    // or an operator raises the limit, so no amount of backing off makes the
    // next attempt succeed. Left to fall through, every instrumented browser
    // would retry the same batch for the remainder of the month — the queue
    // never draining, `localStorage` growing for the life of the tab.
    //
    // The real ingest does not produce it: `/v1/batch` (the only URL this
    // transport posts to) answers `202` with `over_quota` in the body, which
    // `#reportBody` handles. This branch is for whatever sits in front of the
    // ingest — a reverse proxy, a CDN, an API gateway with its own rate
    // limiting — because an unhandled `429` retries forever whatever emitted
    // it.
    if (status === 400 || status === 413 || status === 429) {
      this.#opts.queue.remove(batch.map((e) => e.message_id))
      this.#opts.warn(
        status === 429
          ? QUOTA_NOTICE
          : `the server rejected a batch with ${status}; retrying would not help, so it was dropped`,
      )
      return 'dropped'
    }

    // Read AFTER the status decision above, and guarded independently of
    // it: a Response whose `.headers.get` throws must still let a
    // 202/401/400/413/429 verdict stand on the status alone. Folding this read
    // into the same try as the status read would turn a perfectly good 401
    // into a mis-classified 'retry' whenever the headers object is
    // hostile — exactly the response shape a network intermediary or a
    // broken fetch polyfill can hand back.
    let retryAfter: string | null = null
    try {
      retryAfter = res.headers.get('retry-after')
    } catch {
      retryAfter = null
    }
    this.#backoff(retryAfter)
    return 'retry'
  }

  /**
   * `/v1/batch` answers `202` with `{accepted, rejected, throttled, over_quota}`
   * even when it stored nothing — the ingest never fails a batch over one bad
   * event. This body is the SDK's ONLY feedback channel, and it was being
   * thrown away: a batch that came back `{accepted: 0, rejected: 1}` was
   * treated as fully delivered and every event in it removed, in silence.
   *
   * `over_quota` is the same bug one field over, and it is the one the server
   * actually produces for a refused batch. `/v1/batch` never answers `429` —
   * a batch entirely over quota comes back
   * `202 {"accepted":0,"rejected":0,"throttled":0,"over_quota":2}`, so reading
   * `rejected` alone left the developer told nothing at all while every event
   * was removed. Its own operator has to act (raise the quota, or wait for the
   * month), and nothing else in the browser can tell them to.
   *
   * Reported AFTER the removal, never instead of it: neither `rejected` nor
   * `over_quota` will be taken on a retry either, so keeping them would only
   * wedge the queue. The developer gets told; the queue drains.
   *
   * Everything here is best-effort. A response with no JSON body, a `json()`
   * that throws, a shimmed `fetch` handing back a plain object — none of that
   * may turn a successful send into a failure. That includes a `warn` the host
   * supplied that throws: the catch below swallows it, exactly as the outer
   * catch in `#run` does for the other warn call sites.
   */
  async #reportBody(res: Response): Promise<void> {
    try {
      const body = (await res.json()) as { rejected?: unknown; over_quota?: unknown } | null
      const rejected = body?.rejected
      if (typeof rejected === 'number' && rejected > 0) {
        this.#opts.warn(
          `the server rejected ${rejected} event(s) in a batch it accepted; retrying would not help, so they were dropped`,
        )
      }
      const overQuota = body?.over_quota
      if (typeof overQuota === 'number' && overQuota > 0) {
        this.#opts.warn(`${overQuota} event(s) were dropped: ${QUOTA_NOTICE}`)
      }
    } catch {
      // No body, not JSON, or already consumed. Nothing to report.
    }
  }

  #backoff(retryAfter?: string | null): void {
    this.#failures += 1
    const advisedSeconds = retryAfter ? Number(retryAfter) : Number.NaN
    const advisedMs = advisedSeconds * 1000
    const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (this.#failures - 1), BACKOFF_MAX_MS)
    const jitter = exponential * 0.2 * Math.random()
    // Floored at BACKOFF_BASE_MS, matching the intent of the ceiling above:
    // a server advising `retry-after: 0` (or a negative value) must not be
    // able to switch the client's own throttle off entirely.
    const delay = Number.isFinite(advisedMs)
      ? Math.min(Math.max(advisedMs, BACKOFF_BASE_MS), MAX_HONOURED_RETRY_AFTER_MS)
      : exponential + jitter
    this.#nextAttemptAt = Date.now() + delay
  }
}
