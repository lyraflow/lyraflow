import type { ProjectDeletionRequest } from './deletion-store.js'

export interface ProjectPurgeWorkerOptions {
  claim: (opts: { leaseMs: number; maxAttempts: number }) => Promise<ProjectDeletionRequest | null>
  purge: (projectId: number) => Promise<{ deleted: boolean; remaining: Record<string, number> }>
  complete: (id: number) => Promise<void>
  fail: (id: number, error: string) => Promise<void>
  /** The transient outcome — see `ProjectDeletionStore.defer` and `runOnce`. */
  defer: (id: number, note: string) => Promise<void>
  intervalMs: number
  leaseMs: number
  maxAttempts: number
  onError: (err: unknown, context: { requestId?: number }) => void
}

/**
 * The in-process timer that drives project deletion: claims one queued
 * `project_deletions` row under a lease, tears the project down across
 * ClickHouse and Postgres via `purge`, and marks it complete. Runs
 * unattended, fire-and-forget from `setInterval` — see `runOnce`'s own
 * docstring for why it must never reject.
 *
 * Mirrors `privacy/worker.ts`'s `PurgeWorker` in every structural respect
 * (`#timer` unref'd, `#inFlight` guard, `#stopped` cleared by `start()`,
 * `stop()` not awaiting work in flight). It differs in one place: `purge`
 * can report `deleted: false` when rows reappeared between the teardown and
 * the verify read (a buffered event flushed after its partition was
 * dropped). That outcome is TRANSIENT and has its own path — `defer`, not
 * `fail` — see `runOnce`.
 */
export class ProjectPurgeWorker {
  #timer: NodeJS.Timeout | null = null
  #inFlight = false
  #stopped = false

  constructor(private readonly opts: ProjectPurgeWorkerOptions) {}

  start(): void {
    // #stopped is one-way once set by stop(); clearing it here is what
    // makes a subsequent start() actually resume claiming instead of
    // installing a live interval whose every tick returns 'idle' forever.
    this.#stopped = false
    if (this.#timer) return
    // unref'd: a pending purge tick must never be the reason the process
    // stays alive.
    this.#timer = setInterval(() => void this.runOnce(), this.opts.intervalMs)
    this.#timer.unref()
  }

  /**
   * Synchronous, and deliberately does not await an in-flight purge. A
   * ClickHouse mutation completes server-side whether or not this process is
   * still watching, and `completed_at` is only written on confirmation — so
   * a purge interrupted by shutdown is simply re-claimed after its lease
   * expires, from the top. Awaiting it here would let one large purge blow
   * through the drain deadline and turn a graceful shutdown into a SIGKILL.
   */
  stop(): void {
    this.#stopped = true
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
  }

  /**
   * One claim-and-purge cycle. NEVER REJECTS: it is called fire-and-forget
   * from a timer, so a rejection here becomes an unhandled rejection and
   * takes the process down. Every await is inside `try { await … } catch` —
   * not `p.catch()`, which cannot absorb a synchronous throw from the callee.
   */
  async runOnce(): Promise<'idle' | 'purged' | 'deferred' | 'failed'> {
    if (this.#stopped || this.#inFlight) return 'idle'
    this.#inFlight = true
    let claimed: ProjectDeletionRequest | null = null
    try {
      claimed = await this.opts.claim({
        leaseMs: this.opts.leaseMs,
        maxAttempts: this.opts.maxAttempts,
      })
      if (!claimed) return 'idle'

      const result = await this.opts.purge(claimed.projectId)
      if (!result.deleted) {
        // Rows reappeared between the teardown and the verify read — the
        // buffered-flush shape purge.ts describes. NOT complete(), and NOT
        // fail() either: this is the expected outcome of racing a live
        // install, so it goes to defer(), which releases the lease for the
        // NEXT TICK and gives the attempt back. fail() would hold the lease
        // for its full duration (half an hour by default) and spend one of
        // five attempts on a race that resolves in a second. A purge that
        // THREW is the other thing and still goes to fail(), below.
        const detail = Object.entries(result.remaining)
          .map(([table, n]) => `${table}=${n}`)
          .join(', ')
        await this.opts.defer(claimed.id, `rows reappeared during purge (${detail})`)
        return 'deferred'
      }
      await this.opts.complete(claimed.id)
      return 'purged'
    } catch (err) {
      // Recording the failure must not itself be able to reject, AND must
      // not depend on the caller-supplied `onError` surviving — each call
      // gets its own try/catch, so a throw from either one cannot take out
      // the other or escape here.
      if (claimed) {
        try {
          await this.opts.fail(claimed.id, err instanceof Error ? err.message : String(err))
        } catch {
          /* nothing left to escalate to; the lease will bring the request back */
        }
      }
      try {
        this.opts.onError(err, { requestId: claimed?.id })
      } catch {
        /* the failure is already durably recorded above; a broken logger
           must not be able to reject runOnce() */
      }
      return 'failed'
    } finally {
      this.#inFlight = false
    }
  }
}
