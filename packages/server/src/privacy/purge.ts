import type { ClickHouseClient, Pool } from '@lyraflow/db'
import {
  MAX_PERSON_RANGE_CLAUSES,
  type PersonScope,
  chunkWindows,
  personEventsPredicate,
} from '../identity/scope.js'

async function mutate(
  ch: ClickHouseClient,
  query: string,
  query_params: Record<string, unknown>,
): Promise<void> {
  // mutations_sync = 1 is what turns `completed_at` from "I asked" into "it
  // is gone" — ALTER ... DELETE is asynchronous by default, and without this
  // a SELECT run the instant after this resolves could still see the rows.
  await ch.command({ query, query_params, clickhouse_settings: { mutations_sync: '1' } })
}

/**
 * The ordered erasure of one person, across both stores.
 *
 * STEP ORDER IS LOAD-BEARING, and identity goes LAST:
 *
 *   events -> device_index -> person_traits -> events_dead_letter
 *          -> identity_bindings / person_aliases
 *
 * The event delete predicate identifies this person's events THROUGH the
 * bindings — the per-device windows that say which anonymous events were
 * theirs. Delete the bindings first and the remaining events can no longer
 * be matched at all; a retry that re-resolves the scope from Postgres (the
 * lease's "start over from the top" recovery — see DeletionStore.claim) sees
 * no devices and no windows, so the anonymous events on that device are
 * never found again. They do not merely survive: they survive as ANONYMOUS
 * data, which nothing suppresses, because suppression is keyed by person. An
 * innocent-looking reordering turns a deletion into a leak. Do not reorder
 * these steps, and do not "optimise" by running them concurrently — the
 * ordering guarantee only holds if events genuinely finish before identity
 * starts.
 *
 * The predicate comes from `scope`, resolved by the caller through
 * `resolvePersonScope` against Postgres directly — never re-derived here
 * through the ClickHouse identity dictionaries, which lag Postgres by up to
 * 15 seconds (LIFETIME(MIN 5 MAX 15) — see dictionaries.ts). A binding
 * written moments before the request would not yet be visible there, and
 * those events would survive a purge that reported success.
 *
 * Every mutation runs with `mutations_sync = 1` — see `mutate` above.
 *
 * Idempotent by construction: every step is a delete predicated on the
 * person (or, for events_dead_letter, on this person's own ids), so running
 * this twice — the exact shape of the lease's crash recovery — finds nothing
 * left to do on the second pass and is a safe no-op.
 */
export async function purgePerson(opts: {
  ch: ClickHouseClient
  pg: Pool
  projectId: number
  scope: PersonScope
}): Promise<void> {
  const { ch, pg, projectId, scope } = opts

  // 1. events. Chunked, because a person's windows are devices x rebinds and
  // this must never refuse: the person read caps at MAX_PERSON_RANGE_CLAUSES
  // and answers 400, which is a fine answer for a profile view and an
  // unacceptable one for an erasure request. The union of the chunks is the
  // whole predicate, and each chunk is independently a no-op on re-run.
  // chunkWindows always yields at least one chunk, even for zero windows —
  // a person whose every event carries their own user_id (no device window
  // ever needed) still gets those events deleted by the first (and only)
  // chunk's group-only predicate.
  for (const [i, chunk] of chunkWindows(scope.windows, MAX_PERSON_RANGE_CLAUSES).entries()) {
    const params: Record<string, unknown> = { projectId }
    const identity = personEventsPredicate({ group: scope.group, windows: chunk }, params, `c${i}_`)
    await mutate(
      ch,
      `ALTER TABLE events DELETE WHERE project_id = {projectId:UInt32} AND ${identity}`,
      params,
    )
  }

  // 2 & 3. device_index and person_traits are keyed by RAW identity
  // (anonymous_id, user_id) with no event timestamp to split on, so they are
  // deleted wholesale for this person's ids and devices.
  //
  // ACCEPTED CONSEQUENCE, stated rather than discovered later: on a device
  // genuinely shared with another person, the anonymous rows aggregate both,
  // and deleting them loses the co-tenant's DERIVED aggregates for that
  // device. Their raw events survive untouched in `events` (step 1's
  // predicate is time-split and exact against the erased person's own
  // windows only), so nothing about the co-tenant is lost that was not
  // recomputable; keeping the rows instead would retain the erased person's
  // own first_seen/last_seen/event_count and context attributes, which is
  // retaining their personal data. Privacy wins this trade.
  const idParams = { projectId, group: scope.group, devices: scope.devices }
  const rawIdentity =
    'project_id = {projectId:UInt32} AND (user_id IN {group:Array(String)}' +
    " OR (user_id = '' AND anonymous_id IN {devices:Array(String)}))"
  await mutate(ch, `ALTER TABLE device_index DELETE WHERE ${rawIdentity}`, idParams)
  await mutate(ch, `ALTER TABLE person_traits DELETE WHERE ${rawIdentity}`, idParams)

  // 4. events_dead_letter holds REJECTED payloads verbatim, with no identity
  // columns to match on — only the raw JSON. Matching the quoted form of
  // each id (`"alice"`) rather than the bare substring keeps `bob` from
  // matching inside `bobby`; it is still a substring match over unparsed
  // text, which is the most that can be said about a payload that failed to
  // parse. Erring toward deleting a diagnostic row is the right direction
  // here. One known gap, not worth code against: buildDeadLetterRow
  // (ingest/routes.ts) truncates the stored payload at 8000 characters, so a
  // cut that lands mid-token can leave e.g. `…"user_id":"alice` with no
  // closing quote — the quoted-form match below then misses it. The
  // alternative (matching the bare substring) reintroduces the `bob`-inside-
  // `bobby` collision this quoting exists to prevent, which is the worse
  // failure mode of the two.
  await mutate(
    ch,
    `ALTER TABLE events_dead_letter DELETE WHERE project_id = {projectId:UInt32}
       AND arrayExists(x -> position(payload, concat('"', x, '"')) > 0, {ids:Array(String)})`,
    { projectId, ids: scope.ids },
  )

  // 5. Identity, last. Bindings are removed only where the PERSON matches,
  // never by device: a bind row handing that device to someone else is the
  // co-tenant's data, not this person's, and deleting it would destroy their
  // windows. The erased person's own events are already gone by now, so the
  // co-tenant's remaining tiles widening over the vacated period reveals
  // nothing about the erased person.
  await pg.query('DELETE FROM identity_bindings WHERE project_id = $1 AND person_id = ANY($2)', [
    projectId,
    scope.group,
  ])
  await pg.query(
    `DELETE FROM person_aliases
      WHERE project_id = $1 AND (person_id = ANY($2) OR canonical_id = ANY($2))`,
    [projectId, scope.group],
  )

  // suppressed_persons is deliberately NOT deleted, here or ever — see
  // 008_deletion_requests.sql. The row is what stops a restored backup of
  // the event store from resurrecting this person.
  //
  // event_schema is deliberately NOT touched: it records which event names
  // and property keys a project has ever used, with no identity column and
  // no per-person row. Nothing in it is personal data, and deleting from it
  // would corrupt autocomplete for the whole project.
}
