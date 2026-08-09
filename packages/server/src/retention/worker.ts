import type { DropResult, RetentionTarget } from './store.js'

export interface RetentionWorkerOptions {
  listProjects: () => Promise<RetentionTarget[]>
  dropExpired: (target: RetentionTarget, now: Date) => Promise<DropResult[]>
  now: () => Date
  intervalMs: number
  /**
   * `onError`/`onRun` are typed `=> void`, not `=> void | Promise<void>`,
   * but that does not mean an `async` implementation is unsupported: it
   * structurally satisfies `=> void` and is explicitly fine to pass --
   * `#invokeHandler` swallows a rejection the same way it swallows a
   * synchronous throw, so a slow or failing handler here can never take
   * `runOnce()` down with it, whichever way it fails.
   */
  onError: (err: unknown, context: { projectId?: number }) => void
  onRun: (summary: { partitionsDropped: number; at: Date }) => void
}

/**
 * The in-process timer that drives retention: once per tick, reads the clock
 * exactly once, lists every project, and drops each project's expired
 * partitions through `RetentionStore#dropExpired`. Runs unattended,
 * fire-and-forget from `setInterval` -- see `runOnce`'s own docstring for
 * why it must never reject.
 *
 * `listProjects` and `dropExpired` are injected rather than constructed here
 * (they wrap a `RetentionStore`) so tests can force either step to throw --
 * including synchronously -- without needing a real database to misbehave on
 * cue.
 *
 * NO LEASE, unlike `PurgeWorker`. `PurgeWorker` leases because claiming a
 * deletion request is stateful and must not happen twice -- two workers
 * racing the same request would both try to purge the same person. Dropping
 * a partition is idempotent by construction: `ALTER TABLE ... DROP
 * PARTITION` on a partition that is already gone is a no-op (and
 * `expiredPartitions`/`assertDroppable` in `boundary.ts` only ever consider
 * partitions that still exist), so two nodes running this worker against the
 * same project at the same time do redundant work, never conflicting or
 * double-charged work. A lease would add a failure mode (an abandoned lease
 * blocking a legitimate retry) without removing any risk that exists today.
 * A multi-node deployment would still want ONE of these running, not many --
 * running many is merely safe, not free -- but nothing here enforces that;
 * it is a deployment concern, not this class's.
 *
 * `dropExpired` (via `RetentionStore`) is explicitly NOT all-or-nothing
 * across the tables it touches -- a rejection can still mean some partitions
 * were irreversibly dropped before the failure. This worker does not retry a
 * failed project and does not treat "threw" as "nothing happened": it moves
 * on to the next project and reports the failure through `onError`, the same
 * way it would for a project that genuinely had no work to do. Recovery from
 * a partial per-project failure is `RetentionStore`'s contract to keep
 * (idempotent drops), not something this scheduler layers on top of.
 */
export class RetentionWorker {
  #timer: NodeJS.Timeout | null = null
  #inFlight = false
  #stopped = false

  constructor(private readonly opts: RetentionWorkerOptions) {}

  start(): void {
    // #stopped is one-way once set by stop(); clearing it here is what
    // makes a subsequent start() actually resume running ticks instead of
    // installing a live interval whose every tick is a no-op forever.
    this.#stopped = false
    if (this.#timer) return
    // unref'd: a pending retention tick must never be the reason the
    // process stays alive.
    this.#timer = setInterval(() => void this.runOnce(), this.opts.intervalMs)
    this.#timer.unref()
  }

  /**
   * Synchronous, and does not await anything: it blocks every FUTURE call
   * to `runOnce` (including the next timer tick) immediately, and it also
   * bounds an ALREADY-IN-FLIGHT run's remaining work — `#runAllProjects`
   * checks `#stopped` between projects (see its own comment), so a run that
   * has not yet started its next project stops there rather than sweeping
   * every project `listProjects` returned. What it does NOT do is abort a
   * project's `dropExpired` call already in progress: that promise is not
   * cancellable, and there would be nothing to gain from abandoning it —
   * a partition drop already issued to ClickHouse completes server-side
   * whether or not this process is still watching, mirroring
   * `PurgeWorker.stop()`'s identical reasoning. Either way, `stop()` never
   * awaits: it always returns before the in-flight run does, and the run
   * itself completes (or fails) and resets `#inFlight` in its own `finally`
   * on its own time.
   */
  stop(): void {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /**
   * One list-and-drop cycle across every project. NEVER REJECTS: it is
   * called fire-and-forget from a timer, so a rejection here becomes an
   * unhandled rejection and takes the process down. The whole body runs
   * inside a single outer try/catch -- not `.catch()`, which cannot absorb a
   * synchronous throw from `listProjects` or `now` -- and every per-project
   * step gets its own inner try/catch, so one project's failure cannot stop
   * the rest, and a broken `onError`/`onRun` handler cannot escape either --
   * see `#invokeHandler` for why "broken" includes an `async` handler that
   * rejects, not just a synchronous throw.
   *
   * The clock is read exactly ONCE per run, before the project loop starts,
   * and the same `Date` instance is passed to every project's `dropExpired`
   * call. A boundary recomputed per project could straddle a month rollover
   * mid-run: two projects with identical retention would then get different
   * boundaries, a difference that can be a whole month of somebody's data.
   */
  async runOnce(): Promise<void> {
    if (this.#stopped || this.#inFlight) return
    this.#inFlight = true
    try {
      await this.#runAllProjects()
    } catch (err) {
      // listProjects (or now()) itself failed, outside any per-project loop
      // -- not attributable to any one project.
      this.#invokeHandler(this.opts.onError, err, {})
    } finally {
      this.#inFlight = false
    }
  }

  async #runAllProjects(): Promise<void> {
    const now = this.opts.now()
    const targets = await this.opts.listProjects()

    let partitionsDropped = 0
    for (const target of targets) {
      // Checked at the TOP of every iteration, so `stop()` called while a
      // PRIOR project's `dropExpired` is still in flight is honoured before
      // the NEXT project ever starts -- this is what makes `stop()` mean
      // what its name says for a multi-project sweep. It does not, and
      // cannot, abort a project's `dropExpired` call already in progress
      // (that promise is not cancellable, and abandoning it mid-ALTER would
      // not un-issue a command ClickHouse has already accepted) -- see
      // Guard 5's `onDrop` (store.ts, wired in app.ts) for what actually
      // bounds the exposure of an in-flight project: each partition it
      // drops is logged the instant that drop happens, not after the whole
      // project finishes, so stopping mid-project loses no record even
      // though it cannot stop the drop itself.
      if (this.#stopped) break
      try {
        const results = await this.opts.dropExpired(target, now)
        // Only actual drops count -- a dry-run result reported as a drop
        // would make the metric say work happened when none did.
        partitionsDropped += results.filter((r) => r.dropped).length
      } catch (err) {
        this.#invokeHandler(this.opts.onError, err, { projectId: target.projectId })
      }
    }

    this.#invokeHandler(this.opts.onRun, { partitionsDropped, at: now })
  }

  /**
   * Calls a caller-supplied handler (`onError` or `onRun`) and makes sure
   * NEITHER a synchronous throw NOR an asynchronous rejection can escape.
   *
   * Both handlers are typed `=> void` in `RetentionWorkerOptions`, but that
   * is a structural TypeScript type: an `async` function returning
   * `Promise<void>` satisfies it fine, and nothing stops a caller from
   * passing one -- a metrics counter is a very plausible `async` `onRun`. A
   * plain `try { handler() } catch {}` only catches a throw that happens
   * BEFORE the handler's first `await`; a rejection raised after that point
   * arrives on a promise this method already returned from and never
   * inspected, which is the exact "runOnce must never reject" failure
   * `runOnce`'s own try/catch exists to prevent, merely relocated one tick
   * later into an unhandled rejection instead. Confirmed live: an `onRun`
   * that awaits 5ms and then throws lets `runOnce()` resolve cleanly while
   * the process still emits `unhandledRejection`.
   *
   * A handler may be sync or async; either way, a throw or a rejection from
   * it is swallowed here the same way, never re-thrown. Neither this method
   * nor its caller waits for an async handler to settle -- onError/onRun are
   * fire-and-forget notifications, not steps in the retention work itself,
   * so a slow handler must not be able to hold up the next project or the
   * next tick.
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
