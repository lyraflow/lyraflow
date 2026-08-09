import type { DropResult, RetentionTarget } from './store.js'

export interface RetentionWorkerOptions {
  listProjects: () => Promise<RetentionTarget[]>
  dropExpired: (target: RetentionTarget, now: Date) => Promise<DropResult[]>
  now: () => Date
  intervalMs: number
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
   * the rest, and a broken `onError`/`onRun` handler cannot escape either.
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
      try {
        this.opts.onError(err, {})
      } catch {
        /* a broken onError must not be able to reject runOnce() */
      }
    } finally {
      this.#inFlight = false
    }
  }

  async #runAllProjects(): Promise<void> {
    const now = this.opts.now()
    const targets = await this.opts.listProjects()

    let partitionsDropped = 0
    for (const target of targets) {
      try {
        const results = await this.opts.dropExpired(target, now)
        // Only actual drops count -- a dry-run result reported as a drop
        // would make the metric say work happened when none did.
        partitionsDropped += results.filter((r) => r.dropped).length
      } catch (err) {
        try {
          this.opts.onError(err, { projectId: target.projectId })
        } catch {
          /* the next project must still run; a broken logger must not be
             able to abort the loop or reject runOnce() */
        }
      }
    }

    try {
      this.opts.onRun({ partitionsDropped, at: now })
    } catch {
      /* a broken onRun handler must not be able to reject runOnce() */
    }
  }
}
