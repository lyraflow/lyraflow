import type { ClickHouseClient, Pool } from '@lyraflow/db'
import {
  MAX_PERSON_RANGE_CLAUSES,
  type PersonScope,
  chunkWindows,
  personEventsPredicate,
} from '../identity/scope.js'
import { DEAD_LETTER_OWNED_BY_IDS } from './dead-letter.js'

/** `event_schema`'s key, joined with a separator no identifier can contain. */
function triple(eventName: string, propertyKey: string, kind: string): string {
  return `${eventName}\u0000${propertyKey}\u0000${kind}`
}

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
 *          -> identity_bindings / person_aliases -> event_schema
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

  // 0. What property keys did THIS person use, and on which event names?
  //
  // Captured BEFORE step 1 deletes their events, because afterwards the
  // question is unanswerable -- the rows carrying the answer are gone. That
  // ordering is the whole reason this is affordable: the alternative is
  // unrolling every surviving event's property maps for the entire project on
  // every deletion, and this unrolls one person's instead (#144).
  //
  // The two maps are read separately and tagged, because `event_schema` keys
  // on `value_kind` and one key name can legitimately exist as both a string
  // and a number.
  const ownedKeys = new Set<string>()
  for (const [i, chunk] of chunkWindows(scope.windows, MAX_PERSON_RANGE_CLAUSES).entries()) {
    const params: Record<string, unknown> = { projectId }
    const identity = personEventsPredicate({ group: scope.group, windows: chunk }, params, `p${i}_`)
    for (const [column, kind] of [
      ['properties', 'string'],
      ['properties_num', 'number'],
    ] as const) {
      const rs = await ch.query({
        query: `SELECT DISTINCT event_name, key AS property_key
                  FROM events ARRAY JOIN mapKeys(${column}) AS key
                 WHERE project_id = {projectId:UInt32} AND ${identity}`,
        query_params: params,
        format: 'JSONEachRow',
      })
      for (const r of await rs.json<{ event_name: string; property_key: string }>()) {
        ownedKeys.add(triple(r.event_name, r.property_key, kind))
      }
    }
  }

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

  // 4. events_dead_letter — see dead-letter.ts's own docstring for why the
  // predicate is a quoted-substring match, and why it lives there rather
  // than here.
  await mutate(
    ch,
    `ALTER TABLE events_dead_letter DELETE WHERE project_id = {projectId:UInt32}
       AND ${DEAD_LETTER_OWNED_BY_IDS}`,
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

  // 6. event_schema, but ONLY the event names that no longer have a single
  // event behind them.
  //
  // This step used to not exist, on the reasoning that event_schema "has no
  // identity column and no per-person row, so nothing in it is personal
  // data". The first half is true and the conclusion does not follow. An
  // event NAME can identify on its own -- `viewed_patient_record`, or a name
  // a customer fired exactly once -- and it survived the purge indefinitely
  // while the endpoint kept offering it (#66, observed on a live install).
  //
  // The other half of the old reasoning was that deleting from event_schema
  // "would corrupt autocomplete for the whole project". That is the real
  // constraint and it is why this is scoped the way it is: a name with zero
  // remaining events cannot corrupt an autocomplete, because it can never
  // match anything. It is already a lie. A name still carried by anyone
  // else's events is untouched.
  //
  // Two statements, not one mutation with a subquery, and deliberately:
  // ClickHouse mutations are expensive, and the overwhelmingly common case
  // after a purge is that nothing went stale. The SELECT is cheap and lets
  // the mutation be skipped entirely.
  const stale = await ch.query({
    query: `SELECT DISTINCT event_name FROM event_schema
             WHERE project_id = {projectId:UInt32}
               AND event_name NOT IN (
                 SELECT event_name FROM events WHERE project_id = {projectId:UInt32}
               )`,
    query_params: { projectId },
    format: 'JSONEachRow',
  })
  const staleNames = (await stale.json<{ event_name: string }>()).map((r) => r.event_name)
  if (staleNames.length > 0) {
    // A NARROW RACE, stated rather than left to be discovered. Ingest is
    // buffered, so an event name whose rows were all just purged could have
    // new events sitting in the buffer, unflushed and therefore invisible to
    // the SELECT above -- and this delete would then remove a row that is
    // about to become true again. It self-heals: the materialised views feed
    // event_schema on insert, so the next flush re-creates the row. The cost
    // is a brief gap in autocomplete for that one name, which is strictly
    // better than the alternative of never removing a purged name at all.
    await mutate(
      ch,
      `ALTER TABLE event_schema DELETE
        WHERE project_id = {projectId:UInt32} AND event_name IN {names:Array(String)}`,
      { projectId, names: staleNames },
    )
  }

  // 7. Property keys only this person ever sent.
  //
  // Step 6 removes an event NAME with nothing behind it, and every
  // `event_schema` row for that name goes with it. What survives step 6 is a
  // name other people still send -- and under it, a key only the erased person
  // ever supplied. If they alone sent `patient_id` on a `checkout` everyone
  // fires, `checkout` correctly stays and `patient_id` should not (#144).
  //
  // Only the pairs captured in step 0 are considered, so this asks a question
  // about one person's keys rather than scanning the project's whole
  // catalogue. A key that survives here is one some other event still carries.
  if (ownedKeys.size > 0) {
    const names = [...new Set([...ownedKeys].map((t) => t.split('\u0000')[0] as string))]
    const surviving = new Set<string>()
    for (const [column, kind] of [
      ['properties', 'string'],
      ['properties_num', 'number'],
    ] as const) {
      const rs = await ch.query({
        query: `SELECT DISTINCT event_name, key AS property_key
                  FROM events ARRAY JOIN mapKeys(${column}) AS key
                 WHERE project_id = {projectId:UInt32} AND event_name IN {names:Array(String)}`,
        query_params: { projectId, names },
        format: 'JSONEachRow',
      })
      for (const r of await rs.json<{ event_name: string; property_key: string }>()) {
        surviving.add(triple(r.event_name, r.property_key, kind))
      }
    }

    const stale = [...ownedKeys].filter((t) => !surviving.has(t))
    if (stale.length > 0) {
      // One mutation for all of them rather than one each: ClickHouse
      // mutations are expensive and this is already the slowest path here.
      // Matched on the JOINED key rather than an `(a, b, c) IN` tuple list:
      // the client serialises a JS array of arrays as `[[...]]`, which
      // ClickHouse refuses for `Array(Tuple(...))`. Concatenating with the
      // same NUL separator `triple()` uses sidesteps tuple parameter
      // encoding entirely, and NUL cannot occur in an event name or a
      // property key.
      await mutate(
        ch,
        `ALTER TABLE event_schema DELETE
          WHERE project_id = {projectId:UInt32}
            AND concat(event_name, '\\0', property_key, '\\0', value_kind) IN {keys:Array(String)}`,
        { projectId, keys: stale },
      )
    }
  }

  //
  // suppressed_persons is deliberately NOT deleted, here or ever — see
  // 008_deletion_requests.sql. The row is what stops a restored backup of
  // the event store from resurrecting this person.
}
