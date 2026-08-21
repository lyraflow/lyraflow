/**
 * `lyraflow projects <list|delete|deletion get>` — the instance-scoped
 * project management group.
 *
 * ALONE AMONG THE COMMAND GROUPS, THIS ONE TALKS TO THE DATABASES DIRECTLY
 * rather than through `CommandContext['client']`. The routes it mirrors are
 * session-only (a cookie plus the UI header) precisely so that one project's
 * server key cannot enumerate or destroy another's, and the CLI holds no
 * session. So it follows `create-project` and `migrate` instead: env-supplied
 * Postgres and ClickHouse clients, no HTTP, and therefore no dependency on a
 * running server — which is also what lets `projects delete` work on an
 * install whose server is stopped.
 *
 * `delete` follows `persons delete`'s rules exactly, because they were argued
 * once already and are not re-decided here: `--yes` skips the prompt, a
 * non-TTY **stdin** without `--yes` exits 2 rather than waiting on a prompt
 * nobody can answer, and a declined prompt exits 1 having written nothing.
 * What differs is what counts as consent — the prompt asks for the SLUG, and
 * any answer that is not an exact match is a decline.
 */

import type { ClickHouseClient, Pool } from '@lyraflow/db'
import {
  type ProjectDeletionRequest,
  ProjectDeletionStore,
} from '@lyraflow/server/dist/project/deletion-store.js'
import {
  PURGE_TABLES,
  type PurgeProgress,
  purgeProject,
} from '@lyraflow/server/dist/project/purge.js'
import { type ArgSpec, UsageError, hasRawFlag, parseCommandArgs } from '../args.js'
import { type Column, type Mode, emitObject, emitRecords, resolveMode } from '../output.js'
import {
  checkNoPositionals,
  isEpipe,
  reportParseFailure,
  reportUsageError,
} from './command-support.js'

/**
 * The direct-database counterpart of `CommandContext` — see the module
 * docstring for why this group cannot use `CommandContext['client']`.
 * `stdinIsTty`/`stdoutIsTty` are named (not `isTty`) so a reader never has
 * to guess which stream a check answers for, the same split
 * `context.ts`'s own docstring argues for `CommandContext`. `prompt`
 * resolves the RAW typed answer (or `null` on close/timeout/error) rather
 * than a yes/no boolean — this group's confirmation is "type the slug",
 * not "type y" — so it cannot reuse `CommandContext['prompt']`'s shape
 * either.
 */
export interface AdminCommandContext {
  pg: Pool
  ch: ClickHouseClient
  write: (s: string) => void
  writeErr: (s: string) => void
  prompt: (question: string) => Promise<string | null>
  stdinIsTty: boolean
  stdoutIsTty: boolean
}

/**
 * The same knobs `ProjectPurgeWorker` claims under (`config.ts`'s
 * `projectPurgeLeaseMs`/`projectPurgeMaxAttempts` defaults) — exported so a
 * test can assert the two never drift apart. Claiming under anything looser
 * would let the CLI and the server worker both hold the same request at
 * once; the lease is what makes that race safe, and only if both sides
 * agree on its length.
 *
 * These are the FALLBACKS, not the whole story — see `resolvePurgeLeaseMs`/
 * `resolvePurgeMaxAttempts` below, which read the same env vars `config.ts`
 * reads before falling back to these. A tuned install (one that set
 * `LYRAFLOW_PROJECT_PURGE_LEASE_MS`/`_MAX_ATTEMPTS` away from the shipped
 * default) must have this CLI agree with the server it is talking to, not
 * silently claim under a lease the server itself no longer uses.
 */
export const PROJECT_PURGE_LEASE_MS = 1_800_000
export const PROJECT_PURGE_MAX_ATTEMPTS = 5

/**
 * Mirrors `config.ts`'s own `num()`: empty/unset reads as "use the
 * fallback", anything present that doesn't parse as a finite number is a
 * loud failure rather than a silently-ignored override.
 */
function envNumber(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a number, got "${raw}"`)
  }
  return parsed
}

/** The lease/attempts this process actually claims under — `config.ts`'s
 * own env vars, so an install that tuned the server's knobs away from the
 * shipped default gets a CLI that agrees with it, falling back to the same
 * defaults `PROJECT_PURGE_LEASE_MS`/`PROJECT_PURGE_MAX_ATTEMPTS` name. */
function resolvePurgeLeaseMs(): number {
  return envNumber('LYRAFLOW_PROJECT_PURGE_LEASE_MS', PROJECT_PURGE_LEASE_MS)
}
function resolvePurgeMaxAttempts(): number {
  return envNumber('LYRAFLOW_PROJECT_PURGE_MAX_ATTEMPTS', PROJECT_PURGE_MAX_ATTEMPTS)
}

/**
 * How long `runProjectsDelete` waits between the first `purgeProject` call
 * and its one retry, when rows reappeared (a running server's buffered
 * flush landing after the partition drop — see purge.ts's own docstring).
 * Comfortably past the server's default `flushIntervalMs` (1000ms), so the
 * retry has a real chance of finding a quiet table rather than repeating
 * the same race a moment later.
 */
const PURGE_RETRY_PAUSE_MS = 2_000

const USAGE =
  'usage: lyraflow projects <list|delete|deletion> [args] [--yes] [--queue] [--json|--human]'

const SPEC_BY_SUBCOMMAND: Record<string, ArgSpec> = {
  list: { booleans: ['json', 'human'] },
  delete: { booleans: ['yes', 'queue', 'json', 'human'] },
  deletion: { booleans: ['json', 'human'] },
}

const SUBCOMMANDS = ['list', 'delete', 'deletion'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value)
}

/**
 * The subset of `ProjectDeletionStore` this file calls — narrowed to an
 * interface (rather than the class itself) so a test can inject a fake
 * that delegates most calls to a real store and overrides exactly one, to
 * drive a path real timing can't reliably reach (the claim losing a race,
 * a purge reporting `deleted: false`). Real dispatch never overrides this;
 * `makeStore`'s default is a real `ProjectDeletionStore`, which satisfies
 * this shape as-is.
 */
interface DeletionStore {
  request: ProjectDeletionStore['request']
  claimById: ProjectDeletionStore['claimById']
  complete: ProjectDeletionStore['complete']
  fail: ProjectDeletionStore['fail']
  get: ProjectDeletionStore['get']
}

/**
 * Test-only seams for the two collaborators `runProjectsDelete`/
 * `runProjectsDeletionGet` otherwise import at module scope and cannot be
 * observed from outside: which store backs `request`/`claimById`/
 * `complete`/`fail`/`get`, and what `purgeProject` itself does. Both
 * default to the real implementations — real dispatch (index.ts) never
 * passes this parameter at all.
 */
export interface ProjectsDeps {
  purge?: typeof purgeProject
  makeStore?: (pg: Pool) => DeletionStore
}

/** GET /v1/projects's own row shape (admin-routes.ts), plus the derived
 * `state` this command adds on top. NO KEY OF EITHER KIND — see
 * `runProjectsList`'s own comment for why that is not incidental. */
interface ProjectRow {
  id: number
  name: string
  slug: string
  created_at: string
  retention_months: number
  monthly_event_quota: number | null
  disabled_at: string | null
  deleting_at: string | null
  state: 'active' | 'archived' | 'deleting'
}

const LIST_COLUMNS: Column[] = [
  { header: 'SLUG', get: (r: ProjectRow) => r.slug },
  { header: 'NAME', get: (r: ProjectRow) => r.name },
  { header: 'STATE', get: (r: ProjectRow) => r.state },
  { header: 'RETENTION', get: (r: ProjectRow) => `${r.retention_months}mo` },
  {
    header: 'QUOTA',
    get: (r: ProjectRow) =>
      r.monthly_event_quota === null ? 'unlimited' : String(r.monthly_event_quota),
  },
]

/**
 * `GET /v1/projects` — same SELECT, same field list, same rule: NO KEY OF
 * EITHER KIND. This is the one response in the product that names every
 * project at once (admin-routes.ts's own comment), so a key leaking here
 * leaks the whole install rather than one project. The rule holds for a
 * terminal exactly as it holds for that HTTP response.
 */
async function runProjectsList(mode: Mode, ctx: AdminCommandContext): Promise<number> {
  const res = await ctx.pg.query<{
    id: string
    name: string
    slug: string
    created_at: Date
    retention_months: number
    monthly_event_quota: string | null
    disabled_at: Date | null
    deleting_at: Date | null
  }>(
    `SELECT id, name, slug, created_at, retention_months, monthly_event_quota, disabled_at, deleting_at
       FROM projects ORDER BY created_at ASC, id ASC`,
  )

  const rows: ProjectRow[] = res.rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    slug: r.slug,
    created_at: r.created_at.toISOString(),
    retention_months: r.retention_months,
    monthly_event_quota: r.monthly_event_quota === null ? null : Number(r.monthly_event_quota),
    disabled_at: r.disabled_at === null ? null : r.disabled_at.toISOString(),
    deleting_at: r.deleting_at === null ? null : r.deleting_at.toISOString(),
    state: r.deleting_at !== null ? 'deleting' : r.disabled_at !== null ? 'archived' : 'active',
  }))

  emitRecords(rows, mode, LIST_COLUMNS, ctx.write)
  return 0
}

/** One `PurgeProgress` rendered as a single line — json mode gets an
 * object per table (matching every other list this CLI prints, one record
 * per line); human mode gets a short sentence, which is what step 7's
 * by-hand run is checking for: a visible line per table as the teardown
 * happens. */
function writeProgress(p: PurgeProgress, mode: Mode, ctx: AdminCommandContext): void {
  if (mode === 'json') {
    emitObject({ event: 'purge_progress', ...p }, mode, ctx.write)
    return
  }
  const index = PURGE_TABLES.indexOf(p.table as (typeof PURGE_TABLES)[number]) + 1
  const detail =
    p.partitions !== undefined
      ? `${p.partitions} partition(s) dropped`
      : p.mutated
        ? 'rows deleted'
        : 'done'
  ctx.write(`[${index}/${PURGE_TABLES.length}] ${p.table}: ${detail}\n`)
}

/**
 * `lyraflow projects delete <slug>`. See the module docstring for the
 * exit-code design and what counts as consent; this is the enforcement of
 * it. Steps, in order: resolve the slug, cost the deletion against
 * ClickHouse, confirm (unless `--yes`), file the request through
 * `ProjectDeletionStore.request` (which alone decides `not_found` /
 * `alreadyDeleting` / accepted), then either queue it for the server
 * worker or claim and run it here.
 *
 * CLAIMS BY ID, NEVER `store.claim()`. `claim()` is the WORKER'S query —
 * "whatever is oldest and claimable, queue-wide" — and this command just
 * filed one SPECIFIC request a moment ago. Calling the worker's `claim()`
 * here would silently complete or fail WHATEVER ROW happened to be oldest
 * (an older `--queue`d request, one filed from the UI while the server was
 * stopped, one whose lease aged out after a crash) while purging THIS
 * project — marking a different project's deletion done while its data
 * survives intact, and leaving this project's own request claimable
 * forever. `store.claimById(result.id, ...)` is the fix: it can only ever
 * take the row this call itself just inserted.
 */
async function runProjectsDelete(
  slug: string,
  flags: Record<string, string | boolean>,
  mode: Mode,
  ctx: AdminCommandContext,
  purge: typeof purgeProject,
  makeStore: (pg: Pool) => DeletionStore,
): Promise<number> {
  // Resolved once, up front — BEFORE anything below writes anything.
  // `envNumber` throws on a malformed `LYRAFLOW_PROJECT_PURGE_LEASE_MS`/
  // `_MAX_ATTEMPTS`, and `runProjects` has no catch around this call (only
  // index.ts's `finally`, which closes the pool and rethrows). Resolving
  // these after `store.request()` had already stamped `deleting_at` and
  // inserted the queue row meant that exact throw would escape with the
  // project stamped deleting and a request pending — a raw stack trace on
  // an operator's terminal, the same shape Minor 5 exists to prevent for a
  // rejected prompt. Resolving here means a degenerate config fails before
  // the confirmation prompt is even shown, let alone anything is written.
  const leaseMs = resolvePurgeLeaseMs()
  const maxAttempts = resolvePurgeMaxAttempts()

  const yes = flags.yes === true
  const queue = flags.queue === true

  const found = await ctx.pg.query<{
    id: string
    name: string
    slug: string
    deleting_at: Date | null
  }>('SELECT id, name, slug, deleting_at FROM projects WHERE slug = $1', [slug])
  const row = found.rows[0]
  if (!row) {
    ctx.writeErr(`no such project: ${slug}\n`)
    return 1
  }
  const projectId = Number(row.id)

  const countRs = await ctx.ch.query({
    query: 'SELECT count() AS n FROM events WHERE project_id = {p:UInt32}',
    query_params: { p: projectId },
    format: 'JSONEachRow',
  })
  const countRows = await countRs.json<{ n: string }>()
  const count = Number(countRows[0]?.n ?? 0)

  if (!yes) {
    if (!ctx.stdinIsTty) {
      ctx.writeErr(
        'refusing to delete without --yes when stdin is not a terminal (nothing to prompt)\n',
      )
      return 2
    }

    ctx.writeErr(
      `This permanently destroys ${count} events for "${row.name}" (${row.slug}).\nIts data cannot be recovered from anything but a backup, and there is no undo.\n`,
    )
    // A REJECTED prompt is the confirmation mechanism itself failing — not
    // an answer, and not something that should escape as an unhandled
    // rejection. Same "fails safe, never deletes" rule a declined prompt
    // gets below, mirroring `persons.ts`'s `runDelete` exactly (see this
    // module's own docstring: the rules match that file's on purpose).
    let answer: string | null
    try {
      answer = await ctx.prompt('Type the slug to confirm: ')
    } catch (err) {
      if (isEpipe(err)) return 0
      ctx.writeErr('the confirmation prompt failed; the project was not deleted\n')
      return 1
    }
    // `!== row.slug`, not a truthiness check: `prompt` resolves to `null`
    // when it times out or the stream closes, and `null` must decline
    // rather than throw or (worse) coerce into a match.
    if (answer !== row.slug) {
      ctx.writeErr('slug did not match; nothing was deleted\n')
      return 1
    }
  }

  const store = makeStore(ctx.pg)
  const result = await store.request(projectId)
  if (result === 'not_found') {
    // A concurrent delete won the race between the SELECT above and this
    // request — the project is already gone, not merely disagreeing about
    // its slug.
    ctx.writeErr(`no such project: ${slug}\n`)
    return 1
  }
  if ('alreadyDeleting' in result) {
    ctx.writeErr(
      `project "${row.name}" (${row.slug}) is already being deleted (request id ${result.alreadyDeleting})\n`,
    )
    return 1
  }

  if (queue) {
    if (mode === 'json') {
      emitObject({ id: result.id, project_id: projectId, status: 'pending' }, mode, ctx.write)
    } else {
      ctx.write(`queued (id ${result.id}) — the server will complete it\n`)
    }
    return 0
  }

  const request = await store.claimById(result.id, { leaseMs, maxAttempts })
  if (!request) {
    // Real, if narrow: the server's own periodic worker runs `claim()` on
    // the same table (whatever is oldest and claimable, queue-wide) and
    // can take THIS EXACT row — certain to, if it is the only pending
    // request; possible whenever it is the oldest one — in the window
    // between `store.request()` returning above and this `claimById()`
    // call. Not an error in the request itself: it is queued and will be
    // completed, just not by this process.
    ctx.writeErr(
      `request ${result.id} could not be claimed here (the server worker claimed it in the moment before this call); it is still queued and will be completed\n`,
    )
    return 1
  }

  const onProgress = (p: PurgeProgress): void => writeProgress(p, mode, ctx)

  let purgeResult = await purge({ ch: ctx.ch, pg: ctx.pg, projectId, onProgress })
  if (!purgeResult.deleted) {
    await new Promise<void>((resolve) => setTimeout(resolve, PURGE_RETRY_PAUSE_MS))
    purgeResult = await purge({ ch: ctx.ch, pg: ctx.pg, projectId, onProgress })
  }
  if (!purgeResult.deleted) {
    const detail = Object.entries(purgeResult.remaining)
      .map(([table, n]) => `${table}=${n}`)
      .join(', ')
    await store.fail(request.id, `rows reappeared during purge (${detail})`)
    ctx.writeErr(
      'rows reappeared while purging (a running server had buffered events); ' +
        'the request is still queued and the server worker will finish it\n',
    )
    return 1
  }

  await store.complete(request.id)
  if (mode === 'json') {
    emitObject({ id: request.id, project_id: projectId, status: 'completed' }, mode, ctx.write)
  } else {
    ctx.write(`deleted "${row.name}" (${row.slug})\n`)
  }
  return 0
}

/** `GET /v1/project-deletions/:id` — the same four statuses that route
 * computes (admin-routes.ts), read straight off `ProjectDeletionStore.get`
 * rather than through HTTP for the same reason every other command in this
 * group is direct-to-database. */
async function runProjectsDeletionGet(
  idRaw: string,
  mode: Mode,
  ctx: AdminCommandContext,
  makeStore: (pg: Pool) => DeletionStore,
): Promise<number> {
  const id = Number(idRaw)
  if (!Number.isInteger(id) || id <= 0) {
    return reportUsageError(new UsageError(`invalid deletion id: ${idRaw}`), mode, ctx)
  }

  const store = makeStore(ctx.pg)
  const found: ProjectDeletionRequest | null = await store.get(id)
  if (!found) {
    ctx.writeErr(`no such deletion request: ${idRaw}\n`)
    return 1
  }

  const requested_at = found.requestedAt.toISOString()
  if (found.completedAt) {
    emitObject(
      { status: 'completed', requested_at, completed_at: found.completedAt.toISOString() },
      mode,
      ctx.write,
    )
    return 0
  }
  if (found.attempts >= resolvePurgeMaxAttempts()) {
    emitObject(
      { status: 'failed', requested_at, completed_at: null, error: found.lastError },
      mode,
      ctx.write,
    )
    return 0
  }
  if (found.lastError !== null) {
    emitObject(
      { status: 'pending', requested_at, completed_at: null, error: found.lastError },
      mode,
      ctx.write,
    )
    return 0
  }
  const leased =
    found.claimedAt !== null && Date.now() - found.claimedAt.getTime() < resolvePurgeLeaseMs()
  emitObject(
    { status: leased ? 'in_progress' : 'pending', requested_at, completed_at: null, error: null },
    mode,
    ctx.write,
  )
  return 0
}

/**
 * `lyraflow projects <list|delete|deletion> [args] [--yes] [--queue]
 * [--json|--human]`
 *
 * Returns 0 success, 1 failure or a declined confirmation, 2 a usage error
 * or a refusal to prompt an unattended stdin.
 *
 * `deps` is test-only — see `ProjectsDeps`'s own docstring. Real dispatch
 * (index.ts) calls this with two arguments and gets the real store and the
 * real `purgeProject`.
 */
export async function runProjects(
  argv: string[],
  ctx: AdminCommandContext,
  deps: ProjectsDeps = {},
): Promise<number> {
  const purge = deps.purge ?? purgeProject
  const makeStore = deps.makeStore ?? ((pg: Pool) => new ProjectDeletionStore(pg))

  const parseCtx = { writeErr: ctx.writeErr, isTty: ctx.stdoutIsTty }

  const [subcommand, ...rest] = argv
  if (subcommand === undefined) {
    return reportUsageError(new UsageError(USAGE), resolveMode({}, ctx.stdoutIsTty), parseCtx)
  }
  if (!isSubcommand(subcommand)) {
    // Deliberately does NOT interpolate `subcommand` — same rule
    // persons.ts's and catalog.ts's identical guards follow: this slot
    // could hold anything, including a value meant for somewhere else.
    const mode = resolveMode(
      { json: hasRawFlag(argv, 'json'), human: hasRawFlag(argv, 'human') },
      ctx.stdoutIsTty,
    )
    return reportUsageError(
      new UsageError(`unknown projects subcommand (${USAGE})`),
      mode,
      parseCtx,
    )
  }

  let flags: Record<string, string | boolean>
  let positionals: string[]
  let positionalIndexes: number[]
  let positionalContext: (string | undefined)[]
  try {
    ;({ flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(
      rest,
      SPEC_BY_SUBCOMMAND[subcommand] as ArgSpec,
    ))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, rest, parseCtx)
  }

  const mode = resolveMode(flags, ctx.stdoutIsTty)

  if (subcommand === 'list') {
    const code = checkNoPositionals(
      { positionals, positionalContext, positionalIndexes },
      mode,
      parseCtx,
    )
    if (code !== undefined) return code
    return runProjectsList(mode, ctx)
  }

  if (subcommand === 'delete') {
    const [slug] = positionals
    if (slug === undefined) {
      return reportUsageError(
        new UsageError(`projects delete requires a slug (${USAGE})`),
        mode,
        parseCtx,
      )
    }
    const code = checkNoPositionals(
      {
        positionals: positionals.slice(1),
        positionalContext: positionalContext.slice(1),
        positionalIndexes: positionalIndexes.slice(1),
      },
      mode,
      parseCtx,
    )
    if (code !== undefined) return code
    return runProjectsDelete(slug, flags, mode, ctx, purge, makeStore)
  }

  // subcommand === 'deletion'
  const [sub2, id] = positionals
  if (sub2 !== 'get') {
    return reportUsageError(
      new UsageError(`unknown deletion subcommand — expected "get" (${USAGE})`),
      mode,
      parseCtx,
    )
  }
  if (id === undefined) {
    return reportUsageError(
      new UsageError(`projects deletion get requires an id (${USAGE})`),
      mode,
      parseCtx,
    )
  }
  const code = checkNoPositionals(
    {
      positionals: positionals.slice(2),
      positionalContext: positionalContext.slice(2),
      positionalIndexes: positionalIndexes.slice(2),
    },
    mode,
    parseCtx,
  )
  if (code !== undefined) return code
  return runProjectsDeletionGet(id, mode, ctx, makeStore)
}
