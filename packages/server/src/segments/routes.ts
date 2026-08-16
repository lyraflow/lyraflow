import {
  type Cursor,
  CursorError,
  MEMBER_PAGE_SIZE,
  MEMBER_WINDOW_MAX,
  SegmentQuery,
  SegmentValidationError,
  compileSegment,
  costWarnings,
  treeHash,
  validateTree,
} from '@lyraflow/core'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Authenticate } from '../auth/bridge.js'
import type { Project } from '../auth/project-cache.js'
import { parseNumericId } from '../numeric-id.js'
import { makeWalkCursorCodec } from '../query/walk-cursor.js'
import type { MemberRow, SegmentCache } from './cache.js'
import { SegmentTimeoutError, runSegment, runSegmentMembers } from './execute.js'
import {
  DuplicateNameError,
  type ListedSegment,
  SegmentStore,
  type StoredSegment,
  StoredTreeError,
} from './store.js'

export interface SegmentDeps {
  authenticate: Authenticate
  ch: ClickHouseClient
  pg: Pool
  /** The configured ClickHouse database; the dictionaries live in it. */
  database: string
  /**
   * Shared with the privacy routes, not constructed here — DELETE
   * /v1/persons/:id calls `cache.clearProject()` on this exact instance the
   * moment a deletion is accepted, so a preview served from cache can never
   * hand back a suppressed person's row within the TTL. A second,
   * locally-constructed cache would make that invalidation call reach an
   * instance nothing here ever reads from.
   */
  cache: SegmentCache
}

/**
 * Maps a stored segment to the wire shape — snake_case, like every other
 * endpoint. Also accepts `ListedSegment` (see store.ts) — the shape `list()`
 * returns for a row it could not parse — so a bad row surfaces on the wire as
 * `filter: null, stale: true` rather than the whole list request 400ing.
 * `stale` is always present, `false` for every ordinary row, so a client can
 * check one field regardless of which route it came from.
 */
function toWire(s: StoredSegment | ListedSegment) {
  return {
    id: s.id,
    name: s.name,
    ast_version: s.astVersion,
    filter: s.filter,
    stale: 'stale' in s ? s.stale : false,
    last_count: s.lastCount,
    last_evaluated_at: s.lastEvaluatedAt,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  }
}

const CreateBody = z.object({ name: z.string().min(1).max(200) })
const PatchBody = z.object({ name: z.string().min(1).max(200).optional() })

/**
 * Whether a PATCH body claims to carry a filter tree at all, checked on the
 * RAW body rather than on `SegmentQuery.safeParse(...).success`. Those two
 * are not the same question: a body can fail to parse as a `SegmentQuery`
 * either because it carries no tree fields (a legitimate rename-only PATCH)
 * or because it carries a MALFORMED tree — and collapsing both to
 * `query.success === false` is exactly how a malformed tree used to be
 * treated as "no tree sent" (see the PATCH route below, and the finding this
 * closes): `store.update` was called with `query: undefined`, its COALESCEs
 * no-opped, and the route answered 200 with the OLD filter unchanged instead
 * of rejecting the bad one.
 */
function bodyCarriesTreeFields(body: unknown): boolean {
  return typeof body === 'object' && body !== null && ('ast_version' in body || 'filter' in body)
}

/**
 * Parses the `:id` path param. A non-numeric or non-positive id is a
 * malformed request, not a lookup miss — unlike the cross-project 404 case,
 * there is no existence to leak by rejecting it outright, so this returns
 * 400 rather than folding into the "not found" path. See `numeric-id.ts`'s
 * `parseNumericId` for the shape this enforces and why.
 */
function parseSegmentId(raw: string): number | null {
  return parseNumericId(raw)
}

/**
 * The preview options that sit alongside the tree. Parsed separately from
 * SegmentQuery so an unknown `include` value is a field-level 400 rather than
 * a silently ignored key — a caller that asked for something and did not get
 * it should be told, not left to infer.
 */
const PreviewOptions = z.object({
  include: z
    .array(z.enum(['members']))
    .max(1)
    .optional(),
  cursor: z.string().max(512).optional(),
})

/**
 * The furthest a walk may page: `MEMBER_WINDOW_MAX` rows at `MEMBER_PAGE_SIZE`
 * each. Whole-number pages only — a partial final page is always a natural
 * end of the population, never a ceiling (see `decodeWalkCursor`).
 */
const MAX_MEMBER_PAGES = Math.floor(MEMBER_WINDOW_MAX / MEMBER_PAGE_SIZE)

/**
 * The wire cursor: the tree position (`Cursor`, from @lyraflow/core) plus a
 * count of pages already served in this walk, signed with an HMAC keyed per
 * project (see `cursorSigningKey`). The count is what lets
 * `MEMBER_WINDOW_MAX` be enforced; the signature is what stops a caller from
 * lying about it. `lastSeen`/`personId` alone are not secret — a caller reads
 * them straight off the response it already holds — so without a signature
 * anyone could hand-build a "page 2" cursor with `pagesServed` fixed at 1
 * forever and the ceiling would never trip. The signature is checked over
 * the WHOLE payload, so `lastSeen`/`personId` cannot be swapped in for a
 * different position either without invalidating it.
 *
 * The shared `Cursor` type from core stays untouched (still exactly
 * `lastSeen`/`personId`/`asOf`) — core's cursor tests deliberately pin that
 * shape ("nothing tenant-scoped can ride along"), and a page count and a
 * signature are not core's concern. This wraps it instead of widening it.
 *
 * This is a PRODUCT limit made tamper-evident, not a security boundary. The
 * signing key is derived from the caller's own project secret (see
 * `cursorSigningKey`), so the key holder — the operator paging their own
 * data — can in principle derive it too; what actually protects the
 * ClickHouse cluster is the per-query `LIMIT`, `SEGMENT_MAX_EXECUTION_SECONDS`
 * and `SEGMENT_MAX_MEMORY_BYTES` (see execute.ts), none of which cursor
 * forgery touches. Signing exists to stop the ACCIDENTAL and NAIVE path — a
 * hand-rolled cursor, or a client library built against the documented
 * shape — at zero infrastructure cost. Do not lean on it for anything where
 * the caller's incentive to defeat it changes, e.g. billing, quotas, or
 * export gating.
 */
interface UnusedWalkCursor {
  cursor: Cursor
  pagesServed: number
}

/**
 * POST /v1/segments/preview — count the people matching a filter tree, and
 * optionally return one bounded page of them.
 *
 * Server-key only, through the same makeAuthenticator/SERVER_KEY_HEADER as
 * /v1/alias and GET /v1/persons/:id rather than a fourth auth implementation.
 * The write key is public by design — it ships in browser JavaScript — and a
 * segment count is aggregate information about every person in the project.
 */
/**
 * The label is unchanged from when these helpers lived in this file, so every
 * cursor already issued stays valid. See query/walk-cursor.ts.
 */
const walkCursors = makeWalkCursorCodec('lyraflow.segment-cursor.v1')

export function registerSegmentRoutes(app: FastifyInstance, deps: SegmentDeps): void {
  const { authenticate, ch, pg, database, cache } = deps

  const store = new SegmentStore(pg)

  /**
   * Runs a parsed tree and shapes the response.
   *
   * The cache key includes the cursor position, so each page is its own
   * entry — but every page of one walk carries the `as_of` of the page that
   * produced it, which is what stops a walk from claiming three different
   * instants. It also includes the select mode, because the two modes return
   * different shapes under the same tree.
   *
   * #21 was that the saved-run response omitted the cost warnings the ad-hoc
   * preview returns, because each route assembled its own response and only
   * one of them read `compileSegment`'s warnings. This is the single
   * derivation both `/v1/segments/preview` and `/v1/segments/:id/preview` end
   * in now: `warnings` is computed once here, from the tree alone, and
   * returned on every path — cache hit or miss, count-only or with members —
   * so neither caller can assemble a response missing it.
   */
  async function runTree(
    project: Project,
    query: SegmentQuery,
    opts: { wantMembers: boolean; cursor?: string },
  ) {
    const projectId = project.id
    const signingKey = walkCursors.signingKey(project)
    const walk = opts.cursor === undefined ? undefined : walkCursors.decode(opts.cursor, signingKey)
    const cursor = walk?.cursor
    const pagesServed = walk?.pagesServed ?? 0
    const hash = treeHash({ ast_version: query.ast_version, filter: query.filter })
    // Pure function of the tree — same value regardless of select mode or
    // cache state, so it costs nothing to compute unconditionally rather than
    // only on the branches that happen to call compileSegment.
    const warnings = costWarnings(query)

    // The walk's instant: minted on page 1, echoed by every later page from
    // its cursor. Never re-minted mid-walk.
    const asOf = cursor?.asOf ?? new Date().toISOString()

    // The count is a property of the TREE, not of a page, so it is cached
    // under a cursor-free key. Page 2 of a walk therefore costs one query,
    // not two — and every page of the walk reports the same total rather
    // than a total that shrinks as the cursor advances, which is what
    // `count() OVER ()` would have produced (it counts rows remaining after
    // the cursor predicate, verified against a live server).
    //
    // A cache hit adopts the STORED as_of rather than the `asOf` minted above
    // for this request — mirroring the member path below. `asOf` is minted
    // before this cache is even consulted, so using it unconditionally would
    // stamp a cache HIT (a count computed possibly seconds ago) with an
    // instant no query actually ran at, silently over-claiming freshness on
    // every hit within the TTL. Only a genuine miss's freshly-computed count
    // gets the freshly-minted instant, because that is the one case where
    // they actually describe the same moment.
    const countKey = `${projectId}:count:${hash}`
    const cachedCount = cache.get(countKey)
    let count: number
    let countAsOf: string
    if (cachedCount) {
      count = cachedCount.count
      countAsOf = cachedCount.asOf
    } else {
      // Captured BEFORE the query below runs, not after — see
      // SegmentCache.set's own docstring for why the ordering matters: a
      // DELETE's clearProject() landing while this exact query is still in
      // flight against ClickHouse must make the `cache.set` below a no-op,
      // and it can only do that by comparing against the generation this
      // query started under, not whatever the generation happens to be once
      // the query finally returns.
      const countGeneration = cache.generation(projectId)
      const compiled = compileSegment({
        query,
        projectId,
        database,
        now: new Date(),
        select: 'count',
      })
      count = await runSegment({ client: ch, compiled })
      countAsOf = asOf
      cache.set(countKey, { count, members: [], asOf: countAsOf }, projectId, countGeneration)
    }

    if (!opts.wantMembers) {
      return {
        count,
        members: [] as MemberRow[],
        asOf: countAsOf,
        windowExhausted: false,
        pagesServed: 0,
        warnings,
      }
    }

    // The window ceiling, checked before any member query runs. A caller who
    // insists on walking past it is refused for the cost of a cursor decode,
    // not a ClickHouse round trip.
    if (pagesServed >= MAX_MEMBER_PAGES) {
      return {
        count,
        members: [] as MemberRow[],
        asOf,
        windowExhausted: true,
        pagesServed,
        warnings,
      }
    }

    const pageKey = `${projectId}:members:${opts.cursor ?? ''}:${hash}`
    const cachedPage = cache.get(pageKey)

    // A cache hit must be indistinguishable from a miss in the body it
    // produces (see cache.ts), so a hit reports the STORED as_of rather than
    // the one minted above for this request. The two agree whenever the hit
    // belongs to this same walk — pageKey embeds the whole wire cursor, which
    // embeds as_of, so a colliding key can only have been written by a
    // cursor carrying the identical instant. They can legitimately differ
    // only for two independent page-1 requests racing within the TTL, where
    // reporting the row set's actual instant is the honest answer, not
    // whichever request happened to arrive second.
    let members: MemberRow[]
    let pageAsOf: string
    if (cachedPage) {
      members = cachedPage.members
      pageAsOf = cachedPage.asOf
    } else {
      // Same reasoning as countGeneration above: captured before the query
      // that will produce the value this generation guards.
      const pageGeneration = cache.generation(projectId)
      const compiledMembers = compileSegment({
        query,
        projectId,
        database,
        now: new Date(),
        select: 'members',
        cursor,
      })
      members = await runSegmentMembers({ client: ch, compiled: compiledMembers })
      pageAsOf = asOf
      cache.set(pageKey, { count, members, asOf: pageAsOf }, projectId, pageGeneration)
    }

    const pagesServedNow = pagesServed + 1
    // MEMBER_WINDOW_MAX / MEMBER_PAGE_SIZE pages is the whole budget for a
    // walk, full stop — this is the page that spends the last of it, so it
    // is flagged exhausted here rather than making the caller find out via
    // an empty page on the request after this one. Independent of whether
    // this particular page happened to be full: past the ceiling this
    // endpoint stops previewing rather than trying to keep proving there is
    // more data to justify the label.
    const windowExhausted = pagesServedNow >= MAX_MEMBER_PAGES

    return {
      count,
      members,
      asOf: pageAsOf,
      windowExhausted,
      pagesServed: pagesServedNow,
      warnings,
    }
  }

  app.post('/v1/segments/preview', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const parsed = SegmentQuery.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid filter tree',
        detail: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }

    // Cap-check before anything else runs, the same way POST/PATCH
    // /v1/segments do — shape-valid (SegmentQuery.safeParse above) is not
    // cap-valid. `runTree` below would catch this too (compileSegment calls
    // the same validateTree on a cache miss), but failing here means a bad
    // tree costs a walk, not a cache lookup and a cursor decode.
    try {
      validateTree(parsed.data)
    } catch (err) {
      if (err instanceof SegmentValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code })
      }
      throw err
    }

    const options = PreviewOptions.safeParse(req.body ?? {})
    if (!options.success) {
      return reply.code(400).send({
        error: 'invalid preview options',
        detail: options.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    const wantMembers = options.data.include?.includes('members') ?? false

    try {
      const result = await runTree(project, parsed.data, {
        wantMembers,
        cursor: options.data.cursor,
      })
      const last = result.members.at(-1)
      // A next cursor is offered only while there is another page AND the
      // window has room for it. Past the ceiling the response says so rather
      // than truncating quietly — this endpoint previews a population, it
      // does not export one.
      const canOfferNext =
        wantMembers && result.members.length === MEMBER_PAGE_SIZE && !result.windowExhausted
      return reply.code(200).send({
        person_count: result.count,
        warnings: result.warnings,
        as_of: result.asOf,
        ...(wantMembers
          ? {
              members: result.members,
              next_cursor:
                canOfferNext && last
                  ? walkCursors.encode(
                      { lastSeen: last.last_seen, personId: last.person_id, asOf: result.asOf },
                      result.pagesServed,
                      walkCursors.signingKey(project),
                    )
                  : null,
              window_exhausted: result.windowExhausted,
            }
          : {}),
      })
    } catch (err) {
      if (err instanceof CursorError) return reply.code(400).send({ error: 'invalid cursor' })
      if (err instanceof SegmentTimeoutError) {
        return reply.code(422).send({ error: err.message })
      }
      throw err
    }
  })

  app.get('/v1/segments', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    // Unlike get/patch/run below, list() never throws StoredTreeError — a
    // row that fails to parse comes back marked `stale: true` instead (see
    // SegmentStore#list), so one bad row cannot take the rest of the list
    // down with it.
    const segments = await store.list(project.id)
    return reply.code(200).send({ segments: segments.map(toWire) })
  })

  app.post('/v1/segments', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const meta = CreateBody.safeParse(req.body)
    const query = SegmentQuery.safeParse(req.body)
    if (!meta.success || !query.success) {
      return reply.code(400).send({ error: 'invalid segment' })
    }
    // Shape-valid is not cap-valid: SegmentQuery.safeParse only checks the
    // AST's shape, never depth/node/behaviour caps. Without this, a tree
    // that is shape-valid but over-cap would save with a 201 and then fail
    // on every single run — a segment that looks fine until someone runs it.
    try {
      validateTree(query.data)
    } catch (err) {
      if (err instanceof SegmentValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code })
      }
      throw err
    }
    try {
      const created = await store.create(project.id, meta.data.name, query.data)
      return reply.code(201).send(toWire(created))
    } catch (err) {
      if (err instanceof DuplicateNameError) return reply.code(409).send({ error: err.message })
      throw err
    }
  })

  app.get<{ Params: { id: string } }>('/v1/segments/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseSegmentId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_segment_id' })
    try {
      const found = await store.get(project.id, id)
      if (!found) return reply.code(404).send({ error: 'segment_not_found' })
      return reply.code(200).send(toWire(found))
    } catch (err) {
      if (err instanceof StoredTreeError) {
        return reply.code(400).send({ error: err.message, ast_version: err.astVersion })
      }
      throw err
    }
  })

  app.patch<{ Params: { id: string } }>('/v1/segments/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseSegmentId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_segment_id' })
    const meta = PatchBody.safeParse(req.body)
    if (!meta.success) return reply.code(400).send({ error: 'invalid segment' })
    // A body carrying a tree updates the filter; one carrying only a name
    // does not, which is what keeps the snapshot on a rename (see
    // SegmentStore#update).
    const query = SegmentQuery.safeParse(req.body)
    // A tree was SENT but did not parse: reject outright, with field paths,
    // the same way POST /v1/segments would for the identical body. Without
    // this, `query.success === false` for a malformed tree is
    // indistinguishable below from "no tree in this body at all" — a
    // rename-only PATCH — and the malformed tree would be silently dropped
    // rather than rejected.
    if (!query.success && bodyCarriesTreeFields(req.body)) {
      return reply.code(400).send({
        error: 'invalid filter tree',
        detail: query.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      })
    }
    // Same cap check as create, and for the same reason — an update can
    // swap in a fresh over-cap tree just as easily as a create can start
    // with one. Skipped entirely for a rename-only body (query.success is
    // false), which carries no tree to validate.
    if (query.success) {
      try {
        validateTree(query.data)
      } catch (err) {
        if (err instanceof SegmentValidationError) {
          return reply.code(400).send({ error: err.message, code: err.code })
        }
        throw err
      }
    }
    try {
      const updated = await store.update(project.id, id, {
        name: meta.data.name,
        query: query.success ? query.data : undefined,
      })
      if (!updated) return reply.code(404).send({ error: 'segment_not_found' })
      return reply.code(200).send(toWire(updated))
    } catch (err) {
      if (err instanceof DuplicateNameError) return reply.code(409).send({ error: err.message })
      if (err instanceof StoredTreeError) {
        return reply.code(400).send({ error: err.message, ast_version: err.astVersion })
      }
      throw err
    }
  })

  app.delete<{ Params: { id: string } }>('/v1/segments/:id', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseSegmentId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_segment_id' })
    const removed = await store.remove(project.id, id)
    if (!removed) return reply.code(404).send({ error: 'segment_not_found' })
    return reply.code(204).send()
  })

  /**
   * Runs a SAVED segment's stored tree and records the result on it. Reuses
   * `runTree` — the same walk/cache/cursor machinery the ad-hoc preview route
   * above uses — rather than a second implementation, so the two can never
   * diverge on cursor signing, caching, or the window ceiling. That includes
   * `warnings` (#21): `runTree` computes them once from the tree itself and
   * returns them on every path, so this route reports the same warnings the
   * ad-hoc preview would for an identical tree, without assembling them
   * separately.
   */
  app.post<{ Params: { id: string } }>('/v1/segments/:id/preview', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return
    const id = parseSegmentId(req.params.id)
    if (id === null) return reply.code(400).send({ error: 'invalid_segment_id' })
    const options = PreviewOptions.safeParse(req.body ?? {})
    if (!options.success) return reply.code(400).send({ error: 'invalid preview options' })

    let found: StoredSegment | null
    try {
      found = await store.get(project.id, id)
    } catch (err) {
      if (err instanceof StoredTreeError) {
        return reply.code(400).send({ error: err.message, ast_version: err.astVersion })
      }
      throw err
    }
    if (!found) return reply.code(404).send({ error: 'segment_not_found' })

    // Already parsed once by #hydrate on the way out of the store — this
    // reconstructs the SegmentQuery shape runTree expects rather than
    // re-validating it.
    const query = { ast_version: found.astVersion, filter: found.filter } as SegmentQuery
    const wantMembers = options.data.include?.includes('members') ?? false
    try {
      const result = await runTree(project, query, {
        wantMembers,
        cursor: options.data.cursor,
      })
      // Both modes write the snapshot: the count is computed either way, so
      // asking for members must not leave a staler snapshot behind than
      // asking for a count would.
      await store.recordRun(project.id, found.id, result.count, new Date(result.asOf))
      const last = result.members.at(-1)
      const canOfferNext =
        wantMembers && result.members.length === MEMBER_PAGE_SIZE && !result.windowExhausted
      return reply.code(200).send({
        person_count: result.count,
        warnings: result.warnings,
        as_of: result.asOf,
        ...(wantMembers
          ? {
              members: result.members,
              next_cursor:
                canOfferNext && last
                  ? walkCursors.encode(
                      { lastSeen: last.last_seen, personId: last.person_id, asOf: result.asOf },
                      result.pagesServed,
                      walkCursors.signingKey(project),
                    )
                  : null,
              window_exhausted: result.windowExhausted,
            }
          : {}),
      })
    } catch (err) {
      if (err instanceof CursorError) return reply.code(400).send({ error: 'invalid cursor' })
      if (err instanceof SegmentTimeoutError) {
        return reply.code(422).send({ error: err.message })
      }
      // BACKSTOP, not the primary defence — create/update now call
      // validateTree before persisting, so a NEW segment can no longer save
      // over-cap. This stays for rows written before that check existed (or
      // if the caps are tightened again later): a stored tree can still fall
      // outside today's caps even though it once parsed fine, the same
      // "untrusted on read" situation StoredTreeError exists for, just
      // caught one level down inside compileSegment (via runTree) instead of
      // at hydration. Do not delete this as redundant with the write-time
      // check — it is not, for any row that predates it.
      if (err instanceof SegmentValidationError) {
        return reply.code(400).send({ error: err.message, code: err.code })
      }
      throw err
    }
  })
}
