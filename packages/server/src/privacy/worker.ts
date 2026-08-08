import type { PersonScope } from '../identity/scope.js'
import type { DeletionRequest, DeletionStore } from './deletion-store.js'

export interface PurgeWorkerOptions {
  deletions: DeletionStore
  /**
   * `restrictTo` is the id set recorded when the request was accepted; it
   * becomes `resolvePersonScope`'s ceiling on the resolved group. See
   * `runOnce` for why it is `undefined` rather than `[]` when the request
   * carries no set.
   */
  resolve: (
    projectId: number,
    personId: string,
    restrictTo: string[] | undefined,
  ) => Promise<PersonScope>
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
      // Still re-resolved FRESH from Postgres, deliberately — a device bound
      // to this person between the `202` and now legitimately belongs to them
      // and has to be erased. What the recorded id set adds is a ceiling: the
      // resolved group is intersected against it, so an `/v1/alias` landing
      // in that same window cannot pull an uninvolved person's ids, devices
      // and windows into the purge. The purge may narrow, never widen.
      //
      // `undefined`, not `[]`, when the request carries no set: an empty
      // array is what rows written before 009_deletion_request_ids.sql carry,
      // and it means "unrestricted". That migration's own comment is where
      // the decision is argued in full.
      //
      // BELT-AND-BRACES, not the guarantee. `resolvePersonScope` treats an
      // empty ceiling as no ceiling itself (see its `restrictTo?.length`), so
      // deleting this ternary does not reopen the hole. It stays because the
      // intent reads better at the call site than it does as an absence, and
      // because "unrestricted" is a claim this caller is making, not one it
      // is inheriting.
      const scope = await this.opts.resolve(
        claimed.projectId,
        claimed.personId,
        claimed.personIds.length > 0 ? claimed.personIds : undefined,
      )
      await this.opts.purge(claimed.projectId, scope)
      await this.opts.deletions.complete(claimed.id)
      return 'purged'
    } catch (err) {
      // Recording the failure must not itself be able to reject, AND must
      // not depend on the caller-supplied `onError` surviving: it used to
      // run before `fail()`, so a throwing logger left `completed_at` and
      // `last_error` BOTH null — indistinguishable from "still pending" on
      // the status endpoint, and permanent once `attempts` hits the cap.
      // `fail()` goes first now, and each call gets its own try/catch, so a
      // throw from either one cannot take out the other or escape here.
      if (claimed) {
        try {
          await this.opts.deletions.fail(
            claimed.id,
            err instanceof Error ? err.message : String(err),
          )
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
