import { randomBytes } from 'node:crypto'
import type { ProjectStore } from './create.js'

export const DEFAULT_GRACE_HOURS = 24
export const MAX_GRACE_HOURS = 720

export interface RotatedWriteKey {
  writeKey: string
  previousWriteKey: string | null
  previousWriteKeyExpiresAt: Date | null
}

/**
 * Replace a project's write key. With `graceMs > 0` the key being replaced
 * is kept as the project's ONE previous key until `now + graceMs`; with 0 it
 * is retired immediately. Rotating again inside a grace overwrites the
 * previous key -- there is never more than one (migration 022).
 *
 * The expiry is computed here from `now`, not in SQL from `now()`, so a
 * caller can pin it in a test and so the value the route returns is the
 * value that was written, byte for byte.
 */
export async function rotateWriteKey(
  pg: ProjectStore,
  projectId: number,
  graceMs: number,
  now: Date = new Date(),
): Promise<RotatedWriteKey | null> {
  if (!Number.isInteger(graceMs) || graceMs < 0) {
    throw new RangeError(`graceMs must be a non-negative integer, got ${graceMs}`)
  }
  const writeKey = `wk_${randomBytes(16).toString('hex')}`
  const expiresAt = graceMs > 0 ? new Date(now.getTime() + graceMs) : null
  const result = (await pg.query(
    `UPDATE projects
        SET previous_write_key            = CASE WHEN $2::timestamptz IS NULL THEN NULL ELSE write_key END,
            previous_write_key_expires_at = $2,
            write_key                     = $3
      WHERE id = $1
      RETURNING write_key, previous_write_key, previous_write_key_expires_at`,
    [projectId, expiresAt, writeKey],
  )) as {
    rows: Array<{
      write_key: string
      previous_write_key: string | null
      previous_write_key_expires_at: Date | null
    }>
  }
  const row = result.rows[0]
  if (!row) return null
  return {
    writeKey: row.write_key,
    previousWriteKey: row.previous_write_key,
    previousWriteKeyExpiresAt: row.previous_write_key_expires_at,
  }
}
