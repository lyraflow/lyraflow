/**
 * `lyraflow deletions`, `lyraflow segments`, `lyraflow schema` — three small,
 * mostly-read command groups grouped in one file because none of them is
 * big enough to earn its own, unlike `persons` (which carries the
 * irreversible `delete` path and its own substantial docstring).
 */

import { UsageError, parseCommandArgs } from '../args.js'
import type { CommandContext } from '../context.js'
import { type Column, type Mode, emitObject, emitRecords, resolveMode } from '../output.js'
import {
  checkNoPositionals,
  checkStrayFlags,
  reportCommandFailure,
  reportParseFailure,
  reportUsageError,
} from './command-support.js'

/** Flags every subcommand in this file accepts, regardless of which one
 * runs — see `checkStrayFlags`'s own docstring for why a per-subcommand
 * check is needed on top of this. */
const UNIVERSAL_FLAGS = new Set(['host', 'server-key', 'json', 'human'])

// ---------------------------------------------------------------------------
// deletions
// ---------------------------------------------------------------------------

/** GET /v1/deletions/:id's response shape (privacy/routes.ts) — status is
 * one of four literal strings; every other field is conditionally present
 * per status, so this is intentionally loose rather than a discriminated
 * union the CLI would have to keep in lockstep with the server's own. */
interface DeletionStatusRecord {
  status: string
  requested_at: string
  completed_at: string | null
  error?: string | null
}

const DELETIONS_USAGE = 'usage: lyraflow deletions get <id> [--json|--human]'

async function runDeletionsGet(id: string, mode: Mode, ctx: CommandContext): Promise<number> {
  try {
    const status = await ctx.client.get<DeletionStatusRecord>(
      `/v1/deletions/${encodeURIComponent(id)}`,
    )
    emitObject(status, mode, ctx.write)
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}

/**
 * `lyraflow deletions get <id> [--json|--human]`
 *
 * One subcommand today (`get`) — kept as a subcommand rather than a bare
 * `lyraflow deletions <id>` for symmetry with `persons`, and so a second
 * verb has somewhere to go later without a breaking reshape.
 */
export async function runDeletions(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  let positionals: string[]
  let positionalIndexes: number[]
  let positionalContext: (string | undefined)[]
  try {
    ;({ flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(argv, {
      strings: ['host', 'server-key'],
      booleans: ['json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, argv, ctx)
  }

  const mode = resolveMode(flags, ctx.isTty)
  const [subcommand, id] = positionals

  if (subcommand === undefined) {
    return reportUsageError(new UsageError(DELETIONS_USAGE), mode, ctx)
  }
  if (subcommand !== 'get') {
    // No `subcommand` interpolation — same reasoning as persons.ts's
    // identical guard: this slot can hold anything, including a value that
    // was meant to go somewhere else entirely.
    return reportUsageError(
      new UsageError(`unknown deletions subcommand (${DELETIONS_USAGE})`),
      mode,
      ctx,
    )
  }
  if (id === undefined) {
    return reportUsageError(
      new UsageError(`deletions get requires an id (${DELETIONS_USAGE})`),
      mode,
      ctx,
    )
  }
  const positionalsCode = checkNoPositionals(
    {
      positionals: positionals.slice(2),
      positionalContext: positionalContext.slice(2),
      positionalIndexes: positionalIndexes.slice(2),
    },
    mode,
    ctx,
  )
  if (positionalsCode !== undefined) return positionalsCode

  const strayFlagsCode = checkStrayFlags(flags, UNIVERSAL_FLAGS, mode, ctx)
  if (strayFlagsCode !== undefined) return strayFlagsCode

  return runDeletionsGet(id, mode, ctx)
}

// ---------------------------------------------------------------------------
// segments
// ---------------------------------------------------------------------------

/** One row of GET /v1/segments (segments/routes.ts's `toWire`). */
interface SegmentRecord {
  id: number
  name: string
  ast_version: number
  filter: unknown
  stale: boolean
  last_count: number | null
  last_evaluated_at: string | null
  created_at: string
  updated_at: string
}

interface SegmentsListResponse {
  segments: SegmentRecord[]
}

/** One row of a segment run's `members` (segments/cache.ts's `MemberRow`) —
 * `person_id`/`first_seen`/`last_seen` are guaranteed; anything else is a
 * context field this table does not attempt to show. */
interface MemberRecord {
  person_id: string
  first_seen: string
  last_seen: string
  [field: string]: string | number
}

/** POST /v1/segments/:id/preview's response shape (segments/routes.ts,
 * the SAVED-segment run — no `warnings` field, unlike the ad-hoc preview
 * route this CLI does not call). */
interface SegmentRunResponse {
  person_count: number
  as_of: string
  members?: MemberRecord[]
  next_cursor?: string | null
  window_exhausted?: boolean
}

/**
 * Human-mode table columns for `segments list`. Narrow enough to fit a
 * terminal line: id/name to identify the segment, last_count/
 * last_evaluated_at to say whether it has ever run, stale to flag a stored
 * tree this CLI could not parse (see toWire's own docstring — `stale` is
 * always present so a client can check one field regardless of source).
 * Task 9 depends on these exact field names.
 */
const SEGMENTS_COLUMNS: Column[] = [
  { header: 'id', get: (row: SegmentRecord) => String(row.id) },
  { header: 'name', get: (row: SegmentRecord) => row.name },
  { header: 'last_count', get: (row: SegmentRecord) => String(row.last_count ?? '') },
  { header: 'last_evaluated_at', get: (row: SegmentRecord) => row.last_evaluated_at ?? '' },
  { header: 'stale', get: (row: SegmentRecord) => String(row.stale) },
]

/** Human-mode table columns for `segments run <id> --members`. Task 9
 * depends on these exact field names. */
const MEMBERS_COLUMNS: Column[] = [
  { header: 'person_id', get: (row: MemberRecord) => row.person_id },
  { header: 'first_seen', get: (row: MemberRecord) => row.first_seen },
  { header: 'last_seen', get: (row: MemberRecord) => row.last_seen },
]

const SEGMENTS_USAGE =
  'usage: lyraflow segments <list|run <id> [--members] [--cursor <c>]> [--json|--human]'

const SEGMENTS_RUN_ALLOWED = new Set([...UNIVERSAL_FLAGS, 'members', 'cursor'])

async function runSegmentsList(mode: Mode, ctx: CommandContext): Promise<number> {
  try {
    const res = await ctx.client.get<SegmentsListResponse>('/v1/segments')
    emitRecords(res.segments, mode, SEGMENTS_COLUMNS, ctx.write)
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}

/**
 * `segments run <id>` — POST /v1/segments/:id/preview. Without `--members`
 * the response carries only a count; WITH it, the response also carries a
 * `members` page. `members` (a real list of records) goes to stdout through
 * `emitRecords`, same as every other list this CLI prints; the summary
 * fields (`person_count`, `as_of`, `next_cursor`, `window_exhausted`) go to
 * stderr via `emitObject` — the same "stdout stays a pure record stream"
 * rule `events.ts`'s `--follow` already established for its own
 * `next_cursor`. Without `--members`, there is no record list at all, so
 * the summary is the ONLY output and goes to stdout instead — an agent
 * asking only for a count should not have to read stderr to get it.
 *
 * `--cursor` without `--members` is rejected outright rather than sent:
 * the server's own cursor decodes a walk POSITION through the members
 * page (`decodeWalkCursor`, segments/routes.ts) — with no `include:
 * ["members"]` in the request body, there is no page to resume, so this
 * combination can only ever 400, or (if the server ever loosened that)
 * silently adopt the cursor's own stale `as_of` for a plain count nobody
 * asked to be pinned to one. Caught here, client-side, the same reasoning
 * `events.ts`'s own inverted-window check uses: a usage error the caller
 * can fix beats a request that was always going to be nonsensical.
 */
async function runSegmentsRun(
  id: string,
  flags: Record<string, string | boolean>,
  mode: Mode,
  ctx: CommandContext,
): Promise<number> {
  const wantMembers = flags.members === true
  const cursor = typeof flags.cursor === 'string' ? flags.cursor : undefined

  if (cursor !== undefined && !wantMembers) {
    return reportUsageError(
      new UsageError('--cursor requires --members (there is no members page to resume otherwise)'),
      mode,
      ctx,
    )
  }

  const body: Record<string, unknown> = {
    ...(wantMembers ? { include: ['members'] } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  }

  try {
    const res = await ctx.client.post<SegmentRunResponse>(
      `/v1/segments/${encodeURIComponent(id)}/preview`,
      body,
    )
    const { members, ...summary } = res
    if (wantMembers) {
      emitRecords(members ?? [], mode, MEMBERS_COLUMNS, ctx.write)
      emitObject(summary, mode, ctx.writeErr)
    } else {
      emitObject(summary, mode, ctx.write)
    }
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}

/**
 * `lyraflow segments <list|run <id> [--members] [--cursor <c>]> [--json|--human]`
 */
export async function runSegments(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  let positionals: string[]
  let positionalIndexes: number[]
  let positionalContext: (string | undefined)[]
  try {
    ;({ flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(argv, {
      strings: ['host', 'server-key', 'cursor'],
      booleans: ['members', 'json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, argv, ctx)
  }

  const mode = resolveMode(flags, ctx.isTty)
  const [subcommand, id] = positionals

  if (subcommand === undefined) {
    return reportUsageError(new UsageError(SEGMENTS_USAGE), mode, ctx)
  }

  if (subcommand === 'list') {
    const positionalsCode = checkNoPositionals(
      {
        positionals: positionals.slice(1),
        positionalContext: positionalContext.slice(1),
        positionalIndexes: positionalIndexes.slice(1),
      },
      mode,
      ctx,
    )
    if (positionalsCode !== undefined) return positionalsCode
    const strayFlagsCode = checkStrayFlags(flags, UNIVERSAL_FLAGS, mode, ctx)
    if (strayFlagsCode !== undefined) return strayFlagsCode
    return runSegmentsList(mode, ctx)
  }

  if (subcommand === 'run') {
    if (id === undefined) {
      return reportUsageError(
        new UsageError(`segments run requires an id (${SEGMENTS_USAGE})`),
        mode,
        ctx,
      )
    }
    const positionalsCode = checkNoPositionals(
      {
        positionals: positionals.slice(2),
        positionalContext: positionalContext.slice(2),
        positionalIndexes: positionalIndexes.slice(2),
      },
      mode,
      ctx,
    )
    if (positionalsCode !== undefined) return positionalsCode
    const strayFlagsCode = checkStrayFlags(flags, SEGMENTS_RUN_ALLOWED, mode, ctx)
    if (strayFlagsCode !== undefined) return strayFlagsCode
    return runSegmentsRun(id, flags, mode, ctx)
  }

  // Same "never echo the unrecognised word" rule as persons.ts/deletions
  // above — this slot could hold anything.
  return reportUsageError(
    new UsageError(`unknown segments subcommand (${SEGMENTS_USAGE})`),
    mode,
    ctx,
  )
}

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

interface SchemaEventRecord {
  event_name: string
}

interface SchemaEventsResponse {
  events: SchemaEventRecord[]
}

interface SchemaPropertyRecord {
  property_key: string
  value_kind: string
}

interface SchemaPropertiesResponse {
  properties: SchemaPropertyRecord[]
}

const SCHEMA_EVENTS_COLUMNS: Column[] = [
  { header: 'event_name', get: (row: SchemaEventRecord) => row.event_name },
]

const SCHEMA_PROPERTIES_COLUMNS: Column[] = [
  { header: 'property_key', get: (row: SchemaPropertyRecord) => row.property_key },
  { header: 'value_kind', get: (row: SchemaPropertyRecord) => row.value_kind },
]

const SCHEMA_USAGE =
  'usage: lyraflow schema <events|properties> [--q <prefix>] [--event <name>] [--limit <n>] [--json|--human]'

/** `--event` is `properties`-only — `schema events --event X` parses (the
 * group's own `ArgSpec` has to accept `--event` for `properties`) and
 * would otherwise silently do nothing. */
const SCHEMA_EVENTS_ALLOWED = new Set([...UNIVERSAL_FLAGS, 'q', 'limit'])
const SCHEMA_PROPERTIES_ALLOWED = new Set([...UNIVERSAL_FLAGS, 'q', 'event', 'limit'])

/**
 * Matches the server's own `SCHEMA_MAX_LIMIT` (schema/routes.ts) and its
 * `Query` schema's `.default(50)` — pinned against that source directly in
 * catalog.test.ts, same technique `events.ts` uses for its own limit
 * constants, so the two cannot silently drift.
 */
export const SCHEMA_DEFAULT_LIMIT = 50
export const SCHEMA_MAX_LIMIT = 100

function parseSchemaLimit(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new UsageError(`--limit must be a positive integer, got "${raw}"`)
  }
  const n = Number(raw)
  if (n > SCHEMA_MAX_LIMIT) {
    throw new UsageError(`--limit must be at most ${SCHEMA_MAX_LIMIT}, got "${raw}"`)
  }
  return n
}

async function runSchemaEvents(
  flags: Record<string, string | boolean>,
  mode: Mode,
  ctx: CommandContext,
): Promise<number> {
  let limit: number
  try {
    limit = typeof flags.limit === 'string' ? parseSchemaLimit(flags.limit) : SCHEMA_DEFAULT_LIMIT
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportUsageError(err, mode, ctx)
  }
  const q = typeof flags.q === 'string' ? flags.q : undefined

  try {
    const res = await ctx.client.get<SchemaEventsResponse>('/v1/schema/events', { q, limit })
    emitRecords(res.events, mode, SCHEMA_EVENTS_COLUMNS, ctx.write)
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}

async function runSchemaProperties(
  flags: Record<string, string | boolean>,
  mode: Mode,
  ctx: CommandContext,
): Promise<number> {
  let limit: number
  try {
    limit = typeof flags.limit === 'string' ? parseSchemaLimit(flags.limit) : SCHEMA_DEFAULT_LIMIT
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportUsageError(err, mode, ctx)
  }
  const q = typeof flags.q === 'string' ? flags.q : undefined
  const event = typeof flags.event === 'string' ? flags.event : undefined

  try {
    const res = await ctx.client.get<SchemaPropertiesResponse>('/v1/schema/properties', {
      q,
      event,
      limit,
    })
    emitRecords(res.properties, mode, SCHEMA_PROPERTIES_COLUMNS, ctx.write)
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}

/**
 * `lyraflow schema <events|properties> [--q <prefix>] [--event <name>] [--limit <n>] [--json|--human]`
 */
export async function runSchema(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  let positionals: string[]
  let positionalIndexes: number[]
  let positionalContext: (string | undefined)[]
  try {
    ;({ flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(argv, {
      strings: ['host', 'server-key', 'q', 'event', 'limit'],
      booleans: ['json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, argv, ctx)
  }

  const mode = resolveMode(flags, ctx.isTty)
  const [subcommand] = positionals

  if (subcommand === undefined) {
    return reportUsageError(new UsageError(SCHEMA_USAGE), mode, ctx)
  }
  if (subcommand !== 'events' && subcommand !== 'properties') {
    return reportUsageError(
      new UsageError(`unknown schema subcommand (${SCHEMA_USAGE})`),
      mode,
      ctx,
    )
  }

  const positionalsCode = checkNoPositionals(
    {
      positionals: positionals.slice(1),
      positionalContext: positionalContext.slice(1),
      positionalIndexes: positionalIndexes.slice(1),
    },
    mode,
    ctx,
  )
  if (positionalsCode !== undefined) return positionalsCode

  const strayFlagsCode = checkStrayFlags(
    flags,
    subcommand === 'events' ? SCHEMA_EVENTS_ALLOWED : SCHEMA_PROPERTIES_ALLOWED,
    mode,
    ctx,
  )
  if (strayFlagsCode !== undefined) return strayFlagsCode

  return subcommand === 'events'
    ? runSchemaEvents(flags, mode, ctx)
    : runSchemaProperties(flags, mode, ctx)
}
