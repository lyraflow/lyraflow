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
 * theoretical one). `normalizeHost`/`buildSnippet`, now in
 * `@lyraflow/core` (`packages/core/src/snippet/build.ts`, shared with the
 * web UI so a second implementation cannot drift), are the fix — see their
 * own docstrings there.
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
 * actually came for. They degrade INDEPENDENTLY: one failing never
 * discards the other's answer, and the output names which one is missing,
 * because what the list means depends on which it was. A failure in (1) is
 * not informational; it is the whole command's only reason to have anything
 * to print, so it still fails the command outright.
 *
 * `interval: '1d'` is sent on every stats request, unconditionally — this
 * command only ever wants ONE total per event name across the window, so
 * the coarsest interval is also the one that survives the widest window,
 * and every matching bucket's count is summed client-side into that one
 * total (see `mergeEventCounts` below).
 *
 * IT DOES NOT MAKE THE REQUEST UNCONDITIONALLY SAFE, and this docstring
 * claimed it did ("comfortably inside the server's own `STATS_MAX_BUCKETS`
 * guard for any `--since` a caller is likely to pass") until the
 * whole-branch review checked it. One bucket per day against
 * `STATS_MAX_BUCKETS = 1000` (events/routes.ts) means (3) is rejected with
 * `400 window_too_large` for any `--since` beyond about 1000 days — call it
 * two years and nine months. That is not an exotic value: this command's
 * own documented remedy for a name neither request can see is to WIDEN the
 * window, and 30d → 90d → 365d → "all time" walks straight at it. The
 * ceiling costs the counts and nothing else now — (2) is all-time and
 * un-windowed, so it answers regardless — which is precisely what one
 * `try` around both requests used to throw away.
 */

import { buildSnippet, normalizeHost } from '@lyraflow/core'
// VALUE imports, not type-only — `SNIPPET_METHODS` is what the stub's
// method array is BUILT FROM (never retyped here, and now passed straight
// through to `buildSnippet` above), and `VERSION` is reported as
// `sdk_version`. This is the CLI importing the browser SDK, the opposite
// direction from the one `@lyraflow/core` value imports are forbidden in
// (that direction breaks the browser bundle) — safe here, and confirmed by
// running `pnpm build` after adding this import and checking
// `packages/sdk-browser/dist/lyraflow.js` is still produced.
import { SNIPPET_METHODS, VERSION } from '@lyraflow/sdk-browser'
import { UsageError, parseCommandArgs, resolveInstant } from '../args.js'
import { ApiError } from '../client.js'
import type { CommandContext } from '../context.js'
import { type Mode, emitObject, resolveMode, sanitizeForLine } from '../output.js'
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

/**
 * One event name paired with its windowed count — or with `null`, which
 * means "this name is real, its count is UNKNOWN". `null` appears only when
 * `events/stats` itself failed (see `EventsSectionOk.partial`): every name
 * then comes from `schema/events`, which reports names and no counts at
 * all. Rendering those as `0` would say "it fired before this window",
 * which is a specific, checkable claim this command would have no evidence
 * for — the human table prints `-` for them instead.
 */
interface EventCount {
  event_name: string
  count: number | null
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
 * have been read. Always `false` when `schema/events` is the request that
 * failed: there is no page to have been cut.
 *
 * `partial` is ABSENT on the ordinary path and present exactly when ONE of
 * the two informational requests failed and the other did not. Both halves
 * are informational, but they are not interchangeable, and which one is
 * missing changes what the rows below actually mean — so it names the
 * request rather than saying "something failed":
 *   - `events/stats` missing: the names are the all-time, property-bearing
 *     list, NOT windowed, and every `count` is `null` (unknown).
 *   - `schema/events` missing: the names are exactly what fired inside the
 *     window, with real counts; an all-time name that fired outside it is
 *     gone from the list entirely.
 * OPTIONAL, so the fully-successful shape is unchanged — a consumer pinning
 * the exact key set of `events` on the success path sees the same four keys
 * it always did.
 */
interface EventsSectionOk {
  since: string
  until: string
  counts: EventCount[]
  truncated: boolean
  partial?: { source: 'schema/events' | 'events/stats'; code: string; message: string }
}

/** The `events` field's shape when BOTH informational requests failed —
 * see the module docstring on why this degrades instead of failing the
 * whole command, and `fetchEventsSection` on why one failure alone no
 * longer reaches this shape. Carries `schema/events`' error: it is the
 * first request sent, and a cause common to both (an unreachable host, a
 * rejected key) surfaces there first. */
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
 *
 * `countsKnown: false` is the degraded call (`events/stats` failed, see
 * `fetchEventsSection`): `stats` is then an empty bucket list, so the
 * "absent from totals" branch would otherwise hand every name a `0` — a
 * claim that the event fired historically and has since stopped, which is
 * exactly the wrong thing to assert when the request that would have known
 * never answered. Those names get `null` instead.
 */
function mergeEventCounts(
  schema: SchemaEventsResponse,
  stats: StatsResponse,
  countsKnown = true,
): EventCount[] {
  const totals = new Map<string, number>()
  for (const bucket of stats.buckets) {
    if (bucket.event_name === undefined) continue
    totals.set(bucket.event_name, (totals.get(bucket.event_name) ?? 0) + bucket.events)
  }
  const names = new Set(schema.events.map((e) => e.event_name))
  for (const name of totals.keys()) names.add(name)
  return [...names].sort().map((event_name) => ({
    event_name,
    count: countsKnown ? (totals.get(event_name) ?? 0) : null,
  }))
}

/**
 * Runs one informational request and reports failure as a value rather than
 * an exception, so the caller can decide what a single failure costs.
 * Only an `ApiError` is caught; anything else (a real bug) still crashes
 * loudly, same as every other command in this CLI.
 */
async function attempt<T>(run: () => Promise<T>): Promise<{ value: T } | { error: ApiError }> {
  try {
    return { value: await run() }
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    return { error: err }
  }
}

/**
 * The two informational requests, each wrapped SEPARATELY so a failure in
 * one cannot discard the other's result — the snippet itself (host, write
 * key, methods) needs neither, so losing the thing the caller actually came
 * for over an events list that merely couldn't be fetched is the wrong
 * trade, and so is losing the half that DID answer.
 *
 * ONE `try` AROUND BOTH WAS A REAL DEFECT, not a tidiness point, and the
 * remedy this command's own documentation gives is what walked into it.
 * `events/stats` is sent with `interval: '1d'` against a server cap of
 * `STATS_MAX_BUCKETS = 1000` (events/routes.ts), so any `--since` past
 * about 1000 days is rejected with `400 window_too_large` — while
 * `schema/events` is ALL-TIME and un-windowed, so it is exactly the request
 * that would still have answered. Under a single `try`, `--since 999d`
 * printed four event names and `--since 1001d` printed an error: widening
 * the window, the documented way to find an event neither request has seen,
 * crossed a cliff where the caller got LESS than before. Verified live
 * against a project whose `schema/events` genuinely had rows.
 *
 * Which shape comes back:
 *   - both succeeded — the ordinary union, no `partial`.
 *   - one failed — the surviving half, plus `partial` naming the request
 *     that did not answer, because which one is missing changes what the
 *     list means (see `EventsSectionOk`). A stats failure additionally
 *     makes every `count` `null`: unknown, not zero.
 *   - both failed — `{ error }`, the pre-existing shape, carrying
 *     `schema/events`' error as the first one sent.
 */
async function fetchEventsSection(
  ctx: CommandContext,
  since: Date,
  until: Date,
): Promise<EventsSection> {
  const schema = await attempt(() =>
    ctx.client.get<SchemaEventsResponse>('/v1/schema/events', { limit: SCHEMA_MAX_LIMIT }),
  )
  const stats = await attempt(() =>
    ctx.client.get<StatsResponse>('/v1/events/stats', {
      since: since.toISOString(),
      until: until.toISOString(),
      interval: '1d',
      group_by: 'event_name',
    }),
  )

  const window = { since: since.toISOString(), until: until.toISOString() }

  if ('error' in schema && 'error' in stats) {
    return { error: { code: schema.error.code, message: schema.error.message } }
  }
  if ('error' in schema) {
    // `truncated: false` — `schema/events`' page ceiling is the only thing
    // that field ever described, and that request never answered.
    return {
      ...window,
      counts: mergeEventCounts({ events: [] }, (stats as { value: StatsResponse }).value),
      truncated: false,
      partial: {
        source: 'schema/events',
        code: schema.error.code,
        message: schema.error.message,
      },
    }
  }
  if ('error' in stats) {
    return {
      ...window,
      counts: mergeEventCounts(schema.value, { buckets: [] }, false),
      truncated: schema.value.events.length === SCHEMA_MAX_LIMIT,
      partial: { source: 'events/stats', code: stats.error.code, message: stats.error.message },
    }
  }
  return {
    ...window,
    counts: mergeEventCounts(schema.value, stats.value),
    truncated: schema.value.events.length === SCHEMA_MAX_LIMIT,
  }
}

/** Two-space-separated, name-padded rows — same alignment convention
 * `emitRecords`' own table uses (output.ts), reimplemented small rather
 * than reused: `emitRecords` takes a list of RECORDS through `Column`s and
 * always renders the header line and NDJSON shape this command does not
 * want, and its JSON-mode branch cannot express the freeform multi-section
 * human text (the raw multi-line snippet plus this table) this command
 * needs below it.
 *
 * EVERY NAME GOES THROUGH `sanitizeForLine` FIRST, and this is the one line
 * of this function that is load-bearing rather than cosmetic. `event_name`
 * is not this CLI's text: it arrives from `/v1/track`, whose write key is
 * public by construction (see this module's own docstring) and whose
 * validation bounds only LENGTH (`z.string().min(1).max(128)`,
 * packages/core/src/ingest/payloads.ts) — no character class, so `\n`, `\r`
 * and `ESC` are all accepted event names, choosable by any visitor to the
 * instrumented site. Printed raw, a name carrying `ESC[6A`/`ESC[2K` moves
 * the terminal's cursor back up over the snippet this command just printed,
 * erases a line of it, writes a third-party `<script src=…>` in its place,
 * and then erases its own row on the way back down — so the operator
 * selects a block that no longer says what the CLI computed, pastes it into
 * a live page, and nothing on screen ever hinted at it. A bare `\n` forges
 * a whole extra row without needing an escape sequence at all.
 *
 * Sanitising BEFORE `width` is measured, not at the point of printing, is
 * the other half: the escaped form is what occupies columns on screen, so
 * measuring the raw name would misalign every row after a hostile one — the
 * same reason `emitRecords` measures `safeGet`'s already-sanitised cells.
 *
 * This function is where the branch's own Critical lived. `renderHuman`
 * below explains why the SNIPPET must not be sanitised; that reasoning was
 * read as covering this table too, and it never did. */
function renderEventsTable(counts: EventCount[]): string {
  const rows = counts.map((c) => ({
    name: sanitizeForLine(c.event_name),
    // `null` is "this name is real, its count is unknown" (see `EventCount`)
    // — printed as `-` rather than `0`, which would assert something this
    // command has no evidence for, or as `null`, which reads like a value.
    count: c.count === null ? '-' : String(c.count),
  }))
  const width = Math.max(...rows.map((r) => r.name.length))
  return rows.map((r) => `  ${r.name.padEnd(width)}  ${r.count}`).join('\n')
}

/**
 * Renders a failed request's `code`/`message` pair for a human sentence,
 * without the stutter the pair produces on the exact status this command
 * degrades on most often. `Client#toApiError` (client.ts) sets `message` to
 * the body's `error` field for 400/422 — which IS the code — so the obvious
 * `${message} (${code})` printed `window_too_large (window_too_large)`.
 *
 * The collapsed form is the BARE code, not a parenthesised one: the
 * parentheses exist to mark "and here is the machine-readable code for the
 * sentence you just read", and with nothing before them they left a
 * sentence reading `Event counts unavailable: (window_too_large) —`, a
 * parenthetical attached to nothing. When the code IS the whole message, it
 * is the sentence.
 *
 * Fixed HERE, in the renderer, rather than by carrying the server's own
 * `detail` through `ApiError`: `detail` would be a better message, but
 * `ApiError.message` is what every command in this CLI renders and what
 * `--json`'s documented `{error, code}` line carries, so changing what
 * fills it is a CLI-wide output-contract change — the wrong size of change
 * for a stuttering sentence, and one that belongs to its own round with its
 * own review of what a server may put in `detail`.
 *
 * Both halves go through `sanitizeForLine`: `code` is echoed from the
 * response body, so it is server text like any other.
 */
function describeFailure(code: string, message: string): string {
  const safeCode = sanitizeForLine(code)
  return message === code ? safeCode : `${sanitizeForLine(message)} (${safeCode})`
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
 *
 * WHICH PART OF THIS OUTPUT IS EXEMPT FROM `sanitizeForLine`, EXACTLY:
 * the `snippet` string, and nothing else. It is exempt because THIS CLI
 * BUILT IT — `buildSnippet` above assembles it from a fixed template, a
 * normalised origin and a `jsStringLiteral`-encoded write key, so its
 * newlines are ours and are the point of the command. Every other string
 * on the page below it comes from the SERVER, and server strings are
 * sanitised like anywhere else in this CLI: the event names go through
 * `sanitizeForLine` in `renderEventsTable` (see its docstring for what a
 * raw one does to a terminal), and the degraded `code`/`message` pair
 * below goes through it here for the same reason — `code` is echoed from
 * the response body by `Client#toApiError` (client.ts), so it is server
 * text too, not a fixed string this module chose.
 *
 * "Rendered by hand" is not "rendered without the shared helper". The
 * exemption is one value wide.
 */
function renderHuman(snippet: string, events: EventsSection): string {
  const lines = [snippet, '']
  if ('error' in events) {
    lines.push(
      `Event counts unavailable: ${describeFailure(events.error.code, events.error.message)}.`,
    )
    return `${lines.join('\n')}\n`
  }

  // `truncated` is a HEURISTIC ("the list came back exactly at the page
  // ceiling"), not a fact from the server — which returns no total count to
  // check against. A project with EXACTLY SCHEMA_MAX_LIMIT distinct
  // property-bearing names would trip this heuristic despite the list
  // already being complete, so the sentence hedges ("may have") rather than
  // asserting more names exist, the same over-claim this whole field was
  // added to stop making. It only qualifies the property-bearing, all-time
  // half of the list (`schema/events`' own ceiling) — the window-only half
  // added by the union has no ceiling of its own here, only
  // `events/stats`' separate bucket limit.
  const completeness = events.truncated
    ? `showing the first ${SCHEMA_MAX_LIMIT} all-time, property-bearing event names, plus every other name that fired in this window — this project may have more than that`
    : 'every event name that fired in this window, plus every all-time name that has ever carried a property (an all-time, property-less name that fired outside this window will not appear)'

  // NO FLAG VALUE IS ECHOED HERE. This sentence read "Event counts since
  // ${sinceRaw} ago", which `resolveInstant` (args.ts) makes wrong as often
  // as it makes it right: `--since` accepts an absolute ISO instant too, so
  // the line printed "Event counts since 2026-01-01T00:00:00.000Z ago". The
  // resolved window below already says exactly what was asked, in one form
  // for both spellings — and not repeating the raw value keeps this command
  // aligned with args.ts's own rule that a flag value never reaches output.
  const window = `${events.since} to ${events.until}`

  if (events.partial?.source === 'events/stats') {
    // The window was never queried. Saying anything about "this window"
    // here would be a claim about a request that did not answer.
    lines.push(
      `Event counts unavailable: ${describeFailure(events.partial.code, events.partial.message)} — listing names from the all-time schema instead, with counts shown as -.`,
    )
    lines.push(
      events.counts.length === 0
        ? 'No event names have ever carried a property, so there are none to list from that source alone. Re-run to retry the counts.'
        : `${events.truncated ? `The first ${SCHEMA_MAX_LIMIT} all-time` : 'Every all-time'} event name that has ever carried a property (a property-less name is invisible to this source, whenever it fired):`,
    )
    if (events.counts.length > 0) lines.push(renderEventsTable(events.counts))
    return `${lines.join('\n')}\n`
  }

  if (events.partial?.source === 'schema/events') {
    lines.push(
      `All-time event names unavailable: ${describeFailure(events.partial.code, events.partial.message)} — showing this window's own counts only.`,
    )
    lines.push(
      events.counts.length === 0
        ? `No events fired between ${events.since} and ${events.until}.`
        : `Event counts for ${window}, every event name that fired in this window (a name that fired only outside it is missing here, where the all-time list would have shown it):`,
    )
    if (events.counts.length > 0) lines.push(renderEventsTable(events.counts))
    return `${lines.join('\n')}\n`
  }

  if (events.counts.length === 0) {
    lines.push('No events recorded yet.')
  } else {
    lines.push(
      `Event counts for ${window}, ${completeness}. A zero count means it fired before this window, not that it is broken:`,
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
    const snippet = buildSnippet(host, project.write_key, SNIPPET_METHODS)

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
      ctx.write(renderHuman(snippet, eventsSection))
    }
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}
