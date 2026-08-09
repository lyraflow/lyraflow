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
 *   2. `GET /v1/schema/events` — every event name this project has EVER
 *      carried at least one PROPERTY on, up to the server's own page-size
 *      ceiling (`SCHEMA_MAX_LIMIT`). NOT time-windowed, but also NOT
 *      complete on its own: `event_schema` is fed by a materialized view
 *      keyed on `mapKeys(properties)`/`mapKeys(properties_num)`
 *      (002_events.sql), so an event that has NEVER carried a property
 *      produces ZERO rows here no matter how many times it fired.
 *      `lyraflow.track('signup')` with no second argument — the single most
 *      common first call anyone makes — is exactly this case.
 *   3. `GET /v1/events/stats?group_by=event_name` — counts for event names,
 *      WINDOWED by `--since` (default `7d`, an absolute instant resolved
 *      once up front — see `resolveInstant`, args.ts). Unlike (2), this
 *      aggregates the raw `events` table directly, so it sees a
 *      property-less event fine, as long as it fired inside the window.
 *
 * `mergeEventCounts` below takes the UNION of the two name lists, not just
 * (2)'s — an early version of this command used (2) alone, and on a project
 * whose events genuinely carry no properties (the ordinary case for a
 * `track()` call with no second argument) that made a working install
 * report "No events recorded yet." A name present only in (3) is a real,
 * currently-firing event; a name present in (2) with a zero count from (3)
 * is meaningful in the other direction — it fired historically and has
 * since stopped, arguably the single most useful thing this output can say
 * about instrumentation that used to work — so that row is kept rather than
 * dropped. Neither source alone is complete even after the union: an event
 * that has NEVER carried a property AND did not fire within `--since` is
 * invisible to both requests, structurally, and this command has no way to
 * surface it — WIDENING `--since` (never narrowing it) is the only way a
 * caller can find it: shrinking the window only ever removes names from the
 * (3) half of the union, it never adds one.
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
 * The `events` field's shape on the success path. `counts` is the UNION of
 * `schema/events`' names and `events/stats`' names — see the module
 * docstring — not `schema/events`' own list alone, so it can include a name
 * that has never carried a property, as long as it fired within the window.
 *
 * `truncated` is `true` exactly when `schema/events` — only that request;
 * `events/stats` has its own, separate ceiling (`STATS_MAX_BUCKETS`,
 * events/routes.ts) unrelated to this field — came back with
 * `SCHEMA_MAX_LIMIT` rows. That is the ONLY signal available for "there may
 * be more (all-time, property-bearing) names": the endpoint returns no
 * total count, so a full page is the sole evidence a list was cut rather
 * than complete. It says nothing about names added to `counts` by the
 * `events/stats` half of the union, which is not paginated the same way.
 * Present in BOTH modes (not just human text) so a caller parsing `--json`
 * can detect it programmatically instead of trusting the human sentence to
 * have been read.
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
 * unreachable by the time this runs — see the call site's own comment: it
 * runs only after `GET /v1/project` has already parsed the identical
 * string successfully via `Client`'s own `new URL(...)`.
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
 *
 * THIS FUNCTION HAS TWO CALLERS WITH DIFFERENT STAKES — do not delete the
 * `</` guard because the host caller "can't need it":
 *   - for `host` (`normalizeHost`'s output), this IS belt-and-suspenders —
 *     a real URL `origin` structurally cannot contain `</` at all, so the
 *     guard is provably unreachable there (see `escapeHtmlAttr`'s own
 *     docstring for the identical reasoning on the other substitution
 *     site).
 *   - for `write_key`, it is LOAD-BEARING. The write key comes straight
 *     from `GET /v1/project`'s response body — server-supplied, and never
 *     normalised the way `host` is. A project row containing
 *     `wk_"+alert(1)+"</script><script>alert(2)</script>` (a compromised
 *     or misconfigured self-hosted database, not a hypothetical) would,
 *     without this guard, close the inline `<script>` element early and
 *     have its OWN injected markup parsed and executed on every page that
 *     pastes this snippet — confirmed directly: `snippet.test.ts`'s
 *     write-key-injection test fails exactly this way with the guard
 *     removed. Keep it.
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
 * pairs the UNION of `schema`'s names and `stats`' names with that total —
 * see the module docstring for why the union, not `schema`'s list alone,
 * is required: `schema/events` structurally cannot see an event that has
 * never carried a property, no matter how many times it fired, and a
 * `track()` call with no second argument is exactly that case.
 *
 * A name present in `schema` but absent from `totals` gets `0` — it fired
 * historically and has since stopped, which is exactly the "fired
 * historically, stopped since `--since`" case this command exists to
 * surface. A name present only in `totals` (never in `schema`, because it
 * has never carried a property) gets its real windowed count, which is
 * never `0` here: `events/stats` only ever returns a bucket for a name that
 * genuinely occurred.
 *
 * Sorted alphabetically rather than following either source's own order
 * (`schema`'s own rows already arrive that way — see schema/routes.ts's
 * `ORDER BY event_name ASC` — but a name added by the `stats` half of the
 * union has no such guarantee), so the combined list has one deterministic
 * order regardless of which source contributed a given name.
 */
function mergeEventCounts(schema: SchemaEventsResponse, stats: StatsResponse): EventCount[] {
  const totals = new Map<string, number>()
  for (const bucket of stats.buckets) {
    if (bucket.event_name === undefined) continue
    totals.set(bucket.event_name, (totals.get(bucket.event_name) ?? 0) + bucket.events)
  }
  const names = new Set(schema.events.map((e) => e.event_name))
  for (const name of totals.keys()) names.add(name)
  return [...names].sort().map((event_name) => ({
    event_name,
    count: totals.get(event_name) ?? 0,
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
    // `truncated` is a HEURISTIC ("the list came back exactly at the page
    // ceiling"), not a fact from the server — which returns no total count
    // to check against. A project with EXACTLY SCHEMA_MAX_LIMIT distinct
    // property-bearing names would trip this heuristic despite the list
    // already being complete, so the sentence hedges ("may have") rather
    // than asserting more names exist, the same over-claim this whole field
    // was added to stop making. It only qualifies the property-bearing,
    // all-time half of the list (`schema/events`' own ceiling) — the
    // window-only half added by the union below has no ceiling of its own
    // here, only `events/stats`' separate bucket limit.
    const completeness = events.truncated
      ? `showing the first ${SCHEMA_MAX_LIMIT} all-time, property-bearing event names, plus every other name that fired in this window — this project may have more than that`
      : 'every event name that fired in this window, plus every all-time name that has ever carried a property (an all-time, property-less name that fired outside this window will not appear)'
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

  try {
    const project = await ctx.client.get<ProjectResponse>('/v1/project')

    // `normalizeHost` runs AFTER the first request has already succeeded,
    // deliberately — not before it, the way the first cut of this fix had
    // it. A genuinely unparseable `--host`/`LYRAFLOW_HOST` must fail the
    // same way it does for every other command in this CLI: `Client`'s own
    // `#buildUrl` (client.ts) throws `ApiError('invalid_url', "the
    // configured host is not a usable base URL (--host, or
    // LYRAFLOW_HOST)")` on the FIRST request that ever needs to build a
    // URL from it — exit 1, not exit 2. Running `normalizeHost` before any
    // request, as a separate usage-error check, diverged from that: same
    // bad host, same env var, exit 2 here and exit 1 everywhere else — a
    // real regression the previous round of this fix introduced, and one
    // `binary.test.ts`'s cross-command parity sweep (Task 4 adds `snippet`
    // to it) would have caught the moment it ran. Placed here, a bad host
    // never reaches `normalizeHost` at all in practice — the identical
    // `new URL(...)` parse `Client` needs has already failed first, on the
    // exact same string, so this call cannot throw a DIFFERENT outcome
    // than `GET /v1/project` just did.
    const host = normalizeHost(ctx.host)

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
