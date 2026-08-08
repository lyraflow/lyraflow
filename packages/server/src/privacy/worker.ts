import type { PersonScope } from '../identity/scope.js'
import type { DeletionRequest, DeletionStore } from './deletion-store.js'

export interface PurgeWorkerOptions {
  deletions: DeletionStore
  resolve: (projectId: number, personId: string) => Promise<PersonScope>
  purge: (projectId: number, scope: PersonScope) => Promise<void>
  intervalMs: number
  leaseMs: number
  maxAttempts: number
  onError: (err: unknown, context: { requestId?: number }) => void
}

/**
 * The in-process timer that drives erasure: claims one pending deletion
 * request under a lease, resolves its scope, purges it, and marks it
 * complete. Runs unattended, fire-and-forget from `setInterval` — see
 * `runOnce`'s own docstring for why it must never reject.
 *
 * `resolve` and `purge` are injected rather than constructed here (they wrap
 * `resolvePersonScope` and `purgePerson`) so tests can force either step to
 * throw — including synchronously — without needing a real database to
 * misbehave on cue.
 */
export class PurgeWorker {
  #timer: NodeJS.Timeout | null = null
  #inFlight = false
  #stopped = false

  constructor(private readonly opts: PurgeWorkerOptions) {}

  start(): void {
    if (this.#timer) return
    // unref'd: a pending purge tick must never be the reason the process
    // stays alive.
    this.#timer = setInterval(() => void this.runOnce(), this.opts.intervalMs)
    this.#timer.unref()
  }

  /**
   * Synchronous, and deliberately does not await an in-flight purge. A
   * ClickHouse mutation completes server-side whether or not this process is
   * still watching, and `completed_at` is only written on confirmation — so a
   * purge interrupted by shutdown is simply re-claimed after its lease
   * expires, from the top. Awaiting it here would let one large purge blow
   * through the drain deadline and turn a graceful shutdown into a SIGKILL,
   * losing buffered events — a much larger failure than a delayed purge.
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
   * not `p.catch()`, which cannot absorb a synchronous throw from the callee
   * (a repeat defect in this codebase).
   */
  async runOnce(): Promise<'idle' | 'purged' | 'failed'> {
    if (this.#stopped || this.#inFlight) return 'idle'
    this.#inFlight = true
    let claimed: DeletionRequest | null = null
    try {
      claimed = await this.opts.deletions.claim({
        leaseMs: this.opts.leaseMs,
        maxAttempts: this.opts.maxAttempts,
      })
      if (!claimed) return 'idle'
      const scope = await this.opts.resolve(claimed.projectId, claimed.personId)
      await this.opts.purge(claimed.projectId, scope)
      await this.opts.deletions.complete(claimed.id)
      return 'purged'
    } catch (err) {
      // Reporting the failure must not itself be able to reject.
      try {
        this.opts.onError(err, { requestId: claimed?.id })
        if (claimed) {
          await this.opts.deletions.fail(
            claimed.id,
            err instanceof Error ? err.message : String(err),
          )
        }
      } catch {
        /* nothing left to escalate to; the lease will bring the request back */
      }
      return 'failed'
    } finally {
      this.#inFlight = false
    }
  }
}
