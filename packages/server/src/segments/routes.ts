import { SegmentQuery, SegmentValidationError, compileSegment } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import type { ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
import { SegmentTimeoutError, runSegment } from './execute.js'

export interface SegmentDeps {
  projects: ProjectCache
  readiness: Readiness
  ch: ClickHouseClient
  /** The configured ClickHouse database; the dictionaries live in it. */
  database: string
}

/**
 * POST /v1/segments/preview — count the people matching a filter tree.
 *
 * Server-key only, through the same makeAuthenticator/SERVER_KEY_HEADER as
 * /v1/alias and GET /v1/persons/:id rather than a fourth auth implementation.
 * The write key is public by design — it ships in browser JavaScript — and a
 * segment count is aggregate information about every person in the project.
 */
export function registerSegmentRoutes(app: FastifyInstance, deps: SegmentDeps): void {
  const { projects, readiness, ch, database } = deps

  const authenticateServer = makeAuthenticator(
    readiness,
    SERVER_KEY_HEADER,
    (key) => projects.byServerKey(key),
    'missing_server_key',
    'invalid_server_key',
  )

  app.post('/v1/segments/preview', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return

    const parsed = SegmentQuery.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid filter tree',
        detail: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    let compiled: ReturnType<typeof compileSegment>
    try {
      compiled = compileSegment({
        query: parsed.data,
        // Injected from the authenticated key. Nothing in the request body
        // reaches this, which is why a `project_id` field in the payload is
        // simply ignored rather than needing to be rejected.
        projectId: project.id,
        database,
        now: new Date(),
      })
    } catch (err) {
      if (err instanceof SegmentValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code })
      }
      throw err
    }

    try {
      const personCount = await runSegment({ client: ch, compiled })
      return reply.code(200).send({
        person_count: personCount,
        warnings: compiled.warnings,
        // The spec's consistency contract: show what instant the count
        // describes rather than implying it is live.
        as_of: new Date().toISOString(),
      })
    } catch (err) {
      if (err instanceof SegmentTimeoutError) {
        return reply.code(422).send({ error: err.message, warnings: compiled.warnings })
      }
      throw err
    }
  })
}
