export interface DrainResult {
  flushed: number
  dropped: number
}

export interface BufferOptions<T> {
  flushRows: number
  flushIntervalMs: number
  maxRows: number
  insert: (rows: T[]) => Promise<void>
  onError?: (err: unknown, rows: T[]) => void
}

type BatchOutcome = 'flushed' | 'dropped'

interface InFlightBatch<T> {
  rows: T[]
  /** Resolves once this batch's insert has settled — successfully or not. */
  settled: Promise<BatchOutcome>
}

/**
 * Holds accepted events until they can be written in a batch.
 *
 * This is where the `202` durability contract lives: a row is lost only if the
 * process dies without draining. `maxRows` bounds the *total* memory the
 * buffer is holding — rows still queued plus rows already handed to a batch
 * whose insert hasn't settled yet — so that a ClickHouse outage produces
 * backpressure rather than an OOM kill, which would lose far more than the
 * requests we reject.
 */
export class IngestBuffer<T> {
  #rows: T[] = []
  #draining = false
  #timer: NodeJS.Timeout
  #inFlight = new Set<InFlightBatch<T>>()
  readonly #opts: BufferOptions<T>

  constructor(opts: BufferOptions<T>) {
    this.#opts = opts
    this.#timer = setInterval(() => void this.#flushBatch(), opts.flushIntervalMs)
    this.#timer.unref()
  }

  /** Total rows the buffer is holding: queued plus not-yet-settled in-flight batches. */
  get depth(): number {
    return this.#rows.length + this.#inFlightRowCount()
  }

  #inFlightRowCount(): number {
    let total = 0
    for (const batch of this.#inFlight) total += batch.rows.length
    return total
  }

  add(row: T): 'accepted' | 'overloaded' {
    if (this.#draining) return 'overloaded'
    // Bound total memory held, not just what's still queued: a batch that
    // has detached into #inFlight because ClickHouse is slow still holds
    // real rows in memory until its insert settles.
    if (this.#rows.length + this.#inFlightRowCount() >= this.#opts.maxRows) return 'overloaded'

    this.#rows.push(row)
    if (this.#rows.length >= this.#opts.flushRows) void this.#flushBatch()
    return 'accepted'
  }

  async flush(): Promise<void> {
    await this.#flushBatch()
  }

  /**
   * Moves whatever is queued into a new in-flight batch and inserts it.
   *
   * `onRecord`, if given, is invoked synchronously right after the batch is
   * registered in `#inFlight` — before `insert()` is awaited — so a caller
   * (namely `drain`) can hold on to the batch's settlement signal even if
   * `insert` throws synchronously and the batch removes itself from
   * `#inFlight` before control returns to that caller.
   */
  async #flushBatch(onRecord?: (record: InFlightBatch<T>) => void): Promise<void> {
    if (this.#rows.length === 0) return
    const batch = this.#rows
    this.#rows = []

    let resolveSettled!: (outcome: BatchOutcome) => void
    const settled = new Promise<BatchOutcome>((resolve) => {
      resolveSettled = resolve
    })
    const record: InFlightBatch<T> = { rows: batch, settled }
    this.#inFlight.add(record)
    onRecord?.(record)

    try {
      // Calling insert() directly here — rather than chaining .catch() off
      // its return value — means a synchronous throw (a closed client, a
      // malformed row) is caught by this try too, not just a rejected
      // promise. Left unguarded, that throw would escape #flushBatch as an
      // unhandled rejection from the fire-and-forget `void` callers below
      // and could take the whole process down with it.
      await this.#opts.insert(batch)
      resolveSettled('flushed')
    } catch (err) {
      // Resolve the settlement signal before doing anything else that could
      // itself throw: drain()'s accounting must never depend on onError
      // behaving well.
      resolveSettled('dropped')
      try {
        // Deliberately not re-buffered: a failing insert is usually a
        // failing ClickHouse, and replaying into a full buffer turns one
        // outage into an OOM. The SDK retry queue is the recovery path.
        this.#opts.onError?.(err, batch)
      } catch {
        // A throwing onError must not crash the process via an unhandled
        // rejection from a fire-and-forget flush — that's a bug in the
        // caller's error handler, not a reason to lose the durability
        // guarantee.
      }
    } finally {
      this.#inFlight.delete(record)
    }
  }

  async drain(deadlineMs: number): Promise<DrainResult> {
    this.#draining = true
    clearInterval(this.#timer)

    // Flush whatever is still queued so every row the buffer holds — queued
    // or already in flight — ends up represented as an InFlightBatch we can
    // wait on below, alongside any batch that was already mid-flight before
    // drain() was called.
    let finalRecord: InFlightBatch<T> | undefined
    void this.#flushBatch((record) => {
      finalRecord = record
    })

    const batches = new Set(this.#inFlight)
    if (finalRecord) batches.add(finalRecord)

    const timedOut = Symbol('timeout')
    const deadline = new Promise<typeof timedOut>((resolve) => {
      const t = setTimeout(() => resolve(timedOut), deadlineMs)
      t.unref()
    })

    let flushed = 0
    let dropped = 0

    await Promise.all(
      [...batches].map(async (batch) => {
        const outcome = await Promise.race([batch.settled, deadline])
        // A batch that hasn't settled by the deadline, and a batch whose
        // insert rejected, both failed to reach ClickHouse — both count as
        // dropped, not flushed.
        if (outcome === 'flushed') flushed += batch.rows.length
        else dropped += batch.rows.length
      }),
    )

    return { flushed, dropped }
  }
}
