/**
 * Writes generated demo data to the two databases.
 *
 * ADDITIVE ONLY. Nothing in this file deletes, truncates, drops, or overwrites
 * anything, and there is no flag that makes it. An operator pointing this at a
 * project holding real data must not be able to lose it by mistyping a slug,
 * and a demo tool is not the right place to own a destructive path — the
 * deletion API and the restore script already own theirs, with their own
 * confirmations. The cost of that choice is that a second run adds a second
 * cohort rather than replacing the first; the command's help text says so.
 *
 * Three things have to happen, and the third is the one that is easy to miss:
 *
 *  1. `events` rows go to ClickHouse. `event_schema`, `person_traits` and
 *     `device_index` are materialised views over that table, so they populate
 *     from this insert with nothing extra to do — which is asserted against a
 *     live database rather than assumed.
 *  2. `identity_bindings` rows go to POSTGRES, not ClickHouse. Identity is
 *     resolved at query time through a ClickHouse dictionary that reads
 *     Postgres, so events alone leave every anonymous-then-identified visitor
 *     unresolved and person counts wrong.
 *  3. The dictionary is asked to reload. It has `LIFETIME(MIN 5 MAX 15)`, so it
 *     would pick the new bindings up on its own within fifteen seconds — but
 *     "seed, then immediately look at a screen" is exactly how this command is
 *     used, and fifteen seconds of a half-resolved population looks like a bug.
 */

import type { ClickHouseClient, Pool } from '@lyraflow/db'
// The ONE remaining reason packages/cli depends on packages/server. The row
// builder moved to core (#125), but this is a Postgres-backed class with a
// cache, not a pure function, and it cannot follow: core is in the browser
// bundle. Used rather than reimplemented because it owns the millisecond
// truncation and the deterministic tie-break described below -- a second copy
// of those would make demo data stop resembling production data, which is the
// only reason the seeder exists.
import { IdentityBindings } from '@lyraflow/server/dist/identity/bindings.js'
import type { DemoData } from './generate.js'
import { toDemoRow } from './rows.js'

/**
 * Rows per ClickHouse insert. ClickHouse wants few large inserts rather than
 * many small ones (each one is a part that then has to be merged), and the
 * whole default run is a couple of batches at this size.
 */
export const INSERT_BATCH_ROWS = 2_000

/**
 * Same allowlist `resolvedPersonExpr` (@lyraflow/core) applies to its own
 * `database` parameter, and for the same reason: the value is interpolated into
 * a statement as a bare identifier, where no bound parameter is possible. It
 * comes from `LYRAFLOW_CLICKHOUSE_DB` rather than from a request, which is a
 * reason to validate it once here, not a reason to trust it.
 */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface InsertResult {
  rows: number
  batches: number
  bindingsWritten: number
  /** `true` when the dictionary was reloaded; `false` when it does not exist
   * yet, which is normal on an install whose server has never booted. */
  dictionaryReloaded: boolean
}

export interface InsertDeps {
  ch: ClickHouseClient
  pg: Pool
  /** The configured ClickHouse database — where the dictionaries live. */
  database: string
  projectId: number
}

export async function insertDemoData(data: DemoData, deps: InsertDeps): Promise<InsertResult> {
  const { ch, pg, database, projectId } = deps
  if (!SAFE_IDENTIFIER.test(database)) {
    throw new Error(
      'LYRAFLOW_CLICKHOUSE_DB must be a plain SQL identifier ([A-Za-z_][A-Za-z0-9_]*)',
    )
  }

  const rows = data.events.map((ev) => toDemoRow(ev, projectId))

  let batches = 0
  for (let i = 0; i < rows.length; i += INSERT_BATCH_ROWS) {
    await ch.insert({
      table: 'events',
      format: 'JSONEachRow',
      values: rows.slice(i, i + INSERT_BATCH_ROWS),
    })
    batches++
  }

  // Through `IdentityBindings` rather than an INSERT written here: that class
  // owns the millisecond truncation and the deterministic tie-break on a
  // (device, instant) collision, both of which the derived tiling in
  // `identity_bindings_dict_src` depends on. A second spelling of this write
  // is exactly the kind of thing that desyncs the two derivations silently.
  const bindings = new IdentityBindings(pg)
  let bindingsWritten = 0
  for (const b of data.bindings) {
    const outcome = await bindings.bind(projectId, b.anonymousId, b.personId, b.boundAt)
    if (outcome === 'written') bindingsWritten++
  }

  const dictionaryReloaded = await reloadBindingsDictionary(ch, database)

  return { rows: rows.length, batches, bindingsWritten, dictionaryReloaded }
}

/**
 * Returns `false` — rather than throwing — when the dictionary is not there.
 *
 * The dictionaries are created at server boot (`ensureIdentityDictionaries`),
 * not by a migration, because their DDL embeds the Postgres password. Seeding a
 * freshly migrated install whose server has not started yet is a perfectly
 * reasonable thing to do, and failing the whole command at the last step —
 * after every row is already written — would be a worse answer than saying so
 * in the summary.
 */
async function reloadBindingsDictionary(ch: ClickHouseClient, database: string): Promise<boolean> {
  try {
    await ch.command({ query: `SYSTEM RELOAD DICTIONARY ${database}.identity_bindings` })
    return true
  } catch {
    return false
  }
}
