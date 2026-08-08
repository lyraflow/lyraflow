import type { Pool } from '@lyraflow/db'
import type { SuppressionStore } from './suppression-store.js'

export interface DeletionRequest {
  id: number
  projectId: number
  personId: string
  /**
   * Every id this request covers, frozen at request time — the canonical,
   * every id merged into it, and every device (`PersonScope.ids`). The purge
   * intersects its freshly-resolved group against this, so an `/v1/alias`
   * landing between the `202` and the purge can never pull a different
   * person into the erasure. See 009_deletion_request_ids.sql.
   *
   * EMPTY MEANS UNRESTRICTED, for rows written before that migration only —
   * again, see the migration, which argues why that direction and not the
   * other.
   */
  personIds: string[]
  requestedAt: Date
  claimedAt: Date | null
  completedAt: Date | null
  attempts: number
  lastError: string | null
}

interface Row {
  id: string
  project_id: string
  person_id: string
  person_ids: string[]
  requested_at: Date
  claimed_at: Date | null
  completed_at: Date | null
  attempts: number
  last_error: string | null
}

function toRequest(row: Row): DeletionRequest {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    personId: row.person_id,
    // Defensive `?? []`: node-postgres maps a Postgres `text[]` to a JS array
    // and the column is NOT NULL, so this cannot be null today — but every
    // consumer treats this as an array without checking, and the cost of the
    // guard is nothing next to the cost of the purge reading `undefined` as
    // "no restriction".
    personIds: row.person_ids ?? [],
    requestedAt: row.requested_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    attempts: row.attempts,
    lastError: row.last_error,
  }
}

/**
 * `last_error` is `text` (unbounded) in the schema, but the value going into
 * it is a caught exception's `.message` — caller-influenced, and re-read by
 * the status endpoint on every poll. Bounding it here is what keeps a
 * pathological message (or one an attacker deliberately inflates, chasing
 * storage or a slow response) from turning a single failed purge step into
 * unbounded row growth.
 */
const MAX_LAST_ERROR_LENGTH = 2000

const CLAIM_SQL = `
  UPDATE deletion_requests
     SET claimed_at = now(), attempts = attempts + 1
   WHERE id = (
     SELECT id FROM deletion_requests
      WHERE completed_at IS NULL
        AND attempts < $1
        AND (claimed_at IS NULL OR claimed_at < now() - make_interval(secs => $2))
      ORDER BY requested_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
   RETURNING *`

/**
 * The Postgres-backed queue behind the privacy API: writes a deletion
 * request atomically with the suppression row it depends on, reads a
 * request's status, and hands one claimable request to a purge worker under
 * a lease.
 */
export class DeletionStore {
  constructor(
    private readonly pool: Pool,
    private readonly suppression: SuppressionStore,
  ) {}

  /**
   * The suppression rows and the deletion request row, together or neither.
   *
   * `personId` is the CANONICAL person — `deletion_requests` gets exactly
   * ONE row for it, because the purge is per PERSON, not per id. `ids` is
   * the whole scope the deletion covers (the canonical, every id merged into
   * it, and every device — see `identity/scope.ts`'s `PersonScope.ids`) and
   * gets one `suppressed_persons` row EACH, all carrying the same boundary
   * instant `at`. `personId` must itself be a member of `ids`; see
   * `SuppressionStore.upsertMany`'s own docstring for why the write has to
   * fan out this way at all — the short version is that the purge deletes
   * the only dictionary path a non-canonical id has back to the canonical,
   * so a suppression row keyed on the canonical alone stops protecting every
   * other id in the group the instant the purge finishes.
   *
   * Split across two statements outside a transaction, a crash between them
   * gives either suppression with no scheduled purge (hidden forever, never
   * erased) or a purge with no suppression (visible until the worker
   * arrives). The endpoint has already answered 202 by then, so neither is
   * recoverable by retry. That is equally true of a crash mid-way through
   * the suppression fan-out itself — a partial set of rows with no
   * `deletion_requests` row would be just as unrecoverable — which is why
   * the fan-out is one INSERT statement (`upsertMany`), not a loop of
   * separate ones: there is no "partially written" state for Postgres
   * itself to leave behind, only "committed" or "rolled back" like the rest
   * of this transaction.
   */
  async request(
    projectId: number,
    personId: string,
    ids: string[],
    at: Date,
  ): Promise<{ id: number; suppressedAt: Date }> {
    if (!ids.includes(personId)) {
      throw new Error(
        `DeletionStore.request: ids must include personId (the canonical) — got personId=${JSON.stringify(personId)}, ids=${JSON.stringify(ids)}`,
      )
    }
    const client = await this.pool.connect()
    // Set only if ROLLBACK itself fails, below, and passed to
    // `client.release()` in `finally` — see that catch block for why.
    let releaseErr: Error | undefined
    try {
      await client.query('BEGIN')
      const suppressedAtById = await this.suppression.upsertMany(client, projectId, ids, at)
      // Always present: `personId` is a member of `ids` (checked above), and
      // `upsertMany` returns exactly one row per id it was given.
      const suppressedAt = suppressedAtById.get(personId) as Date
      // `person_ids` is the SAME set the suppression fan-out above just
      // wrote a row for, recorded on the request so the purge worker can
      // intersect its fresh resolution against it and never widen. Written
      // in this same transaction for the same reason the two writes above
      // share one: a request row whose id set did not commit with it would
      // be a request the purge treats as unrestricted.
      const r = await client.query<{ id: string }>(
        'INSERT INTO deletion_requests (project_id, person_id, person_ids) VALUES ($1, $2, $3) RETURNING id',
        [projectId, personId, ids],
      )
      await client.query('COMMIT')
      return { id: Number(r.rows[0]?.id), suppressedAt }
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
   * Project-scoped, like every other `:id` route in this codebase: a request
   * belonging to another project is indistinguishable from one that does not
   * exist. A 403 would confirm the id.
   */
  async get(projectId: number, id: number): Promise<DeletionRequest | null> {
    const r = await this.pool.query<Row>(
      `SELECT id, project_id, person_id, person_ids, requested_at, claimed_at, completed_at, attempts, last_error
         FROM deletion_requests
        WHERE project_id = $1 AND id = $2`,
      [projectId, id],
    )
    const row = r.rows[0]
    return row ? toRequest(row) : null
  }

  /**
   * Makes an incomplete request for `personId` claimable again, returning it,
   * or null if there is no incomplete request for that person.
   *
   * This is the way back into a HALF-PURGED person. The purge deletes events
   * FIRST and identity LAST (deliberately — see purge.ts), while the DELETE
   * route's existence check is `count(DISTINCT event_id) > 0`, and `claim()`
   * stops handing out a request past `maxAttempts`. Compose the three and a
   * purge that fails after its first step burns its attempts with the events
   * already gone: `person_traits` and `identity_bindings` are still sitting
   * there holding the subject's email and identity graph, and every retry
   * path answers `404 person_not_found` — which reads as "already gone".
   * Without this method the only route back is direct SQL.
   *
   * `attempts = 0` and `claimed_at = NULL` together are what make the row
   * claimable on the very next worker tick: zeroing attempts alone would
   * still leave it waiting out the remainder of a stale lease.
   *
   * `last_error` is deliberately LEFT in place. It is the only record of why
   * the previous attempt failed, the status endpoint surfaces it (see
   * routes.ts), and `complete()` clears it on success anyway — wiping it here
   * would destroy the operator's diagnosis at the exact moment they act on
   * it.
   *
   * Scoped to `project_id` unlike `claim()`: this one IS reachable from a
   * route, with a caller-supplied person id, so it follows this file's
   * ordinary project-scoping rule rather than `claim()`'s documented
   * exception.
   *
   * `ORDER BY requested_at` with `LIMIT 1`: there is normally at most one
   * incomplete request per person, because this method is what a repeat
   * DELETE reaches instead of filing a second one. The ordering makes the
   * pick deterministic anyway rather than leaving it to Postgres's row order.
   *
   * A plain `FOR UPDATE` (not `SKIP LOCKED`, unlike `claim()`): if a worker
   * holds this row's lock right now, the right behaviour is to WAIT for it
   * and then reopen, not to skip past and report "nothing to reopen" — the
   * lock is held only for the duration of `claim()`'s own statement. Reopening
   * a request a worker is concurrently purging is harmless: every purge step
   * is a delete predicated on the person, so a second overlapping pass finds
   * nothing left to do (see `claim()`'s docstring on idempotence).
   */
  async reopen(projectId: number, personId: string): Promise<DeletionRequest | null> {
    const r = await this.pool.query<Row>(
      `UPDATE deletion_requests
          SET attempts = 0, claimed_at = NULL
        WHERE id = (
          SELECT id FROM deletion_requests
           WHERE project_id = $1 AND person_id = $2 AND completed_at IS NULL
           ORDER BY requested_at
           LIMIT 1
           FOR UPDATE
        )
        RETURNING *`,
      [projectId, personId],
    )
    return r.rows[0] ? toRequest(r.rows[0]) : null
  }

  /**
   * Takes one claimable request under a lease.
   *
   * One statement, so two processes cannot take the same row: the inner
   * SELECT locks its pick with FOR UPDATE SKIP LOCKED, and a concurrent
   * claimer skips past it to the next candidate rather than blocking on it.
   *
   * The lease is what makes a crash recoverable — a request claimed by a
   * process that then died becomes claimable once it expires, and the worker
   * starts that request OVER FROM THE TOP. Every purge step is a delete
   * predicated on the person, so re-running one is a no-op. Recording
   * per-step progress and resuming mid-way was rejected deliberately: it
   * trades a redundant delete (cheap) for a state machine whose every
   * transition is a chance to resume into a state that skips a step, in a
   * feature where a skipped step is data reported deleted and still present.
   *
   * NOT project-scoped — the one deliberate exception to this file's
   * project-scoping rule. This is a worker-side operation with no caller
   * identity to scope by: the purge worker drains the whole queue across
   * every project, one request at a time, and there is no `:id` route
   * exposing this method for a `projectId` to guard against.
   */
  async claim(opts: { leaseMs: number; maxAttempts: number }): Promise<DeletionRequest | null> {
    const r = await this.pool.query<Row>(CLAIM_SQL, [opts.maxAttempts, opts.leaseMs / 1000])
    return r.rows[0] ? toRequest(r.rows[0]) : null
  }

  /** Marks a request done and clears any error a previous attempt left behind. */
  async complete(id: number): Promise<void> {
    await this.pool.query(
      'UPDATE deletion_requests SET completed_at = now(), last_error = NULL WHERE id = $1',
      [id],
    )
  }

  /**
   * Records why an attempt failed, leaving the request claimable again once
   * its lease ages out (or immediately unclaimable, once `attempts` has
   * reached `claim`'s `maxAttempts` — see CLAIM_SQL's `attempts < $1`).
   *
   * `error` is a caught exception's `.message`: caller-influenced, and this
   * row is re-read by the status endpoint on every poll, so it is truncated
   * before it reaches SQL rather than trusted to already be a reasonable
   * size.
   */
  async fail(id: number, error: string): Promise<void> {
    const bounded =
      error.length > MAX_LAST_ERROR_LENGTH ? `${error.slice(0, MAX_LAST_ERROR_LENGTH)}…` : error
    await this.pool.query('UPDATE deletion_requests SET last_error = $2 WHERE id = $1', [
      id,
      bounded,
    ])
  }
}
