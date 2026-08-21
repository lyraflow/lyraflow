import type { Pool } from '@lyraflow/db'

export interface ProjectDeletionRequest {
  id: number
  projectId: number
  slug: string
  name: string
  requestedAt: Date
  claimedAt: Date | null
  completedAt: Date | null
  attempts: number
  lastError: string | null
}

interface Row {
  id: string
  project_id: string
  slug: string
  name: string
  requested_at: Date
  claimed_at: Date | null
  completed_at: Date | null
  attempts: number
  last_error: string | null
}

function toRequest(row: Row): ProjectDeletionRequest {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    slug: row.slug,
    name: row.name,
    requestedAt: row.requested_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    attempts: row.attempts,
    lastError: row.last_error,
  }
}

/** Same bound, and for the same reason, as `DeletionStore`'s: `last_error`
 * carries a caught exception's message and is re-read by the status endpoint
 * on every poll. */
const MAX_LAST_ERROR_LENGTH = 2000

/**
 * THE `requested_at` PREDICATE IS THE CACHE-HORIZON GUARD, NOT A NICETY.
 * See `purgeClaimDelayMs` (config.ts) for the window it enforces and why a
 * purge that starts inside it recreates the orphaned-project state this
 * feature exists to prevent. It lives in SQL, in BOTH claim statements,
 * because that is the only place every claimer passes through: the server's
 * worker, a second app process, and a CLI invocation talking to Postgres
 * with no server running at all. A check in any one caller is a check the
 * other two do not make.
 */
const CLAIM_SQL = `
  UPDATE project_deletions
     SET claimed_at = now(), attempts = attempts + 1
   WHERE id = (
     SELECT id FROM project_deletions
      WHERE completed_at IS NULL
        AND attempts < $1
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $2))
        AND requested_at <= now() - make_interval(secs => $3)
      ORDER BY requested_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
   RETURNING *`

/** `CLAIM_SQL`'s sibling for `claimById` -- same guards (not completed, under
 * `maxAttempts`, not currently leased, past the cache horizon), scoped to one
 * id instead of picking the oldest candidate. No `ORDER BY`/`LIMIT`: `id` is
 * the primary key, so the inner SELECT matches at most one row already. */
const CLAIM_BY_ID_SQL = `
  UPDATE project_deletions
     SET claimed_at = now(), attempts = attempts + 1
   WHERE id = (
     SELECT id FROM project_deletions
      WHERE id = $1
        AND completed_at IS NULL
        AND attempts < $2
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $3))
        AND requested_at <= now() - make_interval(secs => $4)
      FOR UPDATE SKIP LOCKED
   )
   RETURNING *`

/**
 * The Postgres-backed queue behind project deletion: stamps a project as
 * deleting and files its purge request atomically, reads a request's
 * status, and hands one claimable request to a purge worker under a lease.
 */
export class ProjectDeletionStore {
  constructor(private readonly pool: Pool) {}

  /**
   * The `deleting_at` stamp and the queue row, together or neither.
   *
   * Split them and a crash between the two gives either a project marked for
   * deletion that nothing will ever drain, or a queued purge of a project
   * still accepting events. Neither is recoverable by retry once the route
   * has answered 202.
   *
   * The UPDATE's own `WHERE deleting_at IS NULL` is what makes a concurrent
   * second request lose rather than queue a duplicate: the loser's UPDATE
   * matches no row.
   */
  async request(
    projectId: number,
  ): Promise<{ id: number } | 'not_found' | { alreadyDeleting: number }> {
    const client = await this.pool.connect()
    // Set only if ROLLBACK itself fails, below, and passed to
    // `client.release()` in `finally` — see that catch block for why.
    let releaseErr: Error | undefined
    try {
      await client.query('BEGIN')
      const updated = await client.query<{ slug: string; name: string }>(
        `UPDATE projects SET deleting_at = now()
          WHERE id = $1 AND deleting_at IS NULL
      RETURNING slug, name`,
        [projectId],
      )
      const row = updated.rows[0]
      if (!row) {
        await client.query('ROLLBACK')
        const existing = await this.pool.query<{ id: string }>(
          `SELECT id FROM project_deletions
            WHERE project_id = $1 AND completed_at IS NULL
            ORDER BY requested_at LIMIT 1`,
          [projectId],
        )
        const found = existing.rows[0]
        return found ? { alreadyDeleting: Number(found.id) } : 'not_found'
      }
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO project_deletions (project_id, slug, name) VALUES ($1, $2, $3) RETURNING id',
        [projectId, row.slug, row.name],
      )
      await client.query('COMMIT')
      return { id: Number(inserted.rows[0]?.id) }
    } catch (err) {
      // ROLLBACK itself can fail (e.g. a dead connection); that must not
      // replace the original error, which is the one that explains what
      // went wrong — it is always what this method throws.
      //
      // But a rollback failure still has to be dealt with, and
      // `client.release()` with NO argument does not do that: it returns
      // the connection to the pool's IDLE list regardless of whether the
      // transaction was ever rolled back. A connection released that way
      // after a failed ROLLBACK goes back into circulation still inside an
      // aborted transaction, and every query any later caller sends over it
      // fails with "current transaction is aborted, commands ignored until
      // end of transaction block" — permanently, for as long as the pool
      // keeps handing that connection out. `client.release(err)`, called
      // with a truthy argument, is what makes the pool DESTROY the
      // connection instead of recycling it, which is what `finally` does
      // below whenever `releaseErr` got set here.
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        releaseErr = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr))
      }
      throw err
    } finally {
      client.release(releaseErr)
    }
  }

  /**
   * NOT project-scoped, unlike a routine `:id` lookup elsewhere in this
   * codebase. There is no project left to scope by once the purge
   * completes — that is the point of the missing foreign key — and this
   * store's status route is session-only and instance-scoped anyway.
   */
  async get(id: number): Promise<ProjectDeletionRequest | null> {
    const r = await this.pool.query<Row>(
      `SELECT id, project_id, slug, name, requested_at, claimed_at, completed_at, attempts, last_error
         FROM project_deletions WHERE id = $1`,
      [id],
    )
    return r.rows[0] ? toRequest(r.rows[0]) : null
  }

  /**
   * Takes one claimable request under a lease.
   *
   * One statement, so two claimers (the server's worker and a CLI draining
   * its own request) cannot take the same row: the inner SELECT locks its
   * pick with FOR UPDATE SKIP LOCKED, and a concurrent claimer skips past it
   * to the next candidate rather than blocking on it.
   *
   * `claimDelayMs` is REQUIRED rather than defaulted: it is the guard that
   * keeps a purge from starting while ingest can still be admitting events
   * for the project (see CLAIM_SQL above), and a default would let a new
   * caller opt out of it by saying nothing.
   */
  async claim(opts: {
    leaseMs: number
    maxAttempts: number
    claimDelayMs: number
  }): Promise<ProjectDeletionRequest | null> {
    const r = await this.pool.query<Row>(CLAIM_SQL, [
      opts.maxAttempts,
      opts.leaseMs / 1000,
      opts.claimDelayMs / 1000,
    ])
    return r.rows[0] ? toRequest(r.rows[0]) : null
  }

  /**
   * Claims exactly one request BY ID, under the same lease semantics as
   * `claim()` -- one statement, `FOR UPDATE SKIP LOCKED`, `attempts =
   * attempts + 1`, refusing a row already claimed inside the lease window
   * or at/past `maxAttempts`. The one difference from `claim()` is the
   * WHERE clause: this never looks past the named row, not even to report
   * that a DIFFERENT (older) request exists.
   *
   * Exists beside `claim()` for two different callers with two different
   * jobs. `claim()` is a WORKER draining the queue -- it has no request in
   * mind, so "whatever is oldest and claimable" is exactly right. A caller
   * that just filed ONE specific request (a CLI invocation, say) must only
   * ever take that request: it purges the project THAT request names, and
   * calling `complete`/`fail` on a DIFFERENT id -- whatever `claim()`
   * happened to return -- marks somebody else's deletion done while their
   * data survives, and leaves the caller's own request claimable forever.
   * `claim()`'s `ORDER BY requested_at LIMIT 1` has no way to express "but
   * only if it's this one"; this method is that missing guarantee, not a
   * copy-paste of `claim()` with an extra filter bolted on after the fact.
   */
  async claimById(
    id: number,
    opts: { leaseMs: number; maxAttempts: number; claimDelayMs: number },
  ): Promise<ProjectDeletionRequest | null> {
    const r = await this.pool.query<Row>(CLAIM_BY_ID_SQL, [
      id,
      opts.maxAttempts,
      opts.leaseMs / 1000,
      opts.claimDelayMs / 1000,
    ])
    return r.rows[0] ? toRequest(r.rows[0]) : null
  }

  /** Marks a request done and clears any error a previous attempt left behind. */
  async complete(id: number): Promise<void> {
    await this.pool.query(
      'UPDATE project_deletions SET completed_at = now(), last_error = NULL WHERE id = $1',
      [id],
    )
  }

  /**
   * THE WAY BACK INTO A HALF-PURGED PROJECT, and the only one there is.
   *
   * `DeletionStore.reopen` (privacy/deletion-store.ts) exists for exactly
   * this class of dead end, and this is its project-shaped twin. Compose
   * three things and a project can reach a state nothing else in this
   * codebase can leave: `claim()` stops handing a request out past
   * `maxAttempts`, `request()` answers `alreadyDeleting` so neither the route
   * nor the CLI can file a second one, and `deleting_at` is stamped at
   * request time and cleared by nothing. A purge that failed five times is
   * therefore permanent — ingest refused forever, the status endpoint
   * answering `failed` forever, and whatever survived the partial teardown
   * still sitting in ClickHouse.
   *
   * `attempts = 0` and `claimed_at = NULL` together are what make the row
   * claimable on the very next worker tick: zeroing attempts alone would
   * leave it waiting out the remainder of a stale lease.
   *
   * `last_error` is deliberately LEFT in place, following that precedent
   * exactly. It is the only record of why the previous attempt failed, the
   * status endpoint surfaces it, and `complete()` clears it on success
   * anyway — wiping it here would destroy the operator's diagnosis at the
   * exact moment they are acting on it.
   *
   * `completed_at IS NULL` in the predicate: a finished deletion is a
   * tombstone, not something to resume, and re-running a purge for a project
   * id that has since been reissued is not a recovery, it is a second
   * deletion.
   *
   * NOT project-scoped, for the same reason `get()` is not: by the time
   * anyone needs this there may be no project row left to scope by.
   */
  async reopen(id: number): Promise<ProjectDeletionRequest | null> {
    const r = await this.pool.query<Row>(
      `UPDATE project_deletions
          SET attempts = 0, claimed_at = NULL
        WHERE id = $1 AND completed_at IS NULL
        RETURNING *`,
      [id],
    )
    return r.rows[0] ? toRequest(r.rows[0]) : null
  }

  /**
   * A TRANSIENT outcome, not a failure: the teardown ran and the verify step
   * found rows back again (`purgeProject` returning `deleted: false` — the
   * buffered-flush shape it documents). The teardown is idempotent, so the
   * answer is simply to do it again, immediately.
   *
   * All three writes matter, and each for its own reason:
   *
   * - `claimed_at = NULL` is what makes "the next pass redoes the teardown"
   *   mean the next WORKER TICK rather than the end of the lease. Routing
   *   this through `fail()` instead leaves the lease held, and
   *   `projectPurgeLeaseMs` is half an hour: a project sits visibly
   *   half-destroyed for thirty minutes over a race that resolves in a
   *   second.
   * - `attempts - 1` gives the attempt back. `claim()` incremented it on the
   *   way in, and a reappearance is an expected outcome of a live install,
   *   not evidence the request is poisoned. Left counting up, a project
   *   whose events keep arriving walks itself to the terminal `failed` state
   *   — which nothing but `reopen()` can leave — for doing exactly what it
   *   was designed to do.
   * - `last_error` is still recorded, because the status endpoint is the
   *   only place an operator can see WHY a delete is taking another pass.
   *
   * `GREATEST(..., 0)` rather than a bare subtraction: nothing should be able
   * to drive this below zero, and a negative attempt count would silently
   * widen the retry budget instead of restoring it.
   *
   * DELIBERATELY NOT A CHANGE TO `fail()`. Clearing the lease there too would
   * make a genuinely broken purge — an unreachable ClickHouse, say — retry as
   * fast as the worker ticks, burning every attempt in a minute and reaching
   * the terminal state before an operator could see the first error. The two
   * outcomes need opposite cadences, so they get two methods.
   */
  async defer(id: number, note: string): Promise<void> {
    await this.pool.query(
      `UPDATE project_deletions
          SET claimed_at = NULL,
              attempts = GREATEST(attempts - 1, 0),
              last_error = $2
        WHERE id = $1`,
      [id, note.slice(0, MAX_LAST_ERROR_LENGTH)],
    )
  }

  /**
   * Records why an attempt failed, leaving the request claimable again once
   * its lease ages out (or immediately unclaimable, once `attempts` has
   * reached `claim`'s `maxAttempts`).
   *
   * `error` is a caught exception's `.message`: caller-influenced, and this
   * row is re-read by the status endpoint on every poll, so it is truncated
   * before it reaches SQL rather than trusted to already be a reasonable
   * size.
   */
  async fail(id: number, error: string): Promise<void> {
    await this.pool.query('UPDATE project_deletions SET last_error = $2 WHERE id = $1', [
      id,
      error.slice(0, MAX_LAST_ERROR_LENGTH),
    ])
  }
}
