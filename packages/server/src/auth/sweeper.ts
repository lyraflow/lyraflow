/**
 * Housekeeping only, unlike `RetentionWorker`. `SessionStore.verify()`
 * already refuses an expired or over-age row in the same SQL statement that
 * reads it (see sessions.ts's own docstring on that method), so nothing here
 * is a security control -- if this sweeper stops running, no expired session
 * becomes valid, and the table simply grows with dead rows until it runs
 * again. That is why its schedule is a fixed constant rather than a config
 * knob: unlike retention's `intervalMs` (where a wrong value changes how
 * long real customer data survives), a wrong value here only changes how
 * many dead rows sit in Postgres between sweeps.
 */
export const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export interface SessionSweeperOptions {
  sweep: () => Promise<number>
  intervalMs: number
  onError: (err: unknown) => void
}

/**
 * The in-process timer that drives session housekeeping: once per tick,
 * deletes every expired or over-age row via `SessionStore#sweep`. Runs
 * unattended, fire-and-forget from `setInterval` -- see `runOnce`'s own
 * docstring for why it must never reject. Follows `RetentionWorker`'s
 * contract (retention/worker.ts) exactly, including `#invokeHandler`'s
 * handling of an `onError` that itself rejects after its first `await`.
 *
 * `sweep` is injected rather than a `SessionStore` constructed here, for the
 * same reason `RetentionWorker` injects `listProjects`/`dropExpired`: a test
 * can force it to throw -- including synchronously -- without needing a real
 * database to misbehave on cue.
 */
export class SessionSweeper {
  #timer: NodeJS.Timeout | null = null
  #inFlight = false
  #stopped = false

  constructor(private readonly opts: SessionSweeperOptions) {}

  /**
   * Whether a live timer is installed. `false` right after construction --
   * `buildApp` deliberately does not `start()` this (see app.ts's own
   * comment for why: a live timer issuing real DELETEs against the shared
   * test database during unrelated route tests is exactly the cross-file
   * interference the shared-database rule exists to prevent) -- and stays
   * `false` even after a manual `runOnce()`, which never touches `#timer`.
   */
  get running(): boolean {
    return this.#timer !== null
  }

  start(): void {
    // #stopped is one-way once set by stop(); clearing it here is what
    // makes a subsequent start() actually resume sweeping instead of
    // installing a live interval whose every tick is a no-op forever.
    this.#stopped = false
    if (this.#timer) return
    // unref'd: a pending sweep tick must never be the reason the process
    // stays alive.
    this.#timer = setInterval(() => void this.runOnce(), this.opts.intervalMs)
    this.#timer.unref()
  }

  /**
   * Synchronous, and does not await anything -- same reasoning as
   * `RetentionWorker#stop` (retention/worker.ts): it blocks every FUTURE
   * call to `runOnce` (including the next timer tick) immediately, but does
   * not abort a `sweep()` already in flight. There is nothing to gain from
   * abandoning it: a `DELETE` already issued to Postgres completes
   * server-side whether or not this process is still watching.
   */
  stop(): void {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /**
   * One sweep. NEVER REJECTS: it is called fire-and-forget from a timer, so
   * a rejection here becomes an unhandled rejection and takes the process
   * down. Returns the number of rows removed, or `0` on a skipped or failed
   * run -- a caller wanting to distinguish "swept zero rows" from "failed to
   * sweep" has `onError` for the latter.
   */
  async runOnce(): Promise<number> {
    if (this.#stopped || this.#inFlight) return 0
    this.#inFlight = true
    try {
      return await this.opts.sweep()
    } catch (err) {
      this.#invokeHandler(this.opts.onError, err)
      return 0
    } finally {
      this.#inFlight = false
    }
  }

  /**
   * Calls `onError` and makes sure NEITHER a synchronous throw NOR an
   * asynchronous rejection can escape -- identical reasoning and identical
   * implementation to `RetentionWorker#invokeHandler` (retention/worker.ts),
   * whose docstring has the full argument for why a plain `try/catch` alone
   * is not enough for a handler that may be `async`.
   */
  #invokeHandler<Args extends unknown[]>(handler: (...args: Args) => unknown, ...args: Args): void {
    try {
      const result = handler(...args)
      if (result !== null && typeof result === 'object' && 'then' in result) {
        Promise.resolve(result as Promise<unknown>).catch(() => {
          /* an async handler's rejection must not become an unhandled
             rejection -- swallowed the same way a synchronous throw is. */
        })
      }
    } catch {
      /* a synchronous throw from the handler must not be able to reject
         runOnce() or abort whatever loop called this. */
    }
  }
}
