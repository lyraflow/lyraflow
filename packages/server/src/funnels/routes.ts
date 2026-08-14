import {
  type CostWarning,
  FunnelDefinition,
  FunnelStep,
  FunnelValidationError,
  Params,
  type SegmentQuery,
  compileFunnel,
  compileSegment,
  validateFunnel,
} from '@lyraflow/core'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Project, ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
import { SegmentTimeoutError } from '../segments/execute.js'
import { SegmentStore, StoredTreeError } from '../segments/store.js'
import { runFunnel } from './execute.js'
import {
  DuplicateFunnelNameError,
  FunnelStore,
  type ListedFunnel,
  StoredDefinitionError,
  type StoredFunnel,
} from './store.js'

export interface FunnelDeps {
  projects: ProjectCache
  readiness: Readiness
  ch: ClickHouseClient
  pg: Pool
  /** The configured ClickHouse database; the dictionaries live in it. */
  database: string
}

const DEFAULT_RANGE_MS = 7 * 86_400_000

/** Wire shape — snake_case, like every other endpoint. */
function toWire(f: StoredFunnel | ListedFunnel) {
  return {
    id: f.id,
    name: f.name,
    definition_version: f.definitionVersion,
    steps: f.steps,
    window_seconds: f.windowSeconds,
    segment_id: f.segmentId,
    // Always present, `false` for every ordinary row, so a client checks one
    // field regardless of which route the object came from.
    stale: 'stale' in f ? f.stale : false,
    last_entered: f.lastEntered,
    last_converted: f.lastConverted,
    last_evaluated_at: f.lastEvaluatedAt,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  }
}

const CreateBody = z.object({ name: z.string().min(1).max(200) })
const PatchBody = z.object({
  name: z.string().min(1).max(200).optional(),
  steps: z.array(FunnelStep).min(2).optional(),
  window_seconds: z.number().int().positive().optional(),
  segment_id: z.number().int().positive().nullable().optional(),
})

/**
 * `since`/`until` are per-run, never stored — the window belongs to the
 * funnel, the range to the question being asked this time.
 */
const RangeBody = z.object({
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
})

function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

export function registerFunnelRoutes(app: FastifyInstance, deps: FunnelDeps): void {
  const { projects, readiness, ch, pg, database } = deps
  const store = new FunnelStore(pg)
  const segments = new SegmentStore(pg)

  const authenticateServer = makeAuthenticator(
    readiness,
    SERVER_KEY_HEADER,
    (key) => projects.byServerKey(key),
    'missing_server_key',
    'invalid_server_key',
  )

  /**
   * Resolves the range for a run. Defaults to the last seven days so a bare
   * `POST /v1/funnels/:id/run` is the useful thing rather than an error, and
   * the resolved range is echoed in every response — a defaulted window that
   * is not stated is exactly the number someone screenshots and misreads.
   */
  function resolveRange(body: unknown): { since: Date; until: Date } | null {
    const parsed = RangeBody.safeParse(body ?? {})
    if (!parsed.success) return null
    const until = parsed.data.until ? new Date(parsed.data.until) : new Date()
    const since = parsed.data.since
      ? new Date(parsed.data.since)
      : new Date(until.getTime() - DEFAULT_RANGE_MS)
    return { since, until }
  }

  /**
   * Compiles a funnel, resolving a segment restriction if it has one.
   *
   * ONE `Params` is threaded through both compilations. Names are positional,
   * so compiling the segment separately and merging its map afterwards would
   * silently overwrite the funnel's own `p0`.
   *
   * A `segment_id` naming a segment that no longer exists is not an error: the
   * funnel runs over everyone and says so. Deleting a segment must not break
   * every report built on it, but it does change what those reports mean, and
   * a silent widening of the population is the worst way to learn that.
   */
  async function compileFor(
    project: Project,
    funnel: { steps: FunnelStep[]; windowSeconds: number; segmentId: number | null },
    range: { since: Date; until: Date },
    now: Date,
  ): Promise<{ compiled: ReturnType<typeof compileFunnel>; extraWarnings: CostWarning[] }> {
    const params = new Params()
    const extraWarnings: CostWarning[] = []
    let segmentPersonSql: string | undefined

    if (funnel.segmentId !== null) {
      let segment = null
      try {
        segment = await segments.get(project.id, funnel.segmentId)
      } catch (err) {
        // A segment whose stored tree no longer parses cannot restrict
        // anything. Same treatment as a deleted one: run wide, and say why.
        if (!(err instanceof StoredTreeError)) throw err
      }
      if (segment) {
        segmentPersonSql = compileSegment({
          query: { ast_version: segment.astVersion, filter: segment.filter } as SegmentQuery,
          projectId: project.id,
          database,
          now,
          select: 'persons',
          params,
        }).sql
      } else {
        extraWarnings.push({
          path: 'segment_id',
          reason: `segment ${funnel.segmentId} no longer exists or cannot be read, so this funnel ran over everyone rather than the population it names`,
        })
      }
    }

    const compiled = compileFunnel({
      definition: {
        steps: funnel.steps,
        window_seconds: funnel.windowSeconds,
        segment_id: funnel.segmentId,
      },
      projectId: project.id,
      database,
      range,
      now,
      params,
      segmentPersonSql,
    })
    return { compiled, extraWarnings }
  }

  function rangeWire(range: { since: Date; until: Date }) {
    return { since: range.since.toISOString(), until: range.until.toISOString() }
  }

  /**
   * The single derivation both run paths use.
   *
   * #21 is open because the saved-segment run response omits warnings the
   * ad-hoc preview returns. Having two entry points is fine; computing the
   * same thing twice is what drifts, so `/preview` and `/:id/run` both end
   * here and neither assembles a response of its own.
   */
  async function execute(
    project: Project,
    funnel: { steps: FunnelStep[]; windowSeconds: number; segmentId: number | null },
    range: { since: Date; until: Date },
  ) {
    const now = new Date()
    const { compiled, extraWarnings } = await compileFor(project, funnel, range, now)
    const result = await runFunnel({ client: ch, compiled, steps: funnel.steps })
    const warnings = [...compiled.warnings, ...extraWarnings]
    if (result.partial_window_entrants > 0) {
      warnings.push({
        path: 'range',
        reason: `${result.partial_window_entrants} of the people who entered did so too recently to have had the full ${funnel.windowSeconds}-second window, and can still convert`,
      })
    }
    return {
      entered: result.entered,
      converted: result.converted,
      conversion_rate: result.conversion_rate,
      steps: result.steps,
      partial_window_entrants: result.partial_window_entrants,
      range: rangeWire(range),
      as_of: now.toISOString(),
      warnings,
      result,
    }
  }

  app.post('/v1/funnels', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return
    const meta = CreateBody.safeParse(req.body)
    const definition = FunnelDefinition.safeParse(req.body)
    if (!meta.success || !definition.success) {
      return reply.code(400).send({ error: 'invalid funnel' })
    }
    // Shape-valid is not cap-valid. Without this a 9-step funnel would save
    // with a 201 and then fail on every single run — a funnel that looks fine
    // until someone uses it.
    try {
      validateFunnel(definition.data)
    } catch (err) {
      if (err instanceof FunnelValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code })
      }
      throw err
    }
    try {
      const created = await store.create(project.id, meta.data.name, definition.data)
      return reply.code(201).send(toWire(created))
    } catch (err) {
      if (err instanceof DuplicateFunnelNameError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  app.get('/v1/funnels', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return
    const funnels = await store.list(project.id)
    return reply.code(200).send({ funnels: funnels.map(toWire) })
  })

  app.get<{ Params: { id: string } }>('/v1/funnels/:id', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_funnel_id' })
    try {
      const found = await store.get(project.id, id)
      if (!found) return reply.code(404).send({ error: 'funnel_not_found' })
      return reply.code(200).send(toWire(found))
    } catch (err) {
      if (err instanceof StoredDefinitionError) {
        return reply
          .code(400)
          .send({ error: err.message, definition_version: err.definitionVersion })
      }
      throw err
    }
  })

  app.patch<{ Params: { id: string } }>('/v1/funnels/:id', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_funnel_id' })
    const patch = PatchBody.safeParse(req.body)
    if (!patch.success) {
      return reply.code(400).send({
        error: 'invalid funnel',
        detail: patch.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    // Cap-check whatever the patch would produce, not just what it carries: a
    // PATCH raising only the window past the cap must fail here rather than on
    // every subsequent run.
    const current = await store.get(project.id, id).catch((err) => {
      if (err instanceof StoredDefinitionError) return null
      throw err
    })
    if (!current) return reply.code(404).send({ error: 'funnel_not_found' })
    try {
      validateFunnel({
        steps: patch.data.steps ?? current.steps,
        window_seconds: patch.data.window_seconds ?? current.windowSeconds,
      })
    } catch (err) {
      if (err instanceof FunnelValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code })
      }
      throw err
    }
    try {
      const updated = await store.update(project.id, id, {
        name: patch.data.name,
        steps: patch.data.steps,
        windowSeconds: patch.data.window_seconds,
        segmentId: patch.data.segment_id,
      })
      if (!updated) return reply.code(404).send({ error: 'funnel_not_found' })
      return reply.code(200).send(toWire(updated))
    } catch (err) {
      if (err instanceof DuplicateFunnelNameError) {
        return reply.code(409).send({ error: err.message })
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/v1/funnels/:id', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_funnel_id' })
    const removed = await store.remove(project.id, id)
    if (!removed) return reply.code(404).send({ error: 'funnel_not_found' })
    return reply.code(204).send()
  })

  app.post('/v1/funnels/preview', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return
    const definition = FunnelDefinition.safeParse(req.body)
    if (!definition.success) {
      return reply.code(400).send({
        error: 'invalid funnel',
        detail: definition.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      })
    }
    const range = resolveRange(req.body)
    if (!range) return reply.code(400).send({ error: 'invalid range' })
    try {
      const { result: _result, ...body } = await execute(
        project,
        {
          steps: definition.data.steps,
          windowSeconds: definition.data.window_seconds,
          segmentId: definition.data.segment_id ?? null,
        },
        range,
      )
      return reply.code(200).send(body)
    } catch (err) {
      if (err instanceof FunnelValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code })
      }
      if (err instanceof SegmentTimeoutError) return reply.code(422).send({ error: err.message })
      throw err
    }
  })

  app.post<{ Params: { id: string } }>('/v1/funnels/:id/run', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_funnel_id' })
    const range = resolveRange(req.body)
    if (!range) return reply.code(400).send({ error: 'invalid range' })

    let funnel: StoredFunnel | null
    try {
      funnel = await store.get(project.id, id)
    } catch (err) {
      if (err instanceof StoredDefinitionError) {
        return reply
          .code(400)
          .send({ error: err.message, definition_version: err.definitionVersion })
      }
      throw err
    }
    if (!funnel) return reply.code(404).send({ error: 'funnel_not_found' })

    try {
      const { result, ...body } = await execute(project, funnel, range)
      // A cache, not a fact: written after every run, never recomputed, and
      // always rendered next to its timestamp.
      await store.recordRun(project.id, id, {
        entered: result.entered,
        converted: result.converted,
        at: new Date(),
      })
      return reply.code(200).send(body)
    } catch (err) {
      if (err instanceof FunnelValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code })
      }
      if (err instanceof SegmentTimeoutError) return reply.code(422).send({ error: err.message })
      throw err
    }
  })
}
