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
}
