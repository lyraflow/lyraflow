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
 * THE OTHER THING THIS COMMAND MUST NEVER DO: interpolate a raw,
 * caller-configured value into HTML or inline JavaScript. `--host`/
 * `LYRAFLOW_HOST` is exactly as caller-controlled as any argv value this
 * CLI otherwise refuses to echo — the difference is this command has to
 * PRINT it, inside markup a browser will parse. Bare template substitution
 * into an HTML attribute and a JS string literal is not safe for a value
 * this CLI does not control the shape of (a trailing slash alone silently
 * turns `src="HOST/lyraflow.js"` into a 404 by concatenating into
 * `HOST//lyraflow.js` — a real, previously-shipped defect, not a
 * theoretical one). `normalizeHost`/`jsStringLiteral`/`escapeHtmlAttr`
 * below are the fix — see their own docstrings.
 *
 * Three requests, in order:
 *   1. `GET /v1/project` — the project's `name`/`slug`/`write_key`. Must
 *      succeed for this command to do anything at all — there is no
 *      snippet without a write key.
 *   2. `GET /v1/schema/events` — every event name this project has
 *      recorded, up to the server's own page-size ceiling
 *      (`SCHEMA_MAX_LIMIT`). NOT time-windowed — `event_schema` carries no
 *      `count`, so this is the only way to learn an event fired at all,
 *      including one that stopped arriving before `--since`.
 *   3. `GET /v1/events/stats?group_by=event_name` — the SAME event names'
 *      counts, but WINDOWED by `--since` (default `7d`, an absolute instant
 *      resolved once up front — see `resolveInstant`, args.ts). An event
 *      present in (2) with a zero count from (3) is meaningful, not a
 *      display bug: it fired historically and has since stopped, which is
 *      arguably the single most useful thing this output can say about
 *      instrumentation that used to work. Dropping a zero-count row would
 *      silently erase exactly that signal.
 *
 * (2) and (3) are INFORMATIONAL — the snippet itself (host, write key,
 * methods) needs neither — so a failure in either degrades gracefully
 * (see `fetchEventsSection`) rather than costing the caller the thing they
 * actually came for. A failure in (1) is not informational; it is the
 * whole command's only reason to have anything to print, so it still fails
 * the command outright.
 *
 * `interval: '1d'` is sent on every stats request, unconditionally — this
 * command only ever wants ONE total per event name across the window, so
 * the coarsest interval keeps the request comfortably inside the server's
 * own `STATS_MAX_BUCKETS` guard (events/routes.ts) for any `--since` a
 * caller is likely to pass, and every matching bucket's count is summed
 * client-side into that one total (see `mergeEventCounts` below).
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
import { ApiError } from '../client.js'
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

/**
 * The `events` field's shape on the success path. `truncated` is `true`
 * exactly when `schema/events` came back with `SCHEMA_MAX_LIMIT` rows — the
 * ONLY signal available for "there may be more": the endpoint returns no
 * total count, so a full page is the sole evidence a list was cut rather
 * than complete. Present in BOTH modes (not just human text) so a caller
 * parsing `--json` can detect it programmatically instead of trusting the
 * human sentence to have been read.
 */
interface EventsSectionOk {
  since: string
  until: string
  counts: EventCount[]
  truncated: boolean
}

/** The `events` field's shape when either informational request failed —
 * see the module docstring on why this degrades instead of failing the
 * whole command. */
interface EventsSectionError {
  error: { code: string; message: string }
}

type EventsSection = EventsSectionOk | EventsSectionError

const SNIPPET_ALLOWED_FLAGS = new Set([...UNIVERSAL_FLAGS, 'since'])

/**
 * `snippet`-local narrowing of `CommandContext` — makes `host` REQUIRED
 * rather than the base interface's `host?: string`. Real dispatch
 * (index.ts) always supplies it before calling this command; narrowing the
 * type HERE, rather than widening `CommandContext` itself for all seven
 * command groups, keeps the seam narrow — only this command's own contract
 * claims a real host is always present.
 */
interface SnippetContext extends CommandContext {
  host: string
}

function hasHost(ctx: CommandContext): ctx is SnippetContext {
  return typeof ctx.host === 'string'
}

/**
 * Resolves `host` to the value that is actually safe, and actually
 * CORRECT, to embed in a browser snippet: the URL's `origin` alone
 * (scheme + hostname + port), discarding anything else (path, query,
 * trailing slash).
 *
 * This is not a lossy simplification of what `Client` does — it IS what
 * `Client` does, made visible. Every request path this CLI ever sends
 * ("/v1/project", "/v1/schema/events", ...) is an ABSOLUTE-PATH reference
 * (starts with "/"), and per URL resolution rules `new URL(path, base)`
 * for an absolute-path reference discards the base's own path entirely —
 * confirmed directly: `new URL('/v1/project', 'https://h/sub/').href ===
 * 'https://h/v1/project'`, never `'https://h/sub/v1/project'`. Any path
 * configured in `--host`/`LYRAFLOW_HOST` has therefore never affected a
 * single real request this CLI makes, in any command, before or after this
 * fix — `.origin` simply stops pretending otherwise in what gets printed.
 *
 * This is also the fix for the reported defect: naive `${host}/lyraflow.js`
 * string concatenation turns a bare trailing slash (`https://h/`) into
 * `https://h//lyraflow.js` — a different URL that 404s. `.origin` never
 * carries a trailing slash, so the double-slash cannot occur.
 *
 * Can throw (an unparseable `host`) only in a state that is already
 * unreachable by the time this runs — see the two call sites' own comments.
 */
function normalizeHost(host: string): string {
  return new URL(host).origin
}

/**
 * Encodes a value for safe inclusion inside an HTML DOUBLE-quoted
 * attribute. Belt-and-suspenders over `normalizeHost` (a real URL
 * `origin` structurally cannot contain any of these characters — the URL
 * parser rejects or strips them before `.origin` is ever read) — kept as
 * an explicit, structural guarantee anyway rather than an assumption about
 * `URL`'s own behaviour that nothing here enforces, the same reasoning
 * output.ts's `toCell`/`sanitizeForLine` give for hardening a value this
 * module does not fully control the shape of.
 */
function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * Encodes a value as a JS string literal safe to inline inside an inline
 * `<script>` element. `JSON.stringify` produces valid JS string syntax
 * (not just JSON) and correctly escapes quotes, backslashes and control
 * characters — but it does not know about the ONE extra rule inline
 * script content has that a JS parser does not: an HTML tokenizer closes
 * the `<script>` element on the first `</` it sees, regardless of what JS
 * string syntax says about where the string itself ends. The trailing
 * `.replace` turns `</` into `<\/` — a different token to the HTML
 * tokenizer (an escaped forward slash inside a string, not a closing tag)
 * that decodes to the identical JS string value. The standard mitigation
 * for embedding untrusted data inside an inline `<script>`.
 */
function jsStringLiteral(s: string): string {
  return JSON.stringify(s).replace(/<\//g, '<\\/')
}

/**
 * The install snippet template — the stub's method array is built from
 * `SNIPPET_METHODS`, never retyped, so a method missing from that list
 * cannot be silently dropped from the stub the way it was on the previous
 * plan. Matches the README's own block in structure; the two substitution
 * sites (`src`, `host`/`writeKey`) are properly encoded rather than bare
 * template concatenation — see `normalizeHost`/`escapeHtmlAttr`/
 * `jsStringLiteral`'s own docstrings for why bare substitution was unsafe.
 *
 * `originHost` MUST already be a normalized origin (`normalizeHost`'s
 * output) — this function does not re-derive it, so both substitution
 * sites below are guaranteed to embed the IDENTICAL host string.
 */
function buildSnippet(originHost: string, writeKey: string): string {
  const methods = SNIPPET_METHODS.map((m) => JSON.stringify(m)).join(',')
  const srcAttr = escapeHtmlAttr(originHost)
  const hostLiteral = jsStringLiteral(originHost)
  const writeKeyLiteral = jsStringLiteral(writeKey)
  return `<script>
  !function(){var l=window.lyraflow=window.lyraflow||{};l.q=l.q||[];
  [${methods}].forEach(function(m){
    l[m]=l[m]||function(){l.q.push([m].concat([].slice.call(arguments)))}});
  }();
</script>
<script async src="${srcAttr}/lyraflow.js"></script>
<script>
  lyraflow.init({ host: ${hostLiteral}, writeKey: ${writeKeyLiteral} })
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

/**
 * The two informational requests, wrapped so a failure in EITHER degrades
 * to `{ error }` instead of failing the whole command — the snippet
 * itself (host, write key, methods) needs neither, so losing the thing the
 * caller actually came for (a working snippet) over an events list that
 * merely couldn't be fetched is the wrong trade. Only an `ApiError`
 * degrades this way; anything else (a real bug) still crashes loudly, same
 * as every other command in this CLI.
 */
async function fetchEventsSection(
  ctx: CommandContext,
  since: Date,
  until: Date,
): Promise<EventsSection> {
  try {
    const schema = await ctx.client.get<SchemaEventsResponse>('/v1/schema/events', {
      limit: SCHEMA_MAX_LIMIT,
    })
    const stats = await ctx.client.get<StatsResponse>('/v1/events/stats', {
      since: since.toISOString(),
      until: until.toISOString(),
      interval: '1d',
      group_by: 'event_name',
    })
    return {
      since: since.toISOString(),
      until: until.toISOString(),
      counts: mergeEventCounts(schema, stats),
      truncated: schema.events.length === SCHEMA_MAX_LIMIT,
    }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    return { error: { code: err.code, message: err.message } }
  }
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
function renderHuman(snippet: string, events: EventsSection, sinceRaw: string): string {
  const lines = [snippet, '']
  if ('error' in events) {
    lines.push(`Event counts unavailable: ${events.error.message} (${events.error.code}).`)
  } else if (events.counts.length === 0) {
    lines.push('No events recorded yet.')
  } else {
    // `sinceRaw` is echoed verbatim here — safe, unlike an ordinary flag
    // value: `resolveInstant` below has already thrown a UsageError for
    // anything that is not a duration like "7d" or a real ISO instant
    // BEFORE this function is ever reached, so nothing that survives to
    // here can be a secret typed into the wrong slot (the same reasoning
    // `schema`'s `parseSchemaLimit`, catalog.ts, gives for echoing
    // `--limit` only after its own regex has proven it is plain digits).
    const completeness = events.truncated
      ? `showing the first ${SCHEMA_MAX_LIMIT} event names on record — this project has more than that, so some may be missing`
      : 'every event name ever recorded for this project'
    lines.push(
      `Event counts since ${sinceRaw} ago (${events.since} to ${events.until}), ${completeness}. A zero count means it fired before this window, not that it is broken:`,
    )
    lines.push(renderEventsTable(events.counts))
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

  if (!hasHost(ctx)) {
    // Provably unreachable from real dispatch: index.ts always resolves
    // `host` (the same value `ctx.client` is built from) before calling
    // this command at all. A bare `throw` here would sit outside any
    // try/catch and surface as an unhandled promise rejection under
    // index.ts's bare `await main()` rather than the ordinary, reportable
    // exit code every ACTUAL failure in this CLI gets — reported through
    // the normal usage-error path instead, on the same reasoning.
    return reportUsageError(
      new UsageError('internal error: no host was configured for this session'),
      mode,
      ctx,
    )
  }

  let host: string
  try {
    host = normalizeHost(ctx.host)
  } catch {
    // Also unreachable in practice: `ctx.host` is always the exact string
    // `Client` was already built from, and `Client`'s own `#buildUrl`
    // (client.ts) requires the identical `new URL(...)` parse to succeed
    // for ANY request this command makes — a host that fails here would
    // already have failed `GET /v1/project` below instead, reported
    // through the ordinary `ApiError` path. Kept as an explicit,
    // reportable failure anyway rather than an assumed invariant nothing
    // enforces, the same reasoning command-support.ts gives for never
    // trusting one silently.
    return reportUsageError(
      new UsageError('the configured host (--host, or LYRAFLOW_HOST) is not a usable base URL'),
      mode,
      ctx,
    )
  }

  try {
    const project = await ctx.client.get<ProjectResponse>('/v1/project')
    const until = ctx.now()
    const eventsSection = await fetchEventsSection(ctx, since, until)
    const snippet = buildSnippet(host, project.write_key)

    if (mode === 'json') {
      emitObject(
        {
          host,
          write_key: project.write_key,
          methods: [...SNIPPET_METHODS],
          events: eventsSection,
          sdk_version: VERSION,
          snippet,
        },
        'json',
        ctx.write,
      )
    } else {
      ctx.write(renderHuman(snippet, eventsSection, sinceRaw))
    }
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}
