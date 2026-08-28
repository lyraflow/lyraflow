import type { ClickHouseClient } from '@lyraflow/db'
import { SEGMENT_MAX_MEMORY_BYTES } from '../segments/execute.js'
import type { PersonScope } from './scope.js'

export interface TraitRow {
  trait_key: string
  value_str: string
  value_num: number
  has_num: number
}

/**
 * Folds `person_traits`' argMax states into a plain object for the wire,
 * for exactly this group plus the devices it CURRENTLY owns.
 *
 * Traits carry no event time (see 004_person_traits.sql: value_str/
 * value_num/has_num are `argMax(…, timestamp)` states with the timestamp
 * itself discarded, not stored per row) — so unlike the events query below,
 * there is no per-event timestamp predicate to add here. That absence is
 * exactly why the caller only calls this when there is no deletion boundary
 * at all: a trait cannot be split at an instant it does not carry.
 *
 * An anonymous trait row (`user_id = ''`) is keyed only by `anonymous_id` —
 * it cannot itself say WHICH owner of that device it belongs to, and a
 * device can have had several over time. `compile.ts`'s segment-wide trait
 * CTE resolves this ambiguity by giving an anonymous row to the device's
 * CURRENT owner and no one else (`resolvedPersonExpr(..., 'tr')` with `now()
 * AS timestamp` — see that CTE's own comment). This function has to agree
 * with that exact rule, not merely "any device this group has ever owned":
 * `scope.windows` already carries this group's own per-device windows, and
 * `deriveTiling`/`coalesceContiguous` (scope.ts) guarantee at most one open
 * window per device — the one with no upper bound (`to === Infinity`) is
 * the device's current tile. Anything else is a PAST window, and handing a
 * past owner's export another owner's anonymous traits is a leak: an
 * anonymous `$identify` on a shared device is exactly the "identify
 * anonymously before login" shape that produces a `user_id = ''` trait row
 * in the first place, and `devicesForAny`/`scope.devices` has no time bound
 * at all — using it here (as an earlier version of this function did) would
 * fan that one row out to every past owner too, not just the current one.
 *
 * Extracted from privacy/export.ts so the person read and the export share
 * one answer to "whose trait is this". Two copies of the rule above is how
 * those two endpoints come to disagree about it.
 */
export async function readPersonTraitRows(
  ch: ClickHouseClient,
  projectId: number,
  scope: Pick<PersonScope, 'group' | 'windows'>,
  maxExecutionSeconds: number,
): Promise<TraitRow[]> {
  const params: Record<string, unknown> = { projectId, group: scope.group }
  const currentDevices = scope.windows.filter((w) => !Number.isFinite(w.to)).map((w) => w.device)
  let deviceClause = ''
  if (currentDevices.length > 0) {
    params.devices = currentDevices
    deviceClause = ` OR (user_id = '' AND anonymous_id IN {devices:Array(String)})`
  }

  const rs = await ch.query({
    query: `
      SELECT
        trait_key,
        argMaxMerge(value_str) AS value_str,
        argMaxMerge(value_num) AS value_num,
        argMaxMerge(has_num) AS has_num
      FROM person_traits
      WHERE project_id = {projectId:UInt32}
        AND (user_id IN {group:Array(String)}${deviceClause})
      GROUP BY trait_key
    `,
    query_params: params,
    format: 'JSONEachRow',
    // The OR defeats person_traits' sort key (project_id, anonymous_id,
    // user_id, trait_key), making this an argMaxMerge over the project's
    // whole partition. Reachable by an authenticated caller on repeat, so
    // it carries the same ceilings the export's event query does.
    clickhouse_settings: {
      max_execution_time: maxExecutionSeconds,
      max_memory_usage: String(SEGMENT_MAX_MEMORY_BYTES),
      timeout_overflow_mode: 'throw',
    },
  })
  return rs.json<TraitRow>()
}

/** `has_num` distinguishes "numeric trait, possibly zero" from "string trait,
 * so value_num is a meaningless default". Truthiness on the VALUE would drop
 * a trait of 0; the guard is on `has_num`. */
function traitValue(row: TraitRow): string | number {
  return row.has_num ? Number(row.value_num) : row.value_str
}

/** The export's shape: one bag, exactly as `identify()` was called with. */
export function mergeTraits(rows: TraitRow[]): Record<string, string | number> {
  const traits: Record<string, string | number> = {}
  for (const row of rows) traits[row.trait_key] = traitValue(row)
  return traits
}

/**
 * `MemberRow`'s shape: two maps, plus how many the person really has.
 *
 * Sorted by key before the cap is applied, so the 50 a caller sees are a
 * stable set rather than whatever order ClickHouse built the group in --
 * otherwise a second read of the same person returns a different 50.
 *
 * `trait_total` counts what the person HAS, not what was returned; a capped
 * list that reported its own length would read as complete.
 */
export function splitTraits(
  rows: TraitRow[],
  cap: number,
): { traits: Record<string, string>; traits_num: Record<string, number>; trait_total: number } {
  const sorted = [...rows].sort((a, b) => a.trait_key.localeCompare(b.trait_key))
  const traits: Record<string, string> = {}
  const traits_num: Record<string, number> = {}
  for (const row of sorted.slice(0, cap)) {
    if (row.has_num) traits_num[row.trait_key] = Number(row.value_num)
    else traits[row.trait_key] = row.value_str
  }
  return { traits, traits_num, trait_total: rows.length }
}
