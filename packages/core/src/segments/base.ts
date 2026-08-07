import { RESOLVED_PERSON_ALIAS, resolvedPersonExpr } from '../identity/resolve.js'
import type { ContextField } from './ast.js'
import type { Params } from './params.js'

/**
 * Maps each allowlisted Context field to the device_index columns holding
 * its latest-observed and first-touch values.
 *
 * These strings become bare SQL identifiers, so they must never come from
 * request data — the AST's CONTEXT_FIELDS enum is what guarantees a caller
 * can only select a key of this record. A test asserts the two agree exactly,
 * and a second asserts every column named here is one the CTE actually
 * selects.
 *
 * referrer and the UTM trio have a single column each, deliberately.
 * device_index records those as first-touch only, because for an acquisition
 * attribute the ORIGINAL value is the interesting one — "which campaign
 * brought them in", not "which link they most recently clicked". Both scopes
 * therefore read the same column, and `latest` on those fields is documented
 * to mean first-touch rather than silently returning something else.
 *
 * The other six carry a real column per scope. They cannot share one: an
 * argMax state holds only the value at the latest timestamp, so the earliest
 * observation cannot be recovered from it (see 006_device_first_touch.sql).
 */
export const CONTEXT_COLUMNS: Record<ContextField, { latest: string; first_touch: string }> = {
  country: { latest: 'latest_country', first_touch: 'first_country' },
  region: { latest: 'latest_region', first_touch: 'first_region' },
  city: { latest: 'latest_city', first_touch: 'first_city' },
  device_type: { latest: 'latest_device', first_touch: 'first_device' },
  os: { latest: 'latest_os', first_touch: 'first_os' },
  browser: { latest: 'latest_browser', first_touch: 'first_browser' },
  referrer: { latest: 'first_referrer', first_touch: 'first_referrer' },
  utm_source: { latest: 'first_source', first_touch: 'first_source' },
  utm_medium: { latest: 'first_medium', first_touch: 'first_medium' },
  utm_campaign: { latest: 'first_campaign', first_touch: 'first_campaign' },
}

/**
 * The argMax/argMin merges read out of device_index, one per stored aggregate.
 *
 * Every column CONTEXT_COLUMNS can name must appear here. A column named
 * there but missing here compiles to SQL referencing a column the CTE never
 * selected, which fails at execution rather than at build time.
 */
const DEVICE_MERGES = [
  ['latest_country', 'argMaxMerge'],
  ['latest_region', 'argMaxMerge'],
  ['latest_city', 'argMaxMerge'],
  ['latest_device', 'argMaxMerge'],
  ['latest_os', 'argMaxMerge'],
  ['latest_browser', 'argMaxMerge'],
  ['first_referrer', 'argMinMerge'],
  ['first_source', 'argMinMerge'],
  ['first_medium', 'argMinMerge'],
  ['first_campaign', 'argMinMerge'],
  ['first_country', 'argMinMerge'],
  ['first_region', 'argMinMerge'],
  ['first_city', 'argMinMerge'],
  ['first_device', 'argMinMerge'],
  ['first_os', 'argMinMerge'],
  ['first_browser', 'argMinMerge'],
] as const

/**
 * The people universe: every person who has ever sent an event, anonymous or
 * identified, with their lifecycle bounds and context values.
 *
 * Stating this as the starting set is what makes NOT, OR, and lifecycle-only
 * segments well-defined. Without it, "everyone who never invited a teammate"
 * would silently exclude every anonymous person — precisely the population a
 * journey tool exists to show.
 *
 * Two levels of aggregation, and both are necessary:
 *
 *   dev  — merges device_index's aggregate states per (device, month) and
 *          exposes that month's last_seen under the alias `timestamp`,
 *          because resolvedPersonExpr reads a column with that exact name.
 *   base — resolves each device-month to a person and folds the months
 *          together.
 *
 * Resolving per device-month rather than per device confines the error to the
 * imprecision monthly bucketing already has (a device that rebinds mid-month
 * may attribute that month to the wrong side). Resolving once per device at
 * its overall latest activity would instead hand a rebound device's ENTIRE
 * history to whoever holds it now, which is the same defect the range-aware
 * tiling exists to prevent.
 */
export function baseCte(opts: { database: string; projectId: number; params: Params }): string {
  const { database, projectId, params } = opts
  const projectParam = params.add(projectId, 'UInt32')
  const resolved = resolvedPersonExpr({ database, alias: 'dev' })

  const merges = DEVICE_MERGES.map(([col, fn]) => `${fn}(${col}) AS ${col}`).join(',\n      ')
  const latest = DEVICE_MERGES.filter(([, fn]) => fn === 'argMaxMerge')
    .map(([col]) => `argMax(${col}, last_seen) AS ${col}`)
    .join(',\n      ')
  const first = DEVICE_MERGES.filter(([, fn]) => fn === 'argMinMerge')
    .map(([col]) => `argMin(${col}, first_seen) AS ${col}`)
    .join(',\n      ')

  return `dev AS (
    SELECT
      project_id,
      anonymous_id,
      user_id,
      minMerge(first_seen) AS first_seen,
      maxMerge(last_seen)  AS timestamp,
      maxMerge(last_seen)  AS last_seen,
      ${merges}
    FROM device_index
    WHERE project_id = ${projectParam}
    GROUP BY project_id, anonymous_id, user_id, month
  ),
  base AS (
    SELECT
      ${resolved} AS ${RESOLVED_PERSON_ALIAS},
      min(first_seen) AS first_seen,
      max(last_seen)  AS last_seen,
      ${latest},
      ${first}
    FROM dev
    GROUP BY ${RESOLVED_PERSON_ALIAS}
  )`
}
