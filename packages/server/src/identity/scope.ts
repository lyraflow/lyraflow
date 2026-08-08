import { chDateTime, coalesceContiguous, deriveTiling } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import { SEGMENT_MAX_EXECUTION_SECONDS, SEGMENT_MAX_MEMORY_BYTES } from '../segments/execute.js'
import type { PersonAliases } from './aliases.js'
import type { IdentityBindings } from './bindings.js'

/**
 * A person's windows are devices multiplied by rebinds, which is unbounded in
 * principle. Past this many clauses the request is refused rather than
 * widened: widening a range to fit is how the union behaviour comes back.
 */
export const MAX_PERSON_RANGE_CLAUSES = 200

export interface PersonWindow {
  device: string
  from: number
  to: number
}

/**
 * "Which events belong to this person": the canonical group, its devices,
 * the per-device time windows those devices actually belonged to the group,
 * and the deduped id set a caller sees on the wire.
 */
export interface PersonScope {
  canonical: string
  /** The canonical plus every id merged into it. */
  group: string[]
  /** Every device bound to any member of `group`. */
  devices: string[]
  /** `group` ∪ `devices`, deduped and sorted — the wire `ids`. */
  ids: string[]
  windows: PersonWindow[]
}

/**
 * Steps 1-3 of the resolution below, extracted because step 4 (the device
 * lookup) has to run all three again against the person it discovers.
 */
interface ResolvedGroup {
  canonical: string
  /** The canonical plus every id merged into it. */
  group: string[]
  /** Every device bound to any member of `group`. */
  devices: string[]
}

/**
 * Resolves "which events belong to this person" — alias resolution, the
 * device-id fallback, and the per-device windows — the one derivation every
 * caller that needs a person's full history goes through (the person read,
 * the export, the purge worker, the deletion route's existence check).
 *
 * Does not itself enforce MAX_PERSON_RANGE_CLAUSES; each caller checks
 * `windows.length` against it, because what a caller does on the cap being
 * exceeded (400 the request, skip the person, etc.) differs per caller.
 */
export async function resolvePersonScope(
  deps: { bindings: IdentityBindings; aliases: PersonAliases },
  projectId: number,
  id: string,
): Promise<PersonScope> {
  const { bindings, aliases } = deps

  async function resolveGroup(projectId: number, id: string): Promise<ResolvedGroup> {
    const canonical = await aliases.canonicalFor(projectId, id)
    const mergedFrom = await aliases.mergedFrom(projectId, canonical)
    const group = [canonical, ...mergedFrom]
    return { canonical, group, devices: await bindings.devicesForAny(projectId, group) }
  }

  // Step 1: the canonical person for the requested id (PersonAliases).
  // Step 2: every id ever merged INTO that canonical (PersonAliases again)
  // — not just the canonical itself. Step 3: every device bound to *any*
  // id in that whole group (IdentityBindings), in one round trip.
  //
  // Step 2 is not optional. `/v1/alias` only ever writes to person_aliases;
  // it never repoints identity_bindings.person_id. So a device bound to an
  // id that later gets merged away stays bound to that old id in Postgres
  // forever — querying IdentityBindings for the canonical alone would never
  // find it, and neither would an event recorded with that old id as its
  // raw user_id. Skipping step 2 previously meant a person's own profile
  // could be *missing* history a segment query (which resolves through
  // both dictionary stages unconditionally — see resolve.ts) would still
  // count — the read path meant to be more authoritative than the lagging
  // dictionary returning a strictly less complete answer than it. Every id
  // in `group` below is treated equally: the canonical has no special
  // status once resolved, it is simply one more member whose own devices
  // must be included.
  const resolved = await resolveGroup(projectId, id)

  // Step 4, and only when steps 1-3 all came back empty-handed: the
  // requested id may be a DEVICE id rather than a person id. Everything
  // above is keyed on person_id, so without this a device id resolves to
  // itself and the route answers a plausible-looking but silently wrong
  // 200 (`person_id: "visitor-1", ids: ["visitor-1"]`) — worse than a 404,
  // because nothing in the response says it failed. README documents `:id`
  // as accepting a device id; this lookup is what makes that true, rather
  // than retreating in the docs.
  //
  // Gated on "no alias of its own, nothing merged into it, and no devices
  // of its own" — `group.length === 1` covers the first two, since an id
  // with an alias resolves to a canonical that has at least this id merged
  // into it. That is exactly the state in which nothing has ever identified
  // this id as a person. A real person id fails the gate the moment it has
  // been identified against, including the
  // identify({anonymous_id:'x', user_id:'x'}) case where the two ids
  // coincide (that id IS one of its own devices, so `devices` is
  // non-empty). So the device lookup can never shadow a real person, and
  // costs one extra query only on a path that would otherwise 404.
  //
  // A device bound to several people over time resolves to the most
  // recently bound — see mostRecentPersonFor for why that answer and not
  // another.
  const looksUnknown = resolved.group.length === 1 && resolved.devices.length === 0
  const owner = looksUnknown ? await bindings.mostRecentPersonFor(projectId, id) : null
  const { canonical, group, devices } = owner ? await resolveGroup(projectId, owner) : resolved
  // Deduped and sorted: `group` and `devices` can overlap (e.g.
  // identify({anonymous_id:'x', user_id:'x'}) binds a device id that is
  // identical to the person id, which would otherwise put 'x' in `ids`
  // twice), and neither query above carries an ORDER BY. The response is a
  // set, not a log; nothing about it should depend on Postgres's incidental
  // row order.
  const ids = Array.from(new Set([...group, ...devices])).sort()

  // Every bind event on every device this group ever touched, keyed by
  // device — scoped by projectId (see bindings.ts's bindEventsForDevices),
  // which matters here specifically because `devices` is caller-influenced
  // (it traces back to the group PersonAliases/IdentityBindings resolved
  // for a caller-supplied id): an unscoped lookup could pull another
  // project's bind rows for a device id that collides across projects (see
  // person.test.ts's "does not leak another project's binds" test, which
  // puts two projects in genuine contention on the SAME device id to catch
  // exactly that).
  const bindEvents = await bindings.bindEventsForDevices(projectId, devices)

  // One [from, to) window per device per CONTIGUOUS owner, derived through
  // the same function 003_identity.sql's view is required to agree with.
  // Keeping the derivation in one place is what "converge onto one
  // implementation of the tiling" actually asks for; the two SQL shapes
  // stay different because the two reads have different jobs.
  //
  // coalesceContiguous runs on every device's tiling before it is filtered
  // to this group. `deriveTiling` deliberately never collapses adjacent
  // same-person tiles (see its own docstring) — a logged-in browser's every
  // page load writes a fresh bind row (bindings.ts's GROWTH CHARACTERISTIC
  // note), each carrying a distinct server-receipt instant, so one device
  // used by one person for N page loads tiles as N boundary-touching,
  // same-person tiles rather than one. Left uncollapsed, that is N windows
  // per device instead of 1, and MAX_PERSON_RANGE_CLAUSES below turns a
  // routine 201st page view into a permanent 400 for that customer.
  //
  // This is NOT the widening MAX_PERSON_RANGE_CLAUSES exists to forbid.
  // Widening stretches a range across an actual gap or a different owner to
  // make something fit a budget, changing what the range means. Merging
  // alice[10,20) with alice[20,30) changes nothing: the boundary between
  // them is a same-person handoff, so their union IS EXACTLY alice[10,30) —
  // no approximation, no information lost. coalesceContiguous only ever
  // merges a true handoff (same personId, touching boundary); a gap can't
  // occur (deriveTiling's tiling is always gapless) and a different person
  // in between always breaks the merge, so this can only shrink the window
  // count, never change which person owns which instant. See
  // coalesceContiguous's own docstring in @lyraflow/core for the full
  // argument.
  const windows: PersonWindow[] = []
  for (const [device, events] of bindEvents) {
    for (const binding of coalesceContiguous(deriveTiling(events))) {
      if (group.includes(binding.personId)) {
        windows.push({ device, from: binding.from, to: binding.to })
      }
    }
  }

  return { canonical, group, devices, ids, windows }
}

/**
 * The events predicate for a scope — the identity half only,
 * `(user_id IN {…} OR (user_id = '' AND <per-device windows>))`. Does NOT
 * add the `project_id` filter and does NOT add the suppression boundary:
 * each caller adds both itself, because each has a different `project_id`
 * parameter name and a different boundary source.
 *
 * Mutates `params` with every bound value it needs and returns the SQL.
 * `prefix` namespaces the parameter names so two predicates can share one
 * params object (the purge chunks).
 *
 * Stage 1's short-circuit, expressed as SQL: an event carrying a non-empty
 * user_id belongs to that user, full stop. The device branch is therefore
 * guarded on user_id = '' — without that guard an event with user_id='bob'
 * sitting on alice's device is counted for BOTH, which is the narrower
 * defect this convergence is also meant to fix.
 *
 * `w.from`/`w.to` can be ±Infinity — the earliest tile a device ever had
 * is unbounded below, and its current tile is unbounded above, which is
 * the common case, not an edge one: a device with exactly one bind ever
 * is both at once. `new Date(Infinity)` is an Invalid Date and
 * `chDateTime` would throw formatting it, so an infinite bound omits its
 * half of the range clause entirely rather than being clamped to some
 * representable-but-arbitrary date — the same "no clause means no bound"
 * shape `windowStart` uses for the segment compiler's `ever` window
 * (@lyraflow/core's behaviour.ts).
 */
export function personEventsPredicate(
  scope: Pick<PersonScope, 'group' | 'windows'>,
  params: Record<string, unknown>,
  prefix = '',
): string {
  params[`${prefix}group`] = scope.group
  const clauses = scope.windows.map((w, i) => {
    params[`${prefix}d${i}`] = w.device
    const parts = [`anonymous_id = {${prefix}d${i}:String}`]
    if (Number.isFinite(w.from)) {
      params[`${prefix}f${i}`] = chDateTime(new Date(w.from))
      parts.push(`timestamp >= {${prefix}f${i}:DateTime64(3)}`)
    }
    if (Number.isFinite(w.to)) {
      params[`${prefix}t${i}`] = chDateTime(new Date(w.to))
      parts.push(`timestamp < {${prefix}t${i}:DateTime64(3)}`)
    }
    return `(${parts.join(' AND ')})`
  })
  const deviceBranch = clauses.length > 0 ? ` OR (user_id = '' AND (${clauses.join(' OR ')}))` : ''
  return `(user_id IN {${prefix}group:Array(String)}${deviceBranch})`
}

/**
 * Splits `windows` into groups of at most `size`, for callers that must
 * bound the size of a single `personEventsPredicate` statement regardless
 * of how fragmented a person's device history is — a person's windows are
 * devices × rebinds, unbounded in principle, and `personEventsPredicate`
 * emits roughly 110 bytes and three bound parameters PER window. Past a
 * couple of thousand windows an unchunked statement can exceed
 * ClickHouse's default `max_query_size` and throw outright.
 *
 * Shared by the deletion route's existence check (routes.ts) and the purge
 * worker's event delete (purge.ts) — both need "process this person's
 * whole window set without ever refusing", just for different operations,
 * so the chunking itself lives here once rather than twice.
 *
 * ALWAYS yields at least one chunk, even for `windows.length === 0`
 * (`[[]]`, not `[]`). `personEventsPredicate`'s `user_id IN group` branch
 * is independent of windows entirely — a person whose every event carries
 * their own `user_id` directly (no device-window match ever needed, e.g.
 * server-side-only tracking) has zero windows by construction. Returning
 * no chunks at all for that person would skip the loop in every caller
 * entirely: the deletion route would never check for their events (a
 * false `person_not_found`), and the purge worker would never delete them
 * (a purge that silently purges nothing).
 */
export function chunkWindows<T>(windows: T[], size: number): T[][] {
  if (windows.length === 0) return [[]]
  const chunks: T[][] = []
  for (let i = 0; i < windows.length; i += size) {
    chunks.push(windows.slice(i, i + size))
  }
  return chunks
}

interface PersonEventsRow {
  first_seen: string
  last_seen: string
  // ClickHouse's HTTP interface quotes UInt64 values as JSON strings by
  // default (avoids precision loss past 2^53) — see the identical parsing
  // in schema-clickhouse.test.ts's count() assertions.
  events: string
}

export interface PersonEventSummary {
  /**
   * Raw ClickHouse `DateTime64` strings — meaningless when `events` is 0
   * (ClickHouse's `min`/`max` still return a row, just the type's zero
   * value, not an absence). Parse with `parseChDateTime`
   * (`ingest/row.ts`) before formatting for the wire.
   */
  firstSeen: string
  lastSeen: string
  /**
   * `count(DISTINCT event_id)` — `events` is a ReplacingMergeTree, and a
   * retried delivery is a permanent second row, not a de-duplicated one.
   */
  events: number
}

/**
 * The query behind GET /v1/persons/:id and DELETE /v1/persons/:id's
 * existence check: first-seen, last-seen, and a deduplicated event count
 * for a resolved scope, through the exact same identity predicate
 * (`personEventsPredicate`) both routes must never be allowed to drift
 * apart on — a structural guess at "does this person exist" (e.g. "has a
 * device binding") under-covers a real subject identified without ever
 * being bound to a device, which is exactly the gap that put this function
 * here instead of leaving each caller to build its own query.
 *
 * `opts.after`, when given, is a deletion boundary — the same clause the
 * person read applies (`timestamp > after`, strictly greater than because
 * the boundary itself is inclusive of the events it erases). Passing
 * nothing at all — the deletion route's existence check — deliberately
 * still sees suppressed rows: until the purge worker actually deletes them
 * they are still sitting in ClickHouse, and 404ing a person whose data is
 * merely HIDDEN, not yet erased, would misreport the one thing this
 * endpoint exists to guarantee. It is also what keeps a repeat deletion
 * request idempotent: an operator re-requesting after a purge exhausted its
 * attempts, for a person with no activity since their first request, must
 * not be told the person no longer exists.
 *
 * `opts.prefix`, like `personEventsPredicate`'s own `prefix`, namespaces
 * every bound parameter this builds — `projectId` and `after` included —
 * not only the ones `personEventsPredicate` itself adds. Each call to this
 * function is its own independent request with its own fresh `params`
 * object, so nothing here can actually collide across calls; a caller that
 * chunks a single person's windows across several calls (the deletion
 * route's existence check) still passes a distinct prefix per chunk, so
 * that never becomes true by accident later.
 */
export async function personEventSummary(
  ch: ClickHouseClient,
  projectId: number,
  scope: Pick<PersonScope, 'group' | 'windows'>,
  opts: { after?: Date; prefix?: string } = {},
): Promise<PersonEventSummary> {
  const prefix = opts.prefix ?? ''
  const params: Record<string, unknown> = { [`${prefix}projectId`]: projectId }
  const identity = personEventsPredicate(scope, params, prefix)

  let afterClause = ''
  if (opts.after) {
    params[`${prefix}after`] = chDateTime(opts.after)
    afterClause = ` AND timestamp > {${prefix}after:DateTime64(3)}`
  }

  const rs = await ch.query({
    query: `
      SELECT
        min(timestamp) AS first_seen,
        max(timestamp) AS last_seen,
        count(DISTINCT event_id) AS events
      FROM events
      WHERE project_id = {${prefix}projectId:UInt32}
        AND ${identity}${afterClause}
    `,
    query_params: params,
    format: 'JSONEachRow',
    // Three callers (GET /v1/persons/:id, the deletion route's existence
    // check, and the export route), all reachable by an authenticated
    // caller on repeat, none of them otherwise bounded — segments/execute.ts
    // ceilings reused rather than a fourth pair of magic numbers, since this
    // is now the most-shared query in the identity/privacy subsystem.
    clickhouse_settings: {
      max_execution_time: SEGMENT_MAX_EXECUTION_SECONDS,
      max_memory_usage: String(SEGMENT_MAX_MEMORY_BYTES),
      timeout_overflow_mode: 'throw',
    },
  })
  const [row] = await rs.json<PersonEventsRow>()
  return {
    firstSeen: row?.first_seen ?? '',
    lastSeen: row?.last_seen ?? '',
    // Compared/returned numerically, not as the raw string: ClickHouse's
    // HTTP interface quotes UInt64 values as JSON strings by default, but
    // that is a server-side formatting setting, not a guarantee — a string
    // comparison would stay coupled to it for no reason.
    events: row ? Number(row.events) : 0,
  }
}
