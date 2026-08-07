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

  async alias(
    projectId: number,
    fromPersonId: string,
    toPersonId: string,
  ): Promise<'noop' | 'merged'> {
    const client = await this.pool.connect()
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
    } finally {
      client.release()
    }
  }
}
