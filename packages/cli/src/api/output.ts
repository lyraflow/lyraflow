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
export const CLI_VERSION = '0.1.0'

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

/**
 * Replaces the characters that would otherwise break the single-line
 * guarantee this module makes for both a table row and a human `emitObject`
 * line: a raw newline (bare `\n`, `\r`, or `\r\n`) would split one row into
 * two; a raw tab has no fixed display width and would silently defeat
 * `padEnd` alignment. Both are replaced with a visible two-character escape
 * rather than dropped, so the value's presence is still visible instead of
 * silently vanishing.
 *
 * Deliberately NOT applied to the JSON path: `JSON.stringify` already
 * escapes every control character inside a string it serialises (a real
 * newline becomes the two literal characters `\`+`n`, never a raw newline),
 * so JSON output is single-line-safe by construction and needs no help here.
 */
function sanitizeForLine(s: string): string {
  return s.replace(/\r\n|\n|\r/g, '\\n').replace(/\t/g, '\\t')
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
 */
function safeJsonLine(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null'
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
    return JSON.stringify({
      error: 'this record could not be serialised as JSON',
      detail: describeUnknown(err),
    })
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
 */
export function emitObject(record: unknown, mode: Mode, write: (s: string) => void): void {
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
 */
function renderErrorLine(err: unknown, mode: Mode): string {
  try {
    const { error, code } = describeError(err)
    return mode === 'json' ? `${JSON.stringify({ error, code })}\n` : `Error: ${error} (${code})\n`
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
