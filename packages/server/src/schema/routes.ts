import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Authenticate } from '../auth/bridge.js'

export interface SchemaDeps {
  authenticate: Authenticate
  ch: ClickHouseClient
}

/** Bounded because event_schema's cardinality is bounded only by abuse controls. */
export const SCHEMA_MAX_LIMIT = 100

const Query = z.object({
  q: z.string().max(128).optional(),
  event: z.string().max(128).optional(),
  limit: z.coerce.number().int().positive().max(SCHEMA_MAX_LIMIT).default(50),
})

/** `trait` is REQUIRED, unlike `event` on the properties route. There is no
 * useful "values of every trait" read — the values of `plan` and the values
 * of `country` share no namespace — and, more to the point, an omitted trait
 * would turn the scan documented on the route below into a scan with no
 * filter at all. */
const TraitValueQuery = z.object({
  trait: z.string().min(1).max(128),
  q: z.string().max(128).optional(),
  limit: z.coerce.number().int().positive().max(SCHEMA_MAX_LIMIT).default(50),
})

/**
 * Autocomplete source for the segment builder.
 *
 * Deliberately thin. The shape autocomplete eventually wants — prefix or
 * fuzzy, ranked by frequency or recency or name — is a UX question that only
 * has an answer once a builder screen exists, so this ships as the raw read
 * any of those can be built on rather than a guess at one of them. No
 * frequency ranking: event_schema carries no counts, and adding them is a
 * different feature.
 *
 * Server-key gated: a project's event taxonomy is a description of its
 * product, not something the browser-shipped write key should reach.
 */
export function registerSchemaRoutes(app: FastifyInstance, deps: SchemaDeps): void {
  const { authenticate, ch } = deps

  app.get('/v1/schema/events', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const q = Query.safeParse(req.query)
    if (!q.success) return reply.code(400).send({ error: 'invalid query' })

    const rs = await ch.query({
      query: `SELECT DISTINCT event_name FROM event_schema
               WHERE project_id = {projectId:UInt32}
                 AND ({q:String} = '' OR startsWith(event_name, {q:String}))
               ORDER BY event_name ASC
               LIMIT {limit:UInt32}`,
      query_params: { projectId: project.id, q: q.data.q ?? '', limit: q.data.limit },
      format: 'JSONEachRow',
    })
    return reply.code(200).send({ events: await rs.json<{ event_name: string }>() })
  })

  app.get('/v1/schema/properties', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const q = Query.safeParse(req.query)
    if (!q.success) return reply.code(400).send({ error: 'invalid query' })

    const rs = await ch.query({
      query: `SELECT DISTINCT property_key, value_kind FROM event_schema
               WHERE project_id = {projectId:UInt32}
                 AND ({event:String} = '' OR event_name = {event:String})
                 AND ({q:String} = '' OR startsWith(property_key, {q:String}))
               ORDER BY property_key ASC
               LIMIT {limit:UInt32}`,
      query_params: {
        projectId: project.id,
        event: q.data.event ?? '',
        q: q.data.q ?? '',
        limit: q.data.limit,
      },
      format: 'JSONEachRow',
    })
    return reply
      .code(200)
      .send({ properties: await rs.json<{ property_key: string; value_kind: string }>() })
  })

  /**
   * The values one trait actually holds, so the segment builder can stop
   * asking an operator to guess whether a plan is `pro`, `Pro` or `tier_2`.
   * Getting that wrong produces a segment that is silently empty rather than
   * an error, which is why the guess is worth removing.
   *
   * THIS READ IS EXPENSIVE, and unlike its two neighbours above it does not
   * get cheaper with a narrower filter. `person_traits` is ordered by
   * `(project_id, anonymous_id, user_id, trait_key)`, so `trait_key` is the
   * LAST key part: filtering on it without an identity cannot seek, and the
   * query reads the project's whole trait partition every time. The two
   * routes above read `event_schema`, a purpose-built catalogue with one row
   * per (event, property); this one scans a fact table with one row per
   * person per trait.
   *
   * Three things follow, and all three are load-bearing rather than
   * stylistic:
   *
   *  - the `LIMIT` is not optional. It caps what is RETURNED, not what is
   *    read, so it is a response-size bound and not a cost bound — but it is
   *    the only one this shape admits;
   *  - `q` is a prefix filter, matching the other two routes, so a typing
   *    operator narrows rather than re-reads a growing list;
   *  - the CLIENT must call this only on an explicit interaction — a focus
   *    or a keystroke in the value field — never eagerly on render. That is
   *    deliberately the opposite of how the trait-NAME field behaves, which
   *    fetches before the first keystroke because it reads the cheap
   *    catalogue. One partition scan per rendered condition row would be
   *    indefensible in a product that ships cost warnings.
   *
   * String values only. `has_num` is what distinguishes a numeric trait from
   * a string one, and a numeric trait's `value_str` is the meaningless
   * default `''` documented in `004_person_traits.sql` — a picklist of ages
   * or revenue figures would not help anyone anyway. There is deliberately
   * no second `value_str != ''` guard on top: with `has_num = 0` in place the
   * only rows it could remove are traits a project genuinely set to the empty
   * string, and hiding a recorded value is not this endpoint's job.
   *
   * Server-key gated for the same reason as its neighbours — the values a
   * project's traits take are a description of its customers.
   */
  app.get('/v1/schema/trait-values', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const q = TraitValueQuery.safeParse(req.query)
    if (!q.success) return reply.code(400).send({ error: 'invalid query' })

    // The inner GROUP BY is the `traits` CTE's own idiom (`compile.ts`):
    // AggregatingMergeTree holds argMax STATES, so one row per
    // (project, identity, trait_key) only exists after `argMaxMerge`. No
    // person resolution, though — the question is which values exist, not
    // who holds them, and two devices that later merge into one person
    // contribute the same value either way.
    const rs = await ch.query({
      query: `SELECT DISTINCT value FROM (
                SELECT
                  argMaxMerge(value_str) AS value,
                  argMaxMerge(has_num)   AS has_num
                FROM person_traits
                WHERE project_id = {projectId:UInt32} AND trait_key = {trait:String}
                GROUP BY project_id, anonymous_id, user_id, trait_key
              )
              WHERE has_num = 0
                AND ({q:String} = '' OR startsWith(value, {q:String}))
              ORDER BY value ASC
              LIMIT {limit:UInt32}`,
      query_params: {
        projectId: project.id,
        trait: q.data.trait,
        q: q.data.q ?? '',
        limit: q.data.limit,
      },
      format: 'JSONEachRow',
    })
    return reply.code(200).send({ values: await rs.json<{ value: string }>() })
  })
}
