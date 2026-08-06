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

/**
 * Holds accepted events until they can be written in a batch.
 *
 * This is where the `202` durability contract lives: a row is lost only if the
 * process dies without draining. Bounded by maxRows so that a ClickHouse
 * outage produces backpressure rather than an OOM kill, which would lose far
 * more than the requests we reject.
 */
export class IngestBuffer<T> {
  #rows: T[] = []
  #draining = false
  #timer: NodeJS.Timeout
  #inFlight = new Set<Promise<void>>()
  readonly #opts: BufferOptions<T>

  constructor(opts: BufferOptions<T>) {
    this.#opts = opts
    this.#timer = setInterval(() => void this.flush(), opts.flushIntervalMs)
    this.#timer.unref()
  }

  get depth(): number {
    return this.#rows.length
  }

  add(row: T): 'accepted' | 'overloaded' {
    if (this.#draining) return 'overloaded'
    if (this.#rows.length >= this.#opts.maxRows) return 'overloaded'

    this.#rows.push(row)
    if (this.#rows.length >= this.#opts.flushRows) void this.flush()
    return 'accepted'
  }

  async flush(): Promise<void> {
    if (this.#rows.length === 0) return
    const batch = this.#rows
    this.#rows = []

    const task = this.#opts
      .insert(batch)
      .catch((err: unknown) => {
        // Deliberately not re-buffered: a failing insert is usually a failing
        // ClickHouse, and replaying into a full buffer turns one outage into an
        // OOM. The SDK retry queue is the recovery path.
        this.#opts.onError?.(err, batch)
      })
      .finally(() => {
        this.#inFlight.delete(task)
      })

    this.#inFlight.add(task)
    await task
  }

  async drain(deadlineMs: number): Promise<DrainResult> {
    this.#draining = true
    clearInterval(this.#timer)

    const pending = this.#rows.length
    const flushing = this.flush()
    const all = Promise.all([flushing, ...this.#inFlight])
    const timedOut = Symbol('timeout')
    const deadline = new Promise<typeof timedOut>((resolve) => {
      const t = setTimeout(() => resolve(timedOut), deadlineMs)
      t.unref()
    })

    const outcome = await Promise.race([all.then(() => 'done' as const), deadline])
    if (outcome === timedOut) return { flushed: 0, dropped: pending }
    return { flushed: pending, dropped: 0 }
  }
}
