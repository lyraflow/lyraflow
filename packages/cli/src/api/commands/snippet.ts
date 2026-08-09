/**
 * `lyraflow snippet` — a paste-ready browser install snippet, with this
 * project's own host and write key already substituted, plus the SDK's
 * callable surface (so a caller can see what it can call before reading the
 * README) and the event names actually arriving (so a caller can tell
 * "instrumented and firing" from "installed but nothing has called
 * `track()` yet").
 *
 * THE ONLY COMMAND IN THIS CLI WHOSE JOB IS TO PRINT A KEY. Every other
 * command group was hardened, across four review rounds on the branch this
 * one was built on, so that no argument value a caller typed could ever
 * reach output (`command-support.ts`'s module docstring, and
 * `positionalsUsageMessage`'s own). That guarantee still holds here — this
 * command never echoes a raw positional or an unrecognised flag either —
 * but it has one deliberate, narrow exemption sitting inside it: the
 * project's WRITE key is printed on purpose, because it is public by
 * construction (packages/server/src/project/routes.ts's own docstring: it
 * ships inside the browser bundle and is readable in devtools on any
 * instrumented page). Printing it is this command's entire reason to
 * exist. The SERVER key this CLI authenticates with is a secret and must
 * never appear here, or anywhere else in this CLI's output — that half of
 * the rule is completely ordinary, not an exemption at all.
 *
 * Three requests, always in this order, and the second and third never run
 * if the first fails:
 *   1. `GET /v1/project` — the project's `name`/`slug`/`write_key`.
 *   2. `GET /v1/schema/events` — every event name this project has EVER
 *      recorded. NOT time-windowed — `event_schema` carries no `count`, so
 *      this is the only way to learn an event fired at all, including one
 *      that stopped arriving before `--since`.
 *   3. `GET /v1/events/stats?group_by=event_name` — the SAME event names'
 *      counts, but WINDOWED by `--since` (default `7d`, an absolute instant
 *      resolved once up front — see `resolveInstant`, args.ts). An event
 *      present in (2) with a zero count from (3) is meaningful, not a
 *      display bug: it fired historically and has since stopped, which is
 *      arguably the single most useful thing this output can say about a
 *      instrumentation that used to work. Dropping a zero-count row would
 *      silently erase exactly that signal.
 *
 * `interval: '1d'` is sent on every stats request, unconditionally — this
 * command only ever wants ONE total per event name across the window, so
 * the coarsest interval keeps the request comfortably inside the server's
 * own `STATS_MAX_BUCKETS` guard (events/routes.ts) for any `--since` a
 * caller is likely to pass, and every matching bucket's count is summed
 * client-side into that one total (see `sumEventCounts` below).
 */

// VALUE imports, not type-only — `SNIPPET_METHODS` is what the stub's
// method array is BUILT FROM (never retyped here), and `VERSION` is
// reported as `sdk_version`. This is the CLI importing the browser SDK,
// the opposite direction from the one `@lyraflow/core` value imports are
// forbidden in (that direction breaks the browser bundle) — safe here, and
// confirmed by running `pnpm build` after adding this import and checking
// `packages/sdk-browser/dist/lyraflow.js` is still produced.
import { SNIPPET_METHODS, VERSION } from '@lyraflow/sdk-browser'
import { UsageError, parseCommandArgs, resolveInstant } from '../args.js'
import type { CommandContext } from '../context.js'
import { type Mode, emitObject, resolveMode } from '../output.js'
import { SCHEMA_MAX_LIMIT } from './catalog.js'
import {
  UNIVERSAL_FLAGS,
  checkNoPositionals,
  checkStrayFlags,
  reportCommandFailure,
  reportParseFailure,
  reportUsageError,
} from './command-support.js'

/** GET /v1/project's response shape (project/routes.ts). Only two of its
 * three fields are used here — `slug` is not part of this command's job. */
interface ProjectResponse {
  name: string
  slug: string
  write_key: string
}

/** GET /v1/schema/events' response shape (schema/routes.ts). */
interface SchemaEventsResponse {
  events: { event_name: string }[]
}

/** GET /v1/events/stats' response shape (events/routes.ts) — `event_name`
 * is present on every row here since this command always sends
 * `group_by=event_name`. */
interface StatsBucket {
  bucket: string
  event_name?: string
  events: number
}

interface StatsResponse {
  buckets: StatsBucket[]
}

/** One event name paired with its windowed count. */
interface EventCount {
  event_name: string
  count: number
}

const SNIPPET_ALLOWED_FLAGS = new Set([...UNIVERSAL_FLAGS, 'since'])

/**
 * The install snippet template — the stub's method array is built from
 * `SNIPPET_METHODS`, never retyped, so a method missing from that list
 * cannot be silently dropped from the stub the way it was on the previous
 * plan. Matches the README's own block exactly except for the
 * substitutions and the generated method array; Task 4 points the README
 * at this command instead of keeping a second hand-maintained copy.
 */
function buildSnippet(host: string, writeKey: string): string {
  const methods = SNIPPET_METHODS.map((m) => `"${m}"`).join(',')
  return `<script>
  !function(){var l=window.lyraflow=window.lyraflow||{};l.q=l.q||[];
  [${methods}].forEach(function(m){
    l[m]=l[m]||function(){l.q.push([m].concat([].slice.call(arguments)))}});
  }();
</script>
<script async src="${host}/lyraflow.js"></script>
<script>
  lyraflow.init({ host: '${host}', writeKey: '${writeKey}' })
</script>`
}

/**
 * Sums `stats`' per-bucket counts down to one total per event name, then
 * pairs every name from `schema` (the all-time list) with that total —
 * `0` when the name never appears in `stats` at all, which is exactly the
 * "fired historically, stopped since `--since`" case this command exists
 * to surface. Order follows `schema`'s own (alphabetical — see
 * schema/routes.ts's `ORDER BY event_name ASC`), not `stats`'.
 */
function mergeEventCounts(schema: SchemaEventsResponse, stats: StatsResponse): EventCount[] {
  const totals = new Map<string, number>()
  for (const bucket of stats.buckets) {
    if (bucket.event_name === undefined) continue
    totals.set(bucket.event_name, (totals.get(bucket.event_name) ?? 0) + bucket.events)
  }
  return schema.events.map((e) => ({
    event_name: e.event_name,
    count: totals.get(e.event_name) ?? 0,
  }))
}

/** Two-space-separated, name-padded rows — same alignment convention
 * `emitRecords`' own table uses (output.ts), reimplemented small rather
 * than reused: `emitRecords` takes a list of RECORDS through `Column`s and
 * always renders the header line and NDJSON shape this command does not
 * want, and its JSON-mode branch cannot express the freeform multi-section
 * human text (the raw multi-line snippet plus this table) this command
 * needs below it. */
function renderEventsTable(counts: EventCount[]): string {
  const width = Math.max(...counts.map((c) => c.event_name.length))
  return counts.map((c) => `  ${c.event_name.padEnd(width)}  ${c.count}`).join('\n')
}

/**
 * Human-mode rendering, built by hand rather than through `emitObject`:
 * `emitObject`'s human branch renders one line of `key: value` pairs and
 * runs every value through `sanitizeForLine` (output.ts), which escapes a
 * real newline to the two literal characters `\`+`n` — exactly wrong for
 * this command's main output, whose entire point is a paste-ready,
 * ACTUALLY-multi-line `<script>` block. `emitObject` still does the right
 * thing for `--json` below, where `JSON.stringify` escapes newlines
 * correctly by construction (output.ts's own module docstring) — so only
 * the human branch needs its own renderer.
 */
function renderHuman(
  snippet: string,
  counts: EventCount[],
  sinceRaw: string,
  since: Date,
  until: Date,
): string {
  const lines = [snippet, '']
  if (counts.length === 0) {
    lines.push('No events recorded yet.')
  } else {
    // `sinceRaw` is echoed verbatim here — safe, unlike an ordinary flag
    // value: `resolveInstant` below has already thrown a UsageError for
    // anything that is not a duration like "7d" or a real ISO instant
    // BEFORE this function is ever reached, so nothing that survives to
    // here can be a secret typed into the wrong slot (the same reasoning
    // `schema`'s `parseSchemaLimit`, catalog.ts, gives for echoing
    // `--limit` only after its own regex has proven it is plain digits).
    lines.push(
      `Event counts since ${sinceRaw} ago (${since.toISOString()} to ${until.toISOString()}). This list is every event name ever recorded for this project — a zero count means it fired before this window, not that it is broken:`,
    )
    lines.push(renderEventsTable(counts))
  }
  return `${lines.join('\n')}\n`
}

/**
 * `lyraflow snippet [--since <duration>] [--json|--human]`
 *
 * Returns the process exit code: 0 success, 1 the request failed, 2 usage
 * error.
 */
export async function runSnippet(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  let positionals: string[]
  let positionalIndexes: number[]
  let positionalContext: (string | undefined)[]
  try {
    ;({ flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(argv, {
      strings: ['since', 'host', 'server-key'],
      booleans: ['json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, argv, ctx)
  }

  const mode: Mode = resolveMode(flags, ctx.isTty)

  const positionalsCode = checkNoPositionals(
    { positionals, positionalIndexes, positionalContext },
    mode,
    ctx,
  )
  if (positionalsCode !== undefined) return positionalsCode

  const strayFlagsCode = checkStrayFlags(flags, SNIPPET_ALLOWED_FLAGS, mode, ctx)
  if (strayFlagsCode !== undefined) return strayFlagsCode

  const sinceRaw = typeof flags.since === 'string' ? flags.since : '7d'
  let since: Date
  try {
    // Validated, and validation complete, before any network call — the
    // same rule every other command in this CLI follows for `--since`.
    since = resolveInstant(sinceRaw, ctx.now(), '--since')
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportUsageError(err, mode, ctx)
  }

  // `ctx.host` is unset only for a placeholder context (`--version`'s own,
  // and a test that never sets it) — real dispatch always resolves it
  // before building `ctx.client` in the first place, so a genuinely
  // missing value here is a dispatch bug, not a caller mistake, and there
  // is nothing this command could usefully embed in a snippet instead.
  const host = ctx.host
  if (host === undefined) {
    throw new Error('internal error: CommandContext.host was not set for `snippet`')
  }

  try {
    const project = await ctx.client.get<ProjectResponse>('/v1/project')

    // Every event name this project has EVER recorded — see the module
    // docstring for why this call carries no `--since` at all. Requested
    // at the server's own maximum page size so this list is as close to
    // "every" as a single page can get; a project with more distinct event
    // names than that ceiling gets a truncated list here, same as `schema
    // events` itself would without raising `--limit` — a real, known gap,
    // not something this command works around.
    const schema = await ctx.client.get<SchemaEventsResponse>('/v1/schema/events', {
      limit: SCHEMA_MAX_LIMIT,
    })

    const until = ctx.now()
    const stats = await ctx.client.get<StatsResponse>('/v1/events/stats', {
      since: since.toISOString(),
      until: until.toISOString(),
      interval: '1d',
      group_by: 'event_name',
    })

    const counts = mergeEventCounts(schema, stats)
    const snippet = buildSnippet(host, project.write_key)

    if (mode === 'json') {
      emitObject(
        {
          host,
          write_key: project.write_key,
          methods: [...SNIPPET_METHODS],
          events: {
            since: since.toISOString(),
            until: until.toISOString(),
            counts,
          },
          sdk_version: VERSION,
          snippet,
        },
        'json',
        ctx.write,
      )
    } else {
      ctx.write(renderHuman(snippet, counts, sinceRaw, since, until))
    }
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}
