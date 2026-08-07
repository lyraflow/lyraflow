import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  CursorError,
  MEMBER_PAGE_SIZE,
  MEMBER_WINDOW_MAX,
  SegmentQuery,
  SegmentValidationError,
  compileSegment,
  treeHash,
  type Cursor,
} from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Project, ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import { SERVER_KEY_HEADER, makeAuthenticator } from '../ingest/routes.js'
import { SegmentCache, type MemberRow } from './cache.js'
import { SegmentTimeoutError, runSegment, runSegmentMembers } from './execute.js'

export interface SegmentDeps {
  projects: ProjectCache
  readiness: Readiness
  ch: ClickHouseClient
  /** The configured ClickHouse database; the dictionaries live in it. */
  database: string
}

/**
 * The preview options that sit alongside the tree. Parsed separately from
 * SegmentQuery so an unknown `include` value is a field-level 400 rather than
 * a silently ignored key — a caller that asked for something and did not get
 * it should be told, not left to infer.
 */
const PreviewOptions = z.object({
  include: z.array(z.enum(['members'])).max(1).optional(),
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
 */
interface WalkCursor {
  cursor: Cursor
  pagesServed: number
}

/**
 * Derives a per-project HMAC key from `project.serverKeyHash` — already a
 * per-project, server-side, stable secret this process holds for every
 * authenticated request (see `Project.serverKeyHash`) — via a labelled
 * subkey rather than the raw hash, so this specific use stays
 * cryptographically independent of any other future use of the same stored
 * value. Needs no new configuration or key management: nothing is generated
 * or stored beyond what auth already required.
 */
function cursorSigningKey(project: Pick<Project, 'serverKeyHash'>): Buffer {
  return createHmac('sha256', project.serverKeyHash)
    .update('lyraflow.segment-cursor.v1')
    .digest()
}

function signCursorPayload(payload: string, key: Buffer): string {
  return createHmac('sha256', key).update(payload).digest('base64url')
}

/**
 * Encodes this route's own wire cursor. Only this function ever produces one
 * — see `decodeWalkCursor` for why nothing else, including core's public
 * `encodeCursor`, is accepted back.
 */
function encodeWalkCursor(cursor: Cursor, pagesServed: number, key: Buffer): string {
  const payload = JSON.stringify([cursor.lastSeen, cursor.personId, cursor.asOf, pagesServed])
  const signature = signCursorPayload(payload, key)
  return Buffer.from(
    JSON.stringify([cursor.lastSeen, cursor.personId, cursor.asOf, pagesServed, signature]),
  ).toString('base64url')
}

/**
 * Decodes and verifies the wire cursor. Anything that is not a validly
 * signed cursor issued by THIS route for THIS project is rejected outright
 * — including a well-formed, unsigned cursor built with core's public
 * `encodeCursor`. That function's existence and export do not obligate this
 * route to accept its output: this route mints its own cursors and a caller
 * gets no credit for reconstructing something that merely looks like one.
 *
 * Every failure — malformed base64/JSON, wrong shape, or a signature that
 * does not verify — collapses to `CursorError`, same as core's
 * `decodeCursor`: a caller cannot act differently on "not a cursor" than on
 * "forged cursor", and the distinction would only ever reach a log.
 */
function decodeWalkCursor(s: string, key: Buffer): WalkCursor {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    throw new CursorError()
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 5 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    typeof parsed[2] !== 'string' ||
    typeof parsed[3] !== 'number' ||
    !Number.isInteger(parsed[3]) ||
    parsed[3] < 0 ||
    typeof parsed[4] !== 'string'
  ) {
    throw new CursorError()
  }
  const [lastSeen, personId, asOf, pagesServed, signature] = parsed
  const payload = JSON.stringify([lastSeen, personId, asOf, pagesServed])
  const expected = Buffer.from(signCursorPayload(payload, key))
  const given = Buffer.from(signature)

  // timingSafeEqual throws on a length mismatch instead of returning false —
  // and a length mismatch already means "not a valid signature" — so it is
  // handled explicitly rather than letting a short/long forged signature
  // crash the request instead of 400ing it.
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw new CursorError()
  }

  return { cursor: { lastSeen, personId, asOf }, pagesServed }
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
export function registerSegmentRoutes(app: FastifyInstance, deps: SegmentDeps): void {
  const { projects, readiness, ch, database } = deps

  const authenticateServer = makeAuthenticator(
    readiness,
    SERVER_KEY_HEADER,
    (key) => projects.byServerKey(key),
    'missing_server_key',
    'invalid_server_key',
  )

  const cache = new SegmentCache()

  /**
   * Runs a parsed tree and shapes the response.
   *
   * The cache key includes the cursor position, so each page is its own
   * entry — but every page of one walk carries the `as_of` of the page that
   * produced it, which is what stops a walk from claiming three different
   * instants. It also includes the select mode, because the two modes return
   * different shapes under the same tree.
   */
  async function runTree(
    project: Project,
    query: SegmentQuery,
    opts: { wantMembers: boolean; cursor?: string },
  ) {
    const projectId = project.id
    const signingKey = cursorSigningKey(project)
    const walk = opts.cursor === undefined ? undefined : decodeWalkCursor(opts.cursor, signingKey)
    const cursor = walk?.cursor
    const pagesServed = walk?.pagesServed ?? 0
    const hash = treeHash({ ast_version: query.ast_version, filter: query.filter })

    // The walk's instant: minted on page 1, echoed by every later page from
    // its cursor. Never re-minted mid-walk.
    const asOf = cursor?.asOf ?? new Date().toISOString()

    // The count is a property of the TREE, not of a page, so it is cached
    // under a cursor-free key. Page 2 of a walk therefore costs one query,
    // not two — and every page of the walk reports the same total rather
    // than a total that shrinks as the cursor advances, which is what
    // `count() OVER ()` would have produced (it counts rows remaining after
    // the cursor predicate, verified against a live server).
    const countKey = `${projectId}:count:${hash}`
    let count = cache.get(countKey)?.count
    if (count === undefined) {
      const compiled = compileSegment({
        query,
        projectId,
        database,
        now: new Date(),
        select: 'count',
      })
      count = await runSegment({ client: ch, compiled })
      cache.set(countKey, { count, members: [], asOf })
    }

    if (!opts.wantMembers) {
      return { count, members: [] as MemberRow[], asOf, windowExhausted: false, pagesServed: 0 }
    }

    // The window ceiling, checked before any member query runs. A caller who
    // insists on walking past it is refused for the cost of a cursor decode,
    // not a ClickHouse round trip.
    if (pagesServed >= MAX_MEMBER_PAGES) {
      return { count, members: [] as MemberRow[], asOf, windowExhausted: true, pagesServed }
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
      cache.set(pageKey, { count, members, asOf: pageAsOf })
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

    return { count, members, asOf: pageAsOf, windowExhausted, pagesServed: pagesServedNow }
  }

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
        warnings: compiled.warnings,
        as_of: result.asOf,
        ...(wantMembers
          ? {
              members: result.members,
              next_cursor:
                canOfferNext && last
                  ? encodeWalkCursor(
                      { lastSeen: last.last_seen, personId: last.person_id, asOf: result.asOf },
                      result.pagesServed,
                      cursorSigningKey(project),
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
}
