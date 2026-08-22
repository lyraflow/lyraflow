/**
 * The JSON shape is a PROMISED INTERFACE. Field names, types and the absence of
 * a wrapper are documented, and change only with OUTPUT_SCHEMA_VERSION.
 *
 * The table is NOT. It may gain columns, lose them, or be reformatted entirely
 * in any release. Anything parsing the table is parsing something we did not
 * agree to keep still — which is exactly why `--json` exists and why the
 * documentation tells an agent to pass it explicitly rather than rely on
 * stdout not being a terminal.
 *
 * KNOWN LIMIT of the "record could not be serialised" degraded shape (see
 * `safeJsonLine`): it writes `{ error, detail }`. A real record that
 * happens to carry exactly those two keys is indistinguishable on the wire
 * from a degraded line — this is a convention, not a structural guarantee.
 * A future command whose records legitimately carry an `error` field should
 * know that before relying on shape alone to tell the two apart.
 */

import { UsageError } from './args.js'
import { ApiError } from './client.js'

/** Bumped only when a documented JSON field changes shape or meaning. */
export const OUTPUT_SCHEMA_VERSION = 1

/**
 * The CLI's own release version, reported by `lyraflow --version` alongside
 * `OUTPUT_SCHEMA_VERSION`. Hand-maintained here — a literal, not a read of
 * `packages/cli/package.json` at runtime — and pinned against that file by
 * `output.test.ts`'s "CLI_VERSION" suite, which fails the moment the two
 * disagree. Same shape as `SCHEMA_VERSION` (packages/core/src/index.ts) and
 * its `schema-version.test.ts`: a built constant, checked against its
 * independent source of truth on disk, rather than trusted to stay in sync
 * by discipline alone.
 *
 * Bump this by hand whenever packages/cli/package.json's "version" changes —
 * the test only catches forgetting, not the two ever having a real reason
 * to differ (there is none: they name the same release).
 */
export const CLI_VERSION = '0.9.0'

export type Mode = 'human' | 'json'

/**
 * `flags.json` / `flags.human` win over `isTty` in either direction — an
 * explicit flag always overrides detection. Detection alone is a known
 * footgun ("works in my terminal, breaks in CI"), which is why the CLI's
 * docs tell an agent to pass `--json` explicitly rather than rely on stdout
 * not being a terminal.
 *
 * When BOTH `--json` and `--human` are passed, `json` wins — pinned, not
 * incidental (`flags.json` is checked first). This is the safer default for
 * an ambiguous request: a script that asked for `--json` and gets a table
 * back breaks silently (the output still "parses" as text, just not as the
 * shape the caller expected), while a human who asked for `--human` and
 * gets JSON back just sees JSON — readable, if not the format requested.
 */
export function resolveMode(flags: { json?: boolean; human?: boolean }, isTty: boolean): Mode {
  if (flags.json) return 'json'
  if (flags.human) return 'human'
  return isTty ? 'human' : 'json'
}

export interface Column {
  header: string
  get: (row: never) => string
}

/** C0 (0x00–0x1f), DEL (0x7f) and C1 (0x80–0x9f) — every codepoint a
 * terminal may treat as an instruction rather than as text. See
 * `sanitizeForLine` below for why escaping all of them, not only the two
 * that break the layout, is the point. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this constant's entire job.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g

/**
 * Replaces the characters that would otherwise break the single-line
 * guarantee this module makes for both a table row and a human `emitObject`
 * line: a raw newline (bare `\n`, `\r`, or `\r\n`) would split one row into
 * two; a raw tab has no fixed display width and would silently defeat
 * `padEnd` alignment. Both are replaced with a visible escape rather than
 * dropped, so the value's presence is still visible instead of silently
 * vanishing.
 *
 * EVERY OTHER CONTROL CHARACTER IS ESCAPED TOO, and that half is not
 * cosmetic. Newline and tab break the LAYOUT; `ESC` (0x1b) breaks the
 * TERMINAL. A value carrying `ESC[2K` or `ESC[6A` is not text the terminal
 * prints — it is a command the terminal OBEYS: move the cursor up six
 * lines, erase the line that is there, and write something else over it.
 * Server data reaches this module (an event name, a property key, a segment
 * name) and server data reaches the server from ingest, whose own validation
 * (`packages/core/src/ingest/payloads.ts`) bounds LENGTH and nothing else —
 * no character class — and whose write key is public by construction. So
 * "the bytes in this cell were chosen by a stranger who visited the
 * customer's website" is the ordinary case, not the exotic one, and a
 * renderer that hands those bytes to a terminal verbatim lets that stranger
 * rewrite lines the operator already read, including lines the operator is
 * about to copy and paste. That was a real defect on this branch: a forged
 * `event_name` rewrote the bundle URL inside `lyraflow snippet`'s own
 * paste-ready block and then erased its own row, with exit code 0 and
 * nothing on screen to hint at it.
 *
 * The escape is `\xNN` (lowercase hex, always two digits) rather than a
 * character dropped or replaced with `?`: reversible enough that an
 * operator who sees `\x1b` can tell exactly which byte was there, and
 * inert — every character of the replacement is printable ASCII, so the
 * output of this function can contain no control character at all, by
 * construction. C1 (0x80–0x9f) is included because a terminal in an
 * 8-bit-control mode treats 0x9b as CSI, i.e. as `ESC[` by another name.
 *
 * Ordinary values are untouched: printable ASCII, accented Latin, CJK,
 * emoji and every other non-control codepoint pass through byte-for-byte.
 *
 * ONE CONTROL CHARACTER NEVER REACHES THE THIRD REPLACEMENT: `\r` (0x0d),
 * consumed by the first, which maps `\r\n`, `\n` and a lone `\r` all to the
 * same `\n`. So `zz_cr\rOVERWRITTEN` prints exactly as a value carrying a
 * newline would. Harmless — a lone `\r` moves the cursor to column 0, which
 * is what a newline does too, minus the line feed — and pre-existing, but
 * it is the one place this function is lossy about WHICH byte was there,
 * and the docstring should say so rather than let a reader infer `\xNN`
 * covers everything.
 *
 * NOT APPLIED TO THE JSON PATH — but not because `JSON.stringify` makes it
 * unnecessary. It does not: `JSON.stringify` escapes C0 (so `ESC` becomes
 * the six literal characters `\`+`u001b`) and passes DEL (0x7f) and the
 * WHOLE C1 BLOCK (0x80–0x9f) through RAW. 0x9b raw in a JSON line is CSI —
 * the same byte this function escapes four paragraphs above for exactly
 * that reason. That gap is closed by `escapeJsonControls` below, applied at
 * every point this module serialises, rather than by running this function
 * over JSON: `\xNN` is not JSON escape syntax, and rewriting a serialised
 * document with a rule meant for display text would corrupt it. The JSON
 * path needs `\u007f`, and gets it.
 *
 * Exported because a command that renders its own human output instead of
 * going through `emitRecords`/`emitObject` (`snippet`'s events table is the
 * only one today) must still route server-supplied text through THE SAME
 * function. A second, hand-rolled sanitiser is how the defect above shipped
 * in the first place: every other renderer in this CLI was already correct.
 */
export function sanitizeForLine(s: string): string {
  return s
    .replace(/\r\n|\n|\r/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(CONTROL_CHARACTERS, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
}

/** The control characters `JSON.stringify` leaves RAW inside a string it
 * serialises: DEL and C1. C0 it already escapes itself. */
const JSON_RAW_CONTROLS = /[\u007f-\u009f]/g

/**
 * Finishes what `JSON.stringify` starts. It escapes C0 and stops there, so
 * a DEL or any C1 byte — 0x9b is CSI, an `ESC[` a terminal obeys without
 * needing an `ESC` — travels through `--json` intact. Measured on this
 * CLI's own output before this function existed: `lyraflow snippet --json`
 * emitted 1621 bytes containing two raw control characters, codes 127 and
 * 155, for a project carrying one hostile event name. `--json` is the
 * format an agent pipes somewhere, and "somewhere" is very often a terminal.
 *
 * Runs over the SERIALISED document, which is safe precisely because
 * `JSON.stringify` has already escaped everything structural: outside a
 * string literal, JSON is printable ASCII only, so a byte in this range can
 * only be string CONTENT. `\uXXXX` is JSON's own escape syntax, so the
 * result is still valid JSON and `JSON.parse` returns the IDENTICAL string
 * — nothing is lost, only spelled differently. That is why this is worth
 * doing at all: it costs nothing a consumer can observe, and it makes the
 * "terminal-safe" claim true rather than nearly true.
 *
 * A non-issue for surrogate pairs and every other non-control codepoint:
 * this range contains none of them, and characters outside it are untouched.
 */
function escapeJsonControls(json: string): string {
  return json.replace(
    JSON_RAW_CONTROLS,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

/**
 * The one place in this module that converts an arbitrary, untrusted value
 * into a string on a "best effort, cannot fail" basis — every other guard
 * here (`toCell`, `describeError`, `safeJsonLine`) reaches for this instead
 * of calling `String()` directly.
 *
 * `String(value)` invokes `value`'s own `toString`/`Symbol.toPrimitive`,
 * which can itself throw — a value can be deliberately (or accidentally,
 * via a Proxy or a poisoned prototype) built to defeat exactly this kind of
 * fallback. This function is where that risk terminates: it tries once,
 * and if the value fights back, returns a fixed literal that performs NO
 * further operation on `value` — nothing left for a next attack to defeat.
 *
 * This is the guarantee this whole module rests on, made structural rather
 * than a list of individually-guarded call sites: if a new failure mode of
 * `String()` turns up, it gets fixed HERE, once. The next person hardening
 * this module should widen this function's callers, not add another ad hoc
 * try/catch beside it — that is exactly the pattern that let two crashes
 * hide in `describeError`'s fallback and `safeJsonLine`'s own catch block
 * across the module's first two review rounds.
 */
function describeUnknown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '<unrenderable value>'
  }
}

/**
 * Turns any value — including the non-string shapes a `Column.get` or an
 * `emitObject` field is not supposed to produce, but nothing at runtime
 * actually prevents — into a single safe line of display text.
 *
 * `undefined` becomes `''` (nothing to show); `null` becomes the literal
 * `'null'` (distinguishable from "absent"); numbers and booleans stringify
 * plainly; objects and arrays go through `JSON.stringify` (itself already
 * single-line-safe, per `sanitizeForLine`'s docstring) so a nested value is
 * still visible rather than rendered as `[object Object]`. Anything
 * `JSON.stringify` cannot handle — or whose stringification throws for any
 * other reason — falls through to `describeUnknown`, which cannot itself
 * throw, so this function's own "never crashes" promise holds regardless
 * of what `value` does.
 */
function toCell(value: unknown): string {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (typeof value === 'string') return sanitizeForLine(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return sanitizeForLine(JSON.stringify(value) ?? describeUnknown(value))
  } catch {
    return sanitizeForLine(describeUnknown(value))
  }
}

/**
 * `JSON.stringify` throws for a handful of values it cannot represent —
 * a `bigint` anywhere in the structure (`TypeError: Do not know how to
 * serialize a BigInt`) is the practical one, since ClickHouse counts can
 * exceed `Number.MAX_SAFE_INTEGER` and a future command that reads one
 * directly (rather than through Task 4's client, which only ever hands this
 * module the output of `res.json()`, and native `JSON.parse` never produces
 * a `bigint`) is a plausible caller.
 *
 * NDJSON's whole value is that a consumer can read it line by line without
 * holding the full response in memory — so a record this module cannot
 * serialise must still produce exactly one line, not zero (a silently
 * truncated stream) and not a thrown exception (which would abort every
 * record after it, not just the bad one). The fallback line is honest about
 * what happened rather than inventing a value: it says the record could not
 * be serialised and includes the real error's message, not a guess at the
 * record's shape.
 *
 * `escapeJsonControls` runs over the serialised line for the reason its own
 * docstring gives: `JSON.stringify` alone leaves DEL and every C1 byte raw,
 * and a raw 0x9b is a CSI introducer in whatever reads this stream.
 */
function safeJsonLine(value: unknown): string {
  try {
    return escapeJsonControls(JSON.stringify(value) ?? 'null')
  } catch (err) {
    return describeSerialisationFailure(err)
  }
}

/**
 * Two layers, on purpose, matching `emitError`'s shape below: the inner one
 * tries to say something useful about WHY `JSON.stringify` failed (via
 * `describeUnknown`, which cannot itself throw — so this layer's only
 * remaining risk is `JSON.stringify` on the wrapper object itself, which
 * holds nothing but plain strings and cannot fail). The outer `catch` is
 * the true guarantee: a fixed literal, computed from nothing, for the case
 * where building even that much has somehow failed. It is reachable only
 * if a future change reintroduces a dynamic value into the wrapper below —
 * kept as a second layer anyway, because "structurally cannot throw" beats
 * "should not throw given the code as currently written".
 */
function describeSerialisationFailure(err: unknown): string {
  try {
    return escapeJsonControls(
      JSON.stringify({
        error: 'this record could not be serialised as JSON',
        // `describeUnknown` is `String(err)` on a value this module does not
        // control -- a thrown Error whose message came off the wire lands
        // here, so this line is no more trusted than a record field is.
        detail: describeUnknown(err),
      }),
    )
  } catch {
    return UNSERIALISABLE_LINE
  }
}

const UNSERIALISABLE_LINE =
  '{"error":"this record could not be serialised as JSON","detail":"unknown"}'

/**
 * Calls a caller-supplied `Column.get` defensively. `Column.get`'s type
 * says it always returns a `string` for a well-formed `row`, but nothing
 * at runtime enforces that: a getter written as `row.field` throws when
 * `row` itself is `null`/`undefined` (a record that is not an object at
 * all — see the "non-object record" cases in output.test.ts), and this
 * function's whole job is to make one malformed record produce an empty
 * cell instead of taking the rest of the table down with it.
 */
function safeGet(col: Column, row: unknown): string {
  try {
    return toCell(col.get(row as never))
  } catch {
    return ''
  }
}

/**
 * `col.header` gets the same protection `col.get` has via `safeGet`, for
 * the same reason: reading a property is an operation, and an operation
 * can throw. A `Column` is first-party CLI code rather than server data,
 * so a throwing header means a bug in a command definition — which is
 * exactly when the table must still render enough to read the bug from,
 * rather than taking the process down while reporting it.
 */
function safeHeader(col: Column): string {
  try {
    return toCell(col.header)
  } catch {
    return ''
  }
}

/**
 * The one shape this module was never hardened against: the CONTAINER
 * itself. Every guard above (`toCell`, `safeGet`, `safeJsonLine`,
 * `describeUnknown`) protects against hostile values INSIDE `records`, and
 * every test passed an array — so `emitRecords`' first statement,
 * `records.length`, was an unguarded property read on caller-supplied data
 * in the module whose docstring promises it never crashes. A host answering
 * `200 application/json` with `{}` made all five list commands exit 1 with
 * a raw `TypeError: Cannot read properties of undefined (reading 'length')`
 * and a Node stack trace on stderr — under `--json`, where the contract
 * promises `{error, code}`.
 *
 * Three layers were each correct alone: `Client` guaranteed only "the body
 * is JSON" (it now also guarantees "an object" — see its `#readJson`), the
 * command modules' TypeScript interfaces declare these fields non-optional
 * and nothing enforces that at runtime, and this module guarded everything
 * except the container. This is that gap, closed where it cannot recur:
 * every list this CLI prints, present or future, comes through here.
 *
 * Raised as `ApiError`, deliberately, rather than a new error class: the
 * request did reach the server and the answer was unusable, which is
 * exactly what `ApiError` means and exactly what every command's existing
 * `reportCommandFailure` already renders as `{error, code}` with exit 1. A
 * new class would be rethrown by that same function and crash instead.
 * `status` is 0 for the same reason `no_response` uses 0 — the HTTP status
 * was fine; what came back under it was not.
 */
function assertList(records: unknown): asserts records is unknown[] {
  if (!Array.isArray(records)) {
    throw new ApiError(
      0,
      'invalid_response_shape',
      'the server returned a 2xx response with no list of records where one was expected',
    )
  }
}

/**
 * NDJSON in `json` mode: one `JSON.stringify`d record per line, nothing
 * else — no wrapping array, no header, no summary line, because records
 * are data. An empty list writes nothing at all in EITHER mode: an agent
 * reading zero lines of JSON must not have to distinguish "no events" from
 * "a header with no rows" (see the module docstring's promise), and a
 * human piping the same command through a pager gets the same "nothing to
 * show" signal rather than a header floating over a blank table.
 *
 * `human` mode renders a table: each column padded to the widest of its
 * header or any cell (via `padEnd` — alignment, not a layout engine), cells
 * joined by two spaces, with the LAST column left unpadded so no row ends
 * in trailing whitespace. `columns` is consulted only in `human` mode —
 * `json` mode always emits every field of the record as given, so a record
 * with keys the columns don't know about is not silently dropped from the
 * contract; the table simply shows less of it, which is fine because the
 * table was never the contract.
 */
export function emitRecords(
  records: unknown[],
  mode: Mode,
  columns: Column[],
  write: (s: string) => void,
): void {
  assertList(records)
  if (records.length === 0) return

  if (mode === 'json') {
    for (const record of records) write(`${safeJsonLine(record)}\n`)
    return
  }

  const rows = records.map((record) => columns.map((col) => safeGet(col, record)))
  const headers = columns.map(safeHeader)
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i]?.length ?? 0)),
  )

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] as number)))
      .join('  ')

  write(`${renderRow(headers)}\n`)
  for (const row of rows) write(`${renderRow(row)}\n`)
}

/**
 * A single record — `lyraflow --version`'s `{ version, output_schema }` is
 * the only caller today. `json` mode writes one `JSON.stringify`d line, the
 * same shape as one line of `emitRecords`' NDJSON. `human` mode writes one
 * line of `key: value` pairs — this is what makes `--version`'s human
 * output a single line "for free": `emitObject` never special-cases the
 * number of fields, so a caller does not have to either.
 *
 * `null`/`undefined` is the one value this REFUSES rather than renders, for
 * the same reason `emitRecords` refuses a non-array (see `assertList`):
 * every caller passes either a record read off a 2xx body or an object this
 * CLI built itself, and "there is no record here at all" is a failed
 * request answered with a 200, not something to print the word `null` for
 * and exit 0 over. A string or a number still renders — those are values,
 * badly shaped but present, and refusing them would cost the module's own
 * "never crashes on a hostile value" property for no gain.
 */
export function emitObject(record: unknown, mode: Mode, write: (s: string) => void): void {
  if (record === null || record === undefined) {
    throw new ApiError(
      0,
      'invalid_response_shape',
      'the server returned a 2xx response with no record where one was expected',
    )
  }
  if (mode === 'json') {
    write(`${safeJsonLine(record)}\n`)
    return
  }

  if (record !== null && typeof record === 'object') {
    // Object.entries needs [[OwnPropertyKeys]] and [[GetOwnProperty]], both
    // of which a Proxy can make throw. json mode is already immune here via
    // safeJsonLine, and a format that survives less than the one it exists
    // to be a fallback for is the wrong way round -- the same asymmetry, in
    // reverse, that made a BigInt crash json while the table shrugged.
    let pairs: string[]
    try {
      pairs = Object.entries(record as Record<string, unknown>).map(
        ([key, value]) => `${key}: ${toCell(value)}`,
      )
    } catch {
      write(`${describeUnknown(record)}\n`)
      return
    }
    write(`${pairs.join('  ')}\n`)
    return
  }

  write(`${toCell(record)}\n`)
}

/**
 * `err` is `unknown` because it may be anything JavaScript lets a caller
 * throw, and this function must render every one of them without crashing
 * — an error handler that itself throws hides the original failure.
 *
 * Computing the line (`renderErrorLine`) and writing it (`write`) are
 * deliberately two separate steps, not one: `renderErrorLine` is wrapped so
 * it cannot throw, but `write` is called OUTSIDE that wrapping, on purpose.
 * A `write` that throws (a closed stdout, a broken pipe) is a real failure
 * the caller needs to see — swallowing it here would turn a legitimate,
 * actionable error into total silence, which is a worse bug than the one
 * this function exists to prevent. See `renderErrorLine`'s docstring for
 * why *its* half of the job cannot itself throw.
 */
export function emitError(err: unknown, mode: Mode, write: (s: string) => void): void {
  write(renderErrorLine(err, mode))
}

/**
 * Round 1 guarded `describeError`'s own fallback (a thrown non-Error's
 * `String()`). Round 2 found that guard was not enough: `describeError`'s
 * `instanceof` checks run BEFORE that fallback is ever reached, and
 * `instanceof` invokes `Symbol.hasInstance`, which walks `err`'s prototype
 * chain — a Proxy with a `getPrototypeOf` trap that throws makes line
 * `err instanceof ApiError` throw before any of this function's own guards
 * exist to catch it.
 *
 * Rather than add a third guard for a third way in, this function wraps
 * ALL of `describeError`'s work — the `instanceof` chain, the message
 * lookup, the JSON/human formatting, all of it — in ONE outer `try`. The
 * `catch` emits a FIXED LITERAL: no `String(err)`, no `err.message`, no
 * `JSON.stringify` of anything derived from `err` — nothing that touches
 * `err` at all. A constant cannot throw, so this is where the "never
 * crashes" guarantee becomes structurally true instead of a list of
 * individually-guarded operations that a next attacker just has to find
 * the gap between. `describeError`'s own internal guards (via
 * `describeUnknown`) are what make the COMMON case informative; this outer
 * catch is what makes the promise actually hold for every case.
 *
 * BOTH VALUES ARE SERVER TEXT WHENEVER `err` IS AN `ApiError`, and this is
 * the line that renders an error for all seven command groups. `code` is
 * the response body's own `error` field, echoed by `Client#toApiError`
 * (client.ts), and for a 400/422 `message` is that same field — so a host
 * answering `{"error":"[2K…"}` had six raw `ESC` bytes on the
 * operator's terminal from `events`, `stats`, `schema` and `snippet` alike,
 * measured live through a proxy. It needs a hostile or misconfigured server
 * rather than any visitor to an instrumented page, so it is a lower bar
 * than the event-name path — but it is the same pair, in the same shape,
 * and `snippet`'s own renderer already routes it through `sanitizeForLine`.
 * A shared renderer left inconsistent with a command-local one reads as a
 * deliberate exemption to the next person; it is not one.
 *
 * The `json` branch gets `escapeJsonControls` rather than `sanitizeForLine`
 * for the reason that function's docstring gives: `\xNN` is not JSON escape
 * syntax, and `JSON.stringify` leaves DEL and C1 raw on its own.
 */
function renderErrorLine(err: unknown, mode: Mode): string {
  try {
    const { error, code } = describeError(err)
    return mode === 'json'
      ? `${escapeJsonControls(JSON.stringify({ error, code }))}\n`
      : `Error: ${sanitizeForLine(error)} (${sanitizeForLine(code)})\n`
  } catch {
    return mode === 'json' ? FIXED_JSON_ERROR_LINE : FIXED_HUMAN_ERROR_LINE
  }
}

const FIXED_JSON_ERROR_LINE = '{"error":"an error value could not be rendered","code":"error"}\n'
const FIXED_HUMAN_ERROR_LINE = 'Error: an error value could not be rendered (error)\n'

/**
 * - `ApiError` (client.ts): the request reached the wire; `code` is the
 *   server's own error code (or a synthetic `http_<status>` / `no_response`
 *   fallback — see client.ts). Maps to exit code 1 downstream.
 * - `UsageError` (args.ts): the request was never sent; `code` is the fixed
 *   string `usage_error`, since a `UsageError` carries no code of its own.
 *   Maps to exit code 2 downstream.
 * - anything else — a plain `Error`, a thrown string, a thrown object with
 *   no `status`/`code` at all — gets `code: 'error'` and a best-effort
 *   message via `describeUnknown`, so the JSON line is well-formed even for
 *   a value this CLI never intended to throw.
 *
 * `emitError` itself does not decide the exit code; it only renders. Which
 * `code`/status maps to which exit code is the caller's job (see the
 * module docstring on `UsageError`/`ApiError` in args.ts).
 */
function describeError(err: unknown): { error: string; code: string } {
  if (err instanceof ApiError) return { error: err.message, code: err.code }
  if (err instanceof UsageError) return { error: err.message, code: 'usage_error' }
  if (err instanceof Error) return { error: err.message, code: 'error' }
  return { error: describeUnknown(err), code: 'error' }
}
