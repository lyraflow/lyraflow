import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EVENT_COLUMN_FIELDS } from '@lyraflow/core'
import { describe, expect, it } from 'vitest'

/**
 * `EVENT_COLUMN_FIELDS` (core, `segments/ast.ts`) names every column on the
 * events table that an operator might reasonably type into a `where`
 * predicate, so a screen can say it will not match there. Like
 * `SCHEMA_VERSION` above it, it is hand-maintained, and nothing else ties it
 * to the schema it describes -- a `utm_channel` column added to
 * `002_events.sql` would simply be missing from it, and the warning would go
 * quiet for exactly the field that had just become a new way to fall into
 * the trap.
 *
 * Pure file reading: no client, no container. It belongs in this package
 * because this is where the migrations live, not because it needs a stack.
 */

/**
 * The columns that are neither a property map nor a candidate for a `where`
 * predicate: who and when, plus the two maps a predicate actually reads.
 *
 * Listed rather than pattern-matched, so a new column is never silently
 * absorbed by a rule like "anything ending in `_id`". Adding one to the
 * migration fails this test, which is the point -- the decision it forces is
 * "is this something an operator could mistake for a property?", and only a
 * person can answer that.
 */
const NOT_A_FIELD = new Set([
  'project_id',
  'event_id',
  'anonymous_id',
  'user_id',
  'event_name',
  'timestamp',
  'received_at',
  'trusted',
  'properties',
  'properties_num',
])

/**
 * The column names declared by one `CREATE TABLE <name> (...)` block.
 *
 * Deliberately stops at the first `INDEX`/`ENGINE` line rather than trying
 * to parse ClickHouse's full DDL: everything before those is one column per
 * line, and a parser that understood more would have more ways to be wrong
 * about the thing it is pinning.
 */
function columnsOf(sql: string, table: string): string[] {
  const start = sql.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`)
  if (start === -1) throw new Error(`no CREATE TABLE for ${table}`)
  const body = sql.slice(start).split('\n').slice(1)
  const names: string[] = []
  for (const line of body) {
    const trimmed = line.trim()
    if (trimmed.startsWith(')') || trimmed.startsWith('INDEX ') || trimmed.startsWith('ENGINE')) {
      break
    }
    const match = /^([a-z_][a-z0-9_]*)\s+/.exec(trimmed)
    if (match?.[1] != null) names.push(match[1])
  }
  return names
}

describe('EVENT_COLUMN_FIELDS', () => {
  const sql = readFileSync(
    join(import.meta.dirname, '..', 'migrations', 'clickhouse', '002_events.sql'),
    'utf8',
  )

  it('names every events column that is not identity, time, or a property map', () => {
    const columns = columnsOf(sql, 'events')
    // Guards the parser itself: a `columnsOf` that silently returned nothing
    // would make the comparison below trivially pass against an empty set.
    expect(columns).toContain('properties')
    expect(columns).toContain('path')
    expect(columns.length).toBeGreaterThan(20)

    const fields = columns.filter((c) => !NOT_A_FIELD.has(c))
    expect(fields.sort()).toEqual([...EVENT_COLUMN_FIELDS].sort())
  })
})
