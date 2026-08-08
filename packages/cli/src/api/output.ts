/**
 * The JSON shape is a PROMISED INTERFACE. Field names, types and the absence of
 * a wrapper are documented, and change only with OUTPUT_SCHEMA_VERSION.
 *
 * The table is NOT. It may gain columns, lose them, or be reformatted entirely
 * in any release. Anything parsing the table is parsing something we did not
 * agree to keep still — which is exactly why `--json` exists and why the
 * documentation tells an agent to pass it explicitly rather than rely on
 * stdout not being a terminal.
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
 * Turns any value — including the non-string shapes a `Column.get` or an
 * `emitObject` field is not supposed to produce, but nothing at runtime
 * actually prevents — into a single safe line of display text.
 *
 * `undefined` becomes `''` (nothing to show); `null` becomes the literal
 * `'null'` (distinguishable from "absent"); numbers and booleans stringify
 * plainly; objects and arrays go through `JSON.stringify` (itself already
 * single-line-safe, per `sanitizeForLine`'s docstring) so a nested value is
 * still visible rather than rendered as `[object Object]`.
 */
function toCell(value: unknown): string {
  if (value === undefined) return ''
  if (value === null) return 'null'
  if (typeof value === 'string') return sanitizeForLine(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return sanitizeForLine(JSON.stringify(value) ?? String(value))
  } catch {
    return String(value)
  }
}

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
    for (const record of records) {
      const json = JSON.stringify(record)
      write(`${json ?? 'null'}\n`)
    }
    return
  }

  const rows = records.map((record) => columns.map((col) => safeGet(col, record)))
  const widths = columns.map((col, i) =>
    Math.max(col.header.length, ...rows.map((row) => row[i]?.length ?? 0)),
  )

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] as number)))
      .join('  ')

  write(`${renderRow(columns.map((c) => c.header))}\n`)
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
    const json = JSON.stringify(record)
    write(`${json ?? 'null'}\n`)
    return
  }

  if (record !== null && typeof record === 'object') {
    const pairs = Object.entries(record as Record<string, unknown>).map(
      ([key, value]) => `${key}: ${toCell(value)}`,
    )
    write(`${pairs.join('  ')}\n`)
    return
  }

  write(`${toCell(record)}\n`)
}

/**
 * `err` is `unknown` because it may be anything JavaScript lets a caller
 * throw, and this function must render every one of them without crashing
 * — an error handler that itself throws hides the original failure. Three
 * shapes are distinguished:
 *
 * - `ApiError` (client.ts): the request reached the wire; `code` is the
 *   server's own error code (or a synthetic `http_<status>` / `no_response`
 *   fallback — see client.ts). Maps to exit code 1 downstream.
 * - `UsageError` (args.ts): the request was never sent; `code` is the fixed
 *   string `usage_error`, since a `UsageError` carries no code of its own.
 *   Maps to exit code 2 downstream.
 * - anything else — a plain `Error`, a thrown string, a thrown object with
 *   no `status`/`code` at all — gets `code: 'error'` and a best-effort
 *   message, so the JSON line is always well-formed even for a value this
 *   CLI never intended to throw.
 *
 * `emitError` itself does not decide the exit code; it only renders. Which
 * `code`/status maps to which exit code is the caller's job (see the
 * module docstring on `UsageError`/`ApiError` in args.ts).
 */
export function emitError(err: unknown, mode: Mode, write: (s: string) => void): void {
  const { error, code } = describeError(err)

  if (mode === 'json') {
    write(`${JSON.stringify({ error, code })}\n`)
    return
  }

  write(`Error: ${error} (${code})\n`)
}

function describeError(err: unknown): { error: string; code: string } {
  if (err instanceof ApiError) return { error: err.message, code: err.code }
  if (err instanceof UsageError) return { error: err.message, code: 'usage_error' }
  if (err instanceof Error) return { error: err.message, code: 'error' }
  return { error: String(err), code: 'error' }
}
