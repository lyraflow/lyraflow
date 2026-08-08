import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UsageError } from './args.js'
import { ApiError } from './client.js'
import {
  CLI_VERSION,
  type Column,
  OUTPUT_SCHEMA_VERSION,
  emitError,
  emitObject,
  emitRecords,
  resolveMode,
} from './output.js'

const COLUMNS: Column[] = [
  { header: 'ID', get: (row) => String((row as { a: unknown }).a) },
  { header: 'NAME', get: (row) => String((row as { b: unknown }).b) },
]

describe('resolveMode', () => {
  it('is human at a terminal and json when piped', () => {
    expect(resolveMode({}, true)).toBe('human')
    expect(resolveMode({}, false)).toBe('json')
  })

  it('lets an explicit flag win over detection, both ways', () => {
    // Auto-detection is a known footgun — "works in my terminal, breaks in CI".
    // The override is what makes it safe to rely on, and the docs tell an agent
    // to pass --json rather than trust the default.
    expect(resolveMode({ json: true }, true)).toBe('json')
    expect(resolveMode({ human: true }, false)).toBe('human')
  })
})

describe('emitRecords', () => {
  it('writes one JSON object per line, and nothing else', () => {
    // NDJSON: it streams, it works with jq, and it matches the export
    // endpoint's existing format. No wrapper, no header, no summary line —
    // records are data.
    const out: string[] = []
    emitRecords([{ a: 1 }, { a: 2 }], 'json', COLUMNS, (s) => out.push(s))
    expect(out.join('')).toBe('{"a":1}\n{"a":2}\n')
  })

  it('renders a table with aligned columns for a terminal', () => {
    const out: string[] = []
    emitRecords(
      [
        { a: 1, b: 'x' },
        { a: 22, b: 'yy' },
      ],
      'human',
      COLUMNS,
      (s) => out.push(s),
    )
    expect(out.join('')).toBe('ID  NAME\n1   x\n22  yy\n')
  })

  it('prints nothing at all for an empty list in json mode', async () => {
    // An agent reading zero lines must not have to distinguish "no events"
    // from "a header with no rows".
    const out: string[] = []
    emitRecords([], 'json', COLUMNS, (s) => out.push(s))
    expect(out).toEqual([])
  })

  it('prints nothing at all for an empty list in human mode too', () => {
    // A deliberate choice, not an oversight: a header floating over zero
    // rows is exactly the kind of ambiguous "is this empty or is something
    // broken" output the json case above refuses to produce. Uniform "no
    // records, no output" in both modes means an agent piping the human
    // table through a script (against the docs' advice, but it happens)
    // sees the same "nothing" signal either way.
    const out: string[] = []
    emitRecords([], 'human', COLUMNS, (s) => out.push(s))
    expect(out).toEqual([])
  })

  it('json mode emits a record as given, even with keys the columns do not know about', () => {
    // Records are data — json mode is not allowed to filter them through
    // the display columns, or a caller relying on the documented contract
    // would silently lose fields no one told it to expect.
    const out: string[] = []
    emitRecords([{ a: 1, extra: 'untouched', nested: { x: 1 } }], 'json', COLUMNS, (s) =>
      out.push(s),
    )
    expect(JSON.parse(out.join(''))).toEqual({ a: 1, extra: 'untouched', nested: { x: 1 } })
  })

  it('table mode shows only the configured columns, missing fields included', () => {
    const out: string[] = []
    emitRecords([{ a: 1, extra: 'ignored-in-table' }], 'human', COLUMNS, (s) => out.push(s))
    const text = out.join('')
    expect(text).not.toContain('ignored-in-table')
    // 'b' is absent on the record; the column still renders without crashing.
    expect(text).toBe('ID  NAME\n1   undefined\n')
  })

  it('does not crash and keeps one line per row for non-object records', () => {
    // A Column.get written as `row.field` throws on a row that is not an
    // object at all (null, undefined, a bare number/string) — this must
    // not take the whole table down.
    const out: string[] = []
    emitRecords([undefined, null, 5, 'plain'], 'human', COLUMNS, (s) => out.push(s))
    const text = out.join('')
    expect(text.split('\n').filter(Boolean)).toHaveLength(5) // header + 4 rows
  })

  it('sanitises embedded newlines, carriage returns and tabs in a table cell', () => {
    const out: string[] = []
    emitRecords([{ a: 1, b: 'line1\nline2\ttabbed\r\nmore' }], 'human', COLUMNS, (s) => out.push(s))
    const text = out.join('')
    // Exactly one line per row (header + 1 data row) — no raw newline
    // smuggled in from the cell value split the row in two.
    expect(text.split('\n').filter(Boolean)).toHaveLength(2)
    expect(text).toContain('line1\\nline2\\ttabbed\\nmore')
  })

  it('renders numbers, booleans, null, undefined and unicode as safe table cells', () => {
    const rows = [
      { a: 1, b: 42 },
      { a: 2, b: true },
      { a: 3, b: null },
      { a: 4, b: undefined },
      { a: 5, b: 'héllo 世界 🎉' },
    ]
    const out: string[] = []
    emitRecords(rows, 'human', COLUMNS, (s) => out.push(s))
    const text = out.join('')
    expect(text.split('\n').filter(Boolean)).toHaveLength(1 + rows.length)
    expect(text).toContain('42')
    expect(text).toContain('true')
    expect(text).toContain('null')
    expect(text).toContain('héllo 世界 🎉')
  })

  it('keeps every json line independently parseable for non-string field values', () => {
    const rows = [
      { a: 1, b: 42 },
      { a: 2, b: true },
      { a: 3, b: null },
      { a: 4, b: undefined },
      { a: 5, b: { nested: 'x' } },
      { a: 6, b: 'quote " and tab\tand newline\nand unicode 世界' },
    ]
    const out: string[] = []
    emitRecords(rows, 'json', COLUMNS, (s) => out.push(s))
    const lines = out.join('').split('\n').filter(Boolean)
    expect(lines).toHaveLength(rows.length)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    // `undefined` fields are dropped by JSON.stringify, exactly like
    // JSON.stringify's own documented behaviour — not a bug this module
    // introduces.
    expect(JSON.parse(lines[3] as string)).toEqual({ a: 4 })
  })

  it('a whole record of undefined still writes one parseable json line, not the literal string "undefined"', () => {
    // JSON.stringify(undefined) returns the JS value undefined, not a
    // string — writing it unguarded would produce the four characters
    // "undefined", which is not valid JSON and breaks every downstream
    // parser on that line.
    const out: string[] = []
    emitRecords([undefined], 'json', COLUMNS, (s) => out.push(s))
    expect(JSON.parse(out.join(''))).toBeNull()
  })
})

describe('emitObject', () => {
  it('writes one json line for a record', () => {
    const out: string[] = []
    emitObject({ version: '0.1.0', output_schema: 1 }, 'json', (s) => out.push(s))
    expect(JSON.parse(out.join(''))).toEqual({ version: '0.1.0', output_schema: 1 })
  })

  it('writes every field on one human line', () => {
    const out: string[] = []
    emitObject({ version: '0.1.0', output_schema: 1 }, 'human', (s) => out.push(s))
    const text = out.join('')
    expect(text.split('\n').filter(Boolean)).toHaveLength(1)
    expect(text).toBe('version: 0.1.0  output_schema: 1\n')
  })

  it('does not crash on a non-object record in either mode', () => {
    const out: string[] = []
    emitObject('just a string', 'human', (s) => out.push(s))
    emitObject(42, 'json', (s) => out.push(s))
    expect(out.join('')).toBe('just a string\n42\n')
  })
})

describe('emitError', () => {
  it('writes a single json object with error and code', () => {
    const out: string[] = []
    emitError(new ApiError(401, 'invalid_server_key', 'the server key was rejected'), 'json', (s) =>
      out.push(s),
    )
    expect(JSON.parse(out.join(''))).toEqual({
      error: 'the server key was rejected',
      code: 'invalid_server_key',
    })
  })

  it('gives a UsageError a fixed code, since it carries none of its own', () => {
    const out: string[] = []
    emitError(new UsageError('not a duration: "5x"'), 'json', (s) => out.push(s))
    expect(JSON.parse(out.join(''))).toEqual({
      error: 'not a duration: "5x"',
      code: 'usage_error',
    })
  })

  it('renders a plain Error without status or code, without crashing', () => {
    const out: string[] = []
    emitError(new Error('boom'), 'json', (s) => out.push(s))
    expect(JSON.parse(out.join(''))).toEqual({ error: 'boom', code: 'error' })
  })

  it('renders a thrown string without crashing', () => {
    const out: string[] = []
    emitError('just a string', 'json', (s) => out.push(s))
    expect(JSON.parse(out.join(''))).toEqual({ error: 'just a string', code: 'error' })
  })

  it('renders a thrown plain object with no status/code at all, without crashing', () => {
    const out: string[] = []
    emitError({ oops: true }, 'json', (s) => out.push(s))
    const parsed = JSON.parse(out.join(''))
    expect(parsed.code).toBe('error')
    expect(typeof parsed.error).toBe('string')
  })

  it('renders a single human line too', () => {
    const out: string[] = []
    emitError(
      new ApiError(401, 'invalid_server_key', 'the server key was rejected'),
      'human',
      (s) => out.push(s),
    )
    const text = out.join('')
    expect(text.split('\n').filter(Boolean)).toHaveLength(1)
    expect(text).toBe('Error: the server key was rejected (invalid_server_key)\n')
  })
})

describe('CLI_VERSION', () => {
  it('matches packages/cli/package.json, so the reported contract cannot silently drift', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string }
    expect(CLI_VERSION).toBe(pkg.version)
  })
})

// Exercised so a consumer of this module can rely on the number staying
// put unless this test is deliberately updated alongside a documented
// change.
describe('OUTPUT_SCHEMA_VERSION', () => {
  it('is 1', () => {
    expect(OUTPUT_SCHEMA_VERSION).toBe(1)
  })
})
