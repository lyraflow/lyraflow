import type { Pool } from '@lyraflow/db'
import type { SuppressionStore } from './suppression-store.js'

export interface DeletionRequest {
  id: number
  projectId: number
  personId: string
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
   * The two rows, together or neither.
   *
   * Split across two statements outside a transaction, a crash between them
   * gives either suppression with no scheduled purge (hidden forever, never
   * erased) or a purge with no suppression (visible until the worker
   * arrives). The endpoint has already answered 202 by then, so neither is
   * recoverable by retry.
   */
  async request(
    projectId: number,
    personId: string,
    at: Date,
  ): Promise<{ id: number; suppressedAt: Date }> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const suppressedAt = await this.suppression.upsert(client, projectId, personId, at)
      const r = await client.query<{ id: string }>(
        'INSERT INTO deletion_requests (project_id, person_id) VALUES ($1, $2) RETURNING id',
        [projectId, personId],
      )
      await client.query('COMMIT')
      return { id: Number(r.rows[0]?.id), suppressedAt }
    } catch (err) {
      // ROLLBACK itself can fail (a dead connection); that must not replace
      // the original error, which is the one that explains what went wrong.
      try {
        await client.query('ROLLBACK')
      } catch {
        /* the release below discards the connection either way */
      }
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Project-scoped, like every other `:id` route in this codebase: a request
   * belonging to another project is indistinguishable from one that does not
   * exist. A 403 would confirm the id.
   */
  async get(projectId: number, id: number): Promise<DeletionRequest | null> {
    const r = await this.pool.query<Row>(
      `SELECT id, project_id, person_id, requested_at, claimed_at, completed_at, attempts, last_error
         FROM deletion_requests
        WHERE project_id = $1 AND id = $2`,
      [projectId, id],
    )
    const row = r.rows[0]
    return row ? toRequest(row) : null
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
