import {
  type CostWarning,
  type Cursor,
  FunnelDefinition,
  FunnelStep,
  FunnelValidationError,
  MEMBER_PAGE_SIZE,
  MEMBER_WINDOW_MAX,
  Params,
  type SegmentQuery,
  compileFunnel,
  compileSegment,
  validateFunnel,
} from '@lyraflow/core'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Authenticate } from '../auth/bridge.js'
import type { Project } from '../auth/project-cache.js'
import { parseNumericId } from '../numeric-id.js'
import { type WalkCursor, makeWalkCursorCodec } from '../query/walk-cursor.js'
import { SegmentTimeoutError, runSegment } from '../segments/execute.js'
import { SegmentStore, StoredTreeError } from '../segments/store.js'
import { runDropoff, runFunnel, runPeople } from './execute.js'
import {
  DuplicateFunnelNameError,
  FunnelStore,
  type ListedFunnel,
  StoredDefinitionError,
  type StoredFunnel,
} from './store.js'

export interface FunnelDeps {
  authenticate: Authenticate
  ch: ClickHouseClient
  pg: Pool
  /** The configured ClickHouse database; the dictionaries live in it. */
  database: string
}

const DEFAULT_RANGE_MS = 7 * 86_400_000

/**
 * The furthest a caller may page through a funnel-step population, whether
 * that is `/dropoff` or `/people`. Same budget as the segment members walk,
 * and for the same reason: these endpoints preview a population, they do not
 * export one.
 */
const MAX_PEOPLE_PAGES = Math.ceil(MEMBER_WINDOW_MAX / MEMBER_PAGE_SIZE)

/**
 * Its own label, so a cursor minted for a segment walk cannot be replayed
 * against a funnel drop-off even within one project.
 */
const walkCursors = makeWalkCursorCodec('lyraflow.funnel-dropoff-cursor.v1')

/**
 * Its own label too, distinct from `walkCursors` above — a cursor minted for
 * `/people` pages a different `levelPredicate` (`reached` OR `dropped`) than
 * `/dropoff` always pages (`dropped` only). Replaying one route's cursor
 * against the other would resume a keyset walk computed over a different
 * population, which is exactly the reasoning `walk-cursor.ts`'s own comment
 * gives for the segments-vs-funnels split.
 */
const peopleCursors = makeWalkCursorCodec('lyraflow.funnel-people-cursor.v1')

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
    // One nested object rather than two flat fields, so a client cannot
    // receive half a range. `null` means the cached counts came from a run
    // that predates migration 016, or that there are no cached counts --
    // either way the rate beside them must not be labelled with a window.
    last_range: f.lastRange,
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
const RangeBody = z
  .object({
    // A RELATIVE range: the last `days` days, both ends derived from one
    // reading of this server's clock. It exists because a client cannot
    // express a relative range through `since` alone without straddling two
    // clocks -- see `resolveRange` for what that cost.
    days: z.number().int().positive().optional(),
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
  })
  // Refused rather than resolved by precedence. Either could reasonably be
  // what the caller meant, and whichever one lost would produce a window
  // they did not ask for and have no way to notice they did not ask for.
  .refine((b) => b.days === undefined || (b.since === undefined && b.until === undefined), {
    message: '`days` cannot be combined with `since` or `until`',
  })

const DropoffBody = z.object({
  // 1-indexed, matching the `index` in a run response.
  step: z.number().int().positive(),
  cursor: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
})

const PeopleBody = z.object({
  // 1-indexed, matching the `index` in a run response.
  step: z.number().int().positive(),
  // No default: `reached` (level >= step) and `dropped` (level = step) differ
  // by a factor of three on a real funnel, and whichever way a default fell,
  // the other reading is what a caller gets by accident.
  //
  // `skipped` is optional steps only: reached the required step this one
  // branches off, and did not do this one. It is the complement of
  // `reached` at that branch point.
  mode: z.enum(['reached', 'dropped', 'skipped']),
  cursor: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
})

/** See `numeric-id.ts`'s `parseNumericId` for the shape this enforces and why. */
function parseId(raw: string): number | null {
  return parseNumericId(raw)
}

/**
 * Whether a step index names an optional step. 1-indexed, matching every
 * other `step` on these routes.
 *
 * The two modes it gates are refused rather than approximated: `dropped` on
 * an optional step is "stopped exactly at a step that is not on the chain",
 * which is not a population, and `skipped` on a required step means nothing
 * at all. Answering either would hand back a number for a different
 * question with full confidence.
 */
function stepIsOptional(steps: FunnelStep[], step: number): boolean {
  return steps[step - 1]?.optional === true
}

export function registerFunnelRoutes(app: FastifyInstance, deps: FunnelDeps): void {
  const { authenticate, ch, pg, database } = deps
  const store = new FunnelStore(pg)
  const segments = new SegmentStore(pg)

  /**
   * Resolves the range for a run. Defaults to the last seven days so a bare
   * `POST /v1/funnels/:id/run` is the useful thing rather than an error, and
   * the resolved range is echoed in every response — a defaulted window that
   * is not stated is exactly the number someone screenshots and misreads.
   */
  function resolveRange(body: unknown): { since: Date; until: Date } | null {
    const parsed = RangeBody.safeParse(body ?? {})
    if (!parsed.success) return null
    // ONE `new Date()`, and every branch below measures from it. This is the
    // whole of the fix for "Last 90 days" answering `the range may span at
    // most 90 days`: a client can only express a relative range as `since:
    // <now> - 90d`, and when `until` then defaulted to a SECOND reading of a
    // DIFFERENT machine's clock, the span was 90 days plus the request's
    // flight time. The cap allows exactly 90 and refuses anything past it,
    // so the one range a picker offering "Last 90 days" can produce was the
    // one range the server would never accept.
    const now = new Date()
    if (parsed.data.days !== undefined) {
      return { since: new Date(now.getTime() - parsed.data.days * 86_400_000), until: now }
    }
    const until = parsed.data.until ? new Date(parsed.data.until) : now
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
    peopleAt?: {
      step: number
      mode: 'reached' | 'dropped' | 'skipped'
      select: 'ids' | 'members' | 'count'
      cursor?: Cursor
    },
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
      peopleAt,
    })
    return { compiled, extraWarnings }
  }

  function rangeWire(range: { since: Date; until: Date }) {
    return { since: range.since.toISOString(), until: range.until.toISOString() }
  }

  /**
   * The single derivation both run paths use.
   *
   * #21 was that the saved-segment run response omitted warnings the ad-hoc
   * preview returns. Having two entry points is fine; computing the same
   * thing twice is what drifts, so `/preview` and `/:id/run` both end here
   * and neither assembles a response of its own. `/v1/segments/preview` and
   * `/v1/segments/:id/preview` now follow the same shape via `runTree` in
   * segments/routes.ts.
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
    const project = await authenticate(req, reply)
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
    const project = await authenticate(req, reply)
    if (!project) return
    const funnels = await store.list(project.id)
    return reply.code(200).send({ funnels: funnels.map(toWire) })
  })

  app.get<{ Params: { id: string } }>('/v1/funnels/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
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
    const project = await authenticate(req, reply)
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
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_funnel_id' })
    const removed = await store.remove(project.id, id)
    if (!removed) return reply.code(404).send({ error: 'funnel_not_found' })
    return reply.code(204).send()
  })

  app.post('/v1/funnels/preview', async (req, reply) => {
    const project = await authenticate(req, reply)
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
    const project = await authenticate(req, reply)
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
        // The range this run actually used, not the list's default. Without it
        // the cached rate answered a question nobody could see (#91).
        range,
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

  /**
   * The people who reached step N and stopped there.
   *
   * A preview of a population, not an export of it — same contract as the
   * segment members page, same `MEMBER_PAGE_SIZE`, same `MEMBER_WINDOW_MAX`
   * ceiling, and the same signed cursor so a walk's position cannot be forged
   * or replayed against another route.
   */
  app.post<{ Params: { id: string } }>('/v1/funnels/:id/dropoff', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_funnel_id' })

    const body = DropoffBody.safeParse(req.body ?? {})
    if (!body.success) return reply.code(400).send({ error: 'invalid dropoff request' })
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

    // 1-indexed, matching the `index` in a run response. Stated in the error
    // because a 0-indexed caller would otherwise silently read step 2's
    // drop-offs as step 1's.
    if (body.data.step > funnel.steps.length) {
      return reply
        .code(400)
        .send({ error: `step must be between 1 and ${funnel.steps.length}`, code: 'step' })
    }

    // `/dropoff` hard-codes `mode: 'dropped'`, so on an optional step it
    // would silently answer a different question. `/people` is the route
    // with the vocabulary for this.
    if (stepIsOptional(funnel.steps, body.data.step)) {
      return reply.code(400).send({
        error: `step ${body.data.step} is optional; use POST /v1/funnels/${id}/people with \`reached\` or \`skipped\``,
        code: 'mode',
      })
    }

    const signingKey = walkCursors.signingKey(project)
    let walk: WalkCursor | undefined
    try {
      walk =
        body.data.cursor === undefined
          ? undefined
          : walkCursors.decode(body.data.cursor, signingKey)
    } catch {
      return reply.code(400).send({ error: 'invalid cursor' })
    }

    const now = new Date()
    // Every page of one walk describes the same instant, carried in the
    // cursor — otherwise page 2 would be computed against a later `now` than
    // page 1 and the two could disagree about who entered.
    const asOf = walk ? new Date(walk.cursor.asOf) : now

    try {
      // The same compile path the run uses, so a drop-off list inherits the
      // segment restriction and the suppression filter rather than a second
      // assembly of them.
      const { compiled } = await compileFor(project, funnel, range, asOf, {
        step: body.data.step,
        // `/dropoff` has always meant "stopped exactly here" -- pinned
        // explicitly rather than left to a default, same reasoning as
        // `PeopleBody.mode` above.
        mode: 'dropped',
        select: 'ids',
        cursor: walk?.cursor,
      })
      const people = await runDropoff({ client: ch, compiled })
      const pagesServed = (walk?.pagesServed ?? 0) + 1
      const windowExhausted = pagesServed >= MAX_PEOPLE_PAGES
      const last = people.at(-1)
      const canOfferNext = people.length === MEMBER_PAGE_SIZE && !windowExhausted
      return reply.code(200).send({
        step: body.data.step,
        people,
        range: rangeWire(range),
        as_of: asOf.toISOString(),
        next_cursor:
          canOfferNext && last
            ? walkCursors.encode(
                {
                  lastSeen: last.entered_at,
                  personId: last.person_id,
                  asOf: asOf.toISOString(),
                },
                pagesServed,
                signingKey,
              )
            : null,
        window_exhausted: windowExhausted,
      })
    } catch (err) {
      if (err instanceof FunnelValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code })
      }
      if (err instanceof SegmentTimeoutError) return reply.code(422).send({ error: err.message })
      throw err
    }
  })

  /**
   * The people at step N — either everyone who REACHED it (`level >= step`,
   * the population a chart bar labelled with that step's count means) or
   * everyone who STOPPED there (`level = step`, `/dropoff`'s population).
   *
   * Same preview contract as `/dropoff` and the segment members page: the
   * same `MEMBER_PAGE_SIZE`, the same `MEMBER_WINDOW_MAX` ceiling, and its
   * own signed cursor (`peopleCursors`, not `walkCursors`) so a walk's
   * position cannot be forged or replayed against another route.
   *
   * `mode` has no default — see `PeopleBody` above.
   */
  app.post<{ Params: { id: string } }>('/v1/funnels/:id/people', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_funnel_id' })

    const body = PeopleBody.safeParse(req.body ?? {})
    if (!body.success) return reply.code(400).send({ error: 'invalid people request' })
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

    // 1-indexed, matching the `index` in a run response and `/dropoff`'s own
    // message -- a 0-indexed caller would otherwise silently read step 2's
    // people as step 1's.
    if (body.data.step > funnel.steps.length) {
      return reply
        .code(400)
        .send({ error: `step must be between 1 and ${funnel.steps.length}`, code: 'step' })
    }

    const optionalStep = stepIsOptional(funnel.steps, body.data.step)
    if (optionalStep && body.data.mode === 'dropped') {
      return reply.code(400).send({
        error: `step ${body.data.step} is optional; ask for \`reached\` or \`skipped\` rather than \`dropped\``,
        code: 'mode',
      })
    }
    if (!optionalStep && body.data.mode === 'skipped') {
      return reply.code(400).send({
        error: `step ${body.data.step} is required, so nobody can skip it; ask for \`reached\` or \`dropped\``,
        code: 'mode',
      })
    }

    const signingKey = peopleCursors.signingKey(project)
    let walk: WalkCursor | undefined
    try {
      walk =
        body.data.cursor === undefined
          ? undefined
          : peopleCursors.decode(body.data.cursor, signingKey)
    } catch {
      return reply.code(400).send({ error: 'invalid cursor' })
    }

    const now = new Date()
    // Every page of one walk describes the same instant, carried in the
    // cursor -- otherwise page 2 would be computed against a later `now`
    // than page 1 and the two could disagree about who entered.
    const asOf = walk ? new Date(walk.cursor.asOf) : now

    try {
      const { compiled } = await compileFor(project, funnel, range, asOf, {
        step: body.data.step,
        mode: body.data.mode,
        select: 'members',
        cursor: walk?.cursor,
      })
      const members = await runPeople({ client: ch, compiled })

      // A SEPARATE compiled query, at the SAME `asOf` the page and cursor
      // pin -- never the funnel run's own `steps[i].people`, which is the
      // same number for `reached` but computed at a different instant.
      // MemberList's own comment says why that gap matters: comparing a
      // stale count against a page length is exactly how "that is everyone"
      // gets printed over a truncated preview.
      const { compiled: countCompiled } = await compileFor(project, funnel, range, asOf, {
        step: body.data.step,
        mode: body.data.mode,
        select: 'count',
      })
      const personCount = await runSegment({ client: ch, compiled: countCompiled })

      const pagesServed = (walk?.pagesServed ?? 0) + 1
      const windowExhausted = pagesServed >= MAX_PEOPLE_PAGES
      const last = members.at(-1)
      const canOfferNext = members.length === MEMBER_PAGE_SIZE && !windowExhausted
      return reply.code(200).send({
        members,
        person_count: personCount,
        range: rangeWire(range),
        as_of: asOf.toISOString(),
        next_cursor:
          canOfferNext && last
            ? peopleCursors.encode(
                {
                  lastSeen: last.entered_at,
                  personId: last.person_id,
                  asOf: asOf.toISOString(),
                },
                pagesServed,
                signingKey,
              )
            : null,
        window_exhausted: windowExhausted,
      })
    } catch (err) {
      if (err instanceof FunnelValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code })
      }
      if (err instanceof SegmentTimeoutError) return reply.code(422).send({ error: err.message })
      throw err
    }
  })
}
