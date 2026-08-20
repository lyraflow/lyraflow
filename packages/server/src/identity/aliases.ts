import type { Pool } from '@lyraflow/db'

export class AliasCycleError extends Error {
  constructor(personId: string) {
    super(`Alias for ${personId} would create a cycle`)
    this.name = 'AliasCycleError'
  }
}

/**
 * Merges two known people — ID migrations, duplicate signups.
 *
 * Cycles are impossible by construction rather than by a check: both sides are
 * resolved to their current canonical first, and an alias is only ever written
 * between canonical groups. A→B then B→A therefore finds both already sharing a
 * canonical and returns 'noop'. Chains stay depth-1, so query-time resolution is
 * one dictionary lookup with no recursive walk.
 *
 * Aliasing is not reversible in v0.1.
 */
export class PersonAliases {
  constructor(private readonly pool: Pool) {}

  async canonicalFor(projectId: number, personId: string): Promise<string> {
    const r = await this.pool.query<{ canonical_id: string }>(
      'SELECT canonical_id FROM person_aliases WHERE project_id = $1 AND person_id = $2',
      [projectId, personId],
    )
    return r.rows[0]?.canonical_id ?? personId
  }

  /**
   * The reverse of {@link canonicalFor}: every id that has been merged INTO
   * `canonicalId`, not counting `canonicalId` itself. Never includes
   * `canonicalId` — alias() never writes a row whose person_id equals its
   * own canonical_id (enforced by 003_identity.sql's
   * `person_aliases_not_self` check, and by alias()'s own self-alias no-op),
   * so a canonical with no incoming merges returns [].
   *
   * Exists for identity/person.ts's single-person read. canonicalFor alone
   * only tells a caller where an id resolves *to*; a profile view for the
   * canonical also needs every id that resolves *into* it, or an id (and any
   * devices/events recorded under it) that existed before being merged away
   * silently vanishes from the merged person's own history — the exact
   * defect resolve.ts's stage-2 docstring already warns about for the
   * dictionary-backed read path ("silently made /v1/alias a no-op for every
   * event carrying the aliased id"), relocated to this one instead.
   */
  async mergedFrom(projectId: number, canonicalId: string): Promise<string[]> {
    const r = await this.pool.query<{ person_id: string }>(
      'SELECT person_id FROM person_aliases WHERE project_id = $1 AND canonical_id = $2',
      [projectId, canonicalId],
    )
    return r.rows.map((x) => x.person_id)
  }

  /**
   * Retryable SQLSTATEs, and the reason this method has a retry loop at all.
   *
   * `40001` (serialization_failure) is not a failure in the ordinary sense:
   * it is Postgres telling the client that this transaction and a concurrent
   * one could not both be ordered, and that RE-RUNNING it is the documented
   * remedy. `40P01` (deadlock_detected) carries the same contract. Neither
   * says anything is wrong with the request.
   *
   * Before #98 nothing anywhere caught either -- `grep -rn "40001"` across
   * `packages/server/src` found no handler. An abort propagated uncaught to
   * app.ts's catch-all, which maps any unhandled `/v1/*` error to
   * `503 {"error":"unavailable"}`: a retryable conflict rendered as an
   * outage, to a caller with no way to tell the two apart. Measured on
   * another route that had briefly adopted this pattern -- 8 concurrent
   * writes to one row, 10 trials -- 67 `503`s out of 80 requests.
   *
   * #98 also asked whether `alias()` needs SERIALIZABLE at all, since a
   * neighbouring funnel route got the same guarantee from row locks under
   * the default isolation. Deliberately NOT answered here. That route edits
   * one row; this one repoints a whole canonical GROUP, and under READ
   * COMMITTED a blocked UPDATE re-checks its predicate after the lock frees
   * and can miss rows that joined the group in between. Establishing that
   * row locks suffice needs concurrency evidence against a real database,
   * not a plausible argument -- and the retry is correct either way, so it
   * is not a prerequisite for closing the hole.
   */
  static readonly RETRYABLE_SQLSTATES = ['40001', '40P01'] as const

  /**
   * Three total, not more, and bounded on purpose: past the third attempt the
   * contention is real rather than incidental, and a caller waiting on an
   * unbounded retry loop is worse off than one told to try again. Exhausting
   * them rethrows, which is still a 503 -- correct at that point.
   */
  static readonly MAX_ATTEMPTS = 3

  /**
   * Merge two people, retrying the WHOLE transaction on a serialization
   * failure.
   *
   * Retrying the whole thing is the only correct unit. A 40001 invalidates
   * every read the transaction made, so re-issuing just the failed statement
   * would write conclusions drawn from a snapshot Postgres has already
   * rejected -- and both canonical lookups happen before the writes.
   *
   * Safe to re-run because the operation is idempotent by construction: a
   * second attempt re-reads the canonicals, and if the concurrent transaction
   * already merged these two it finds them sharing one and returns 'noop'.
   *
   * The same pooled client is reused across attempts. `attempt` always ends
   * with either COMMIT or ROLLBACK, so what comes back is an idle connection
   * and not one stuck in a failed transaction -- where every subsequent
   * statement would fail `25P02` and the retry would be worse than no retry.
   */
  async alias(
    projectId: number,
    fromPersonId: string,
    toPersonId: string,
  ): Promise<'noop' | 'merged'> {
    const client = await this.pool.connect()
    try {
      for (let attempt = 1; ; attempt++) {
        try {
          return await this.#aliasOnce(client, projectId, fromPersonId, toPersonId)
        } catch (err) {
          const code = (err as { code?: unknown }).code
          const retryable =
            typeof code === 'string' &&
            (PersonAliases.RETRYABLE_SQLSTATES as readonly string[]).includes(code)
          if (!retryable || attempt >= PersonAliases.MAX_ATTEMPTS) throw err
          // Jittered, and the jitter is the point rather than politeness:
          // two transactions that conflicted once will conflict again if they
          // both retry on the same schedule.
          await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 10) + attempt * 5))
        }
      }
    } finally {
      client.release()
    }
  }

  async #aliasOnce(
    client: { query: Pool['query'] },
    projectId: number,
    fromPersonId: string,
    toPersonId: string,
  ): Promise<'noop' | 'merged'> {
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')

      const canonical = async (id: string): Promise<string> => {
        const r = await client.query<{ canonical_id: string }>(
          'SELECT canonical_id FROM person_aliases WHERE project_id = $1 AND person_id = $2',
          [projectId, id],
        )
        return r.rows[0]?.canonical_id ?? id
      }

      const fromCanonical = await canonical(fromPersonId)
      const toCanonical = await canonical(toPersonId)

      if (fromCanonical === toCanonical) {
        await client.query('COMMIT')
        return 'noop'
      }

      // Repoint the whole from-group, and the from-canonical itself, at the
      // to-canonical. One statement each, so chains can never exceed depth 1.
      await client.query(
        `UPDATE person_aliases SET canonical_id = $3
          WHERE project_id = $1 AND canonical_id = $2`,
        [projectId, fromCanonical, toCanonical],
      )
      await client.query(
        `INSERT INTO person_aliases (project_id, person_id, canonical_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (project_id, person_id) DO UPDATE SET canonical_id = EXCLUDED.canonical_id`,
        [projectId, fromCanonical, toCanonical],
      )

      await client.query('COMMIT')
      return 'merged'
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* connection is already gone */
      }
      throw err
    }
  }
}
