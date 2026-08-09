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

  it('prefers json when both --json and --human are passed', () => {
    // Pinned, not incidental: a script that asked for --json and gets a
    // table back breaks silently, while a human who asked for --human and
    // gets JSON back still gets something readable. json is the safer
    // default for an ambiguous request.
    expect(resolveMode({ json: true, human: true }, true)).toBe('json')
    expect(resolveMode({ json: true, human: true }, false)).toBe('json')
  })
})

describe('emitRecords', () => {
  it('refuses a missing or non-array collection as an ApiError, in both modes, instead of crashing', () => {
    // THE CONTAINER, not its contents. Every other guard in this module —
    // toCell, safeGet, safeJsonLine, describeUnknown — protects against
    // hostile values INSIDE `records`, and every test in this file passed
    // an array, so `records.length` (the function's FIRST statement) was an
    // unguarded property read on caller-supplied data in the module whose
    // docstring promises it never crashes. A 2xx body of `{}` made all five
    // list commands die with `TypeError: Cannot read properties of
    // undefined (reading 'length')`.
    //
    // ApiError specifically, not a new class: every command already routes
    // its catch through reportCommandFailure, which renders an ApiError as
    // {error, code} with exit 1 and RETHROWS anything else — so a bespoke
    // class would have crashed in exactly the same way it was meant to
    // prevent.
    for (const mode of ['json', 'human'] as const) {
      for (const bad of [undefined, null, {}, 'hello', 42]) {
        const out: string[] = []
        let thrown: unknown
        try {
          emitRecords(bad as unknown as unknown[], mode, COLUMNS, (s) => out.push(s))
        } catch (err) {
          thrown = err
        }
        expect(thrown, `${mode} / ${String(bad)}`).toBeInstanceOf(ApiError)
        expect((thrown as ApiError).code).toBe('invalid_response_shape')
        // Nothing may reach stdout: a half-written table or a stray record
        // line would corrupt the stream the caller is parsing.
        expect(out).toEqual([])
      }
    }
  })

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

  it('a record containing a BigInt degrades to one honest, parseable line instead of crashing', () => {
    // JSON.stringify throws TypeError: Do not know how to serialize a
    // BigInt. Not reachable through Task 4's client today (res.json() never
    // produces one), but ClickHouse counts can exceed
    // Number.MAX_SAFE_INTEGER, so a future direct caller is plausible — and
    // NDJSON's whole value is reading it line by line, so one bad record
    // must still be exactly one line, never zero and never an exception
    // that aborts every record after it.
    const out: string[] = []
    emitRecords([{ a: 1 }, { a: 2, b: 9_007_199_254_740_993n }, { a: 3 }], 'json', COLUMNS, (s) =>
      out.push(s),
    )
    const lines = out.join('').split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    expect(JSON.parse(lines[0] as string)).toEqual({ a: 1 })
    expect(JSON.parse(lines[2] as string)).toEqual({ a: 3 })
    const failed = JSON.parse(lines[1] as string)
    expect(failed.error).toBe('this record could not be serialised as JSON')
    expect(typeof failed.detail).toBe('string')
  })

  it('degrades a record whose toJSON throws a poisoned non-Error to one honest line, without crashing', () => {
    // Round 1's fix wrapped JSON.stringify itself but left the recovery's
    // own stringification unguarded: `err instanceof Error ? err.message :
    // String(err)` calls String(err) bare when the thrown value is not an
    // Error — and a toJSON can throw anything, not just an Error. If that
    // thrown value's own toString() also throws, the "recovery" crashes.
    const evil = {
      toJSON() {
        throw {
          toString() {
            throw new Error('nested poison boom')
          },
        }
      },
    }
    const out: string[] = []
    expect(() =>
      emitRecords([{ a: 1 }, { a: 2, b: evil }, { a: 3 }], 'json', COLUMNS, (s) => out.push(s)),
    ).not.toThrow()
    const lines = out.join('').split('\n').filter(Boolean)
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    const failed = JSON.parse(lines[1] as string)
    expect(failed.error).toBe('this record could not be serialised as JSON')
    expect(typeof failed.detail).toBe('string')
  })

  it('degrades a poisoned Error subclass (throwing toJSON, throwing toString) to one honest line', () => {
    // Invented beyond the reviewer's named case: the thrown value here IS
    // an Error subclass (so a naive `err instanceof Error ? err.message :
    // …` guard would look safe) but its own toString() is itself poisoned,
    // and `.message` is never read on this path (describeUnknown always
    // uses String(), not `.message`) — confirms the fix doesn't depend on
    // the thrown value's shape at all.
    class PoisonedError extends Error {
      override toString(): string {
        throw new Error('poisoned Error toString')
      }
    }
    const evil = {
      toJSON() {
        throw new PoisonedError('evil toJSON')
      },
    }
    const out: string[] = []
    expect(() => emitRecords([evil], 'json', COLUMNS, (s) => out.push(s))).not.toThrow()
    const lines = out.join('').split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    const failed = JSON.parse(lines[0] as string)
    expect(failed.error).toBe('this record could not be serialised as JSON')
    expect(typeof failed.detail).toBe('string')
  })

  it('a write callback that throws still propagates through emitRecords', () => {
    // The same "what did the fix break" check as emitError's: safeJsonLine
    // computes the line before write() is called, and write() itself is
    // never wrapped — a throwing write must still reach the caller.
    const boom = new Error('write boom')
    expect(() =>
      emitRecords([{ a: 1 }], 'json', COLUMNS, () => {
        throw boom
      }),
    ).toThrow(boom)
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
    // Still true, and deliberately kept: a string or a number is a value,
    // badly shaped but present, and this module's job is to render it
    // rather than take the process down. Only "no record at all" is
    // refused — see the test below.
    const out: string[] = []
    emitObject('just a string', 'human', (s) => out.push(s))
    emitObject(42, 'json', (s) => out.push(s))
    expect(out.join('')).toBe('just a string\n42\n')
  })

  it('refuses null/undefined as an ApiError rather than printing the word "null" and reporting success', () => {
    // The `emitObject` half of the wrong-shaped-body Critical. `persons
    // get`, `persons delete`, `deletions get` and `segments run` all hand
    // a 2xx body straight to this function; a body of `null` used to print
    // the literal `null` and exit 0, which tells an agent the record it
    // asked for exists and is empty. It does not — the request failed and
    // was answered with a 200.
    for (const mode of ['json', 'human'] as const) {
      for (const bad of [null, undefined]) {
        const out: string[] = []
        let thrown: unknown
        try {
          emitObject(bad, mode, (s) => out.push(s))
        } catch (err) {
          thrown = err
        }
        expect(thrown, `${mode} / ${String(bad)}`).toBeInstanceOf(ApiError)
        expect((thrown as ApiError).code).toBe('invalid_response_shape')
        expect(out).toEqual([])
      }
    }
  })

  it('does not crash rendering a human-mode field whose stringification is fully poisoned', () => {
    // toCell (also used by emitRecords' table rendering, via safeGet) has
    // the identical shape of bug the reviewer found in safeJsonLine: its
    // own catch block used to call bare String(value). A field whose
    // JSON.stringify throws AND whose String() also throws used to defeat
    // both layers of the old implementation at once.
    const evil = {
      toJSON() {
        throw new Error('toJSON boom')
      },
      toString() {
        throw new Error('toString boom too')
      },
    }
    const out: string[] = []
    expect(() => emitObject({ a: evil }, 'human', (s) => out.push(s))).not.toThrow()
    expect(out.join('')).toContain('a: <unrenderable value>')
  })

  it('a record containing a BigInt degrades to one honest, parseable line instead of crashing', () => {
    const out: string[] = []
    emitObject({ version: '0.1.0', huge: 9_007_199_254_740_993n }, 'json', (s) => out.push(s))
    expect(out).toHaveLength(1)
    const parsed = JSON.parse(out.join(''))
    expect(parsed.error).toBe('this record could not be serialised as JSON')
    expect(typeof parsed.detail).toBe('string')
  })

  it('a write callback that throws still propagates through emitObject', () => {
    const boom = new Error('write boom')
    expect(() =>
      emitObject({ a: 1 }, 'json', () => {
        throw boom
      }),
    ).toThrow(boom)
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

  it('does not crash on a value whose toString() itself throws', () => {
    // describeError's fallback for a non-Error, non-ApiError, non-UsageError
    // value calls String(err), which invokes the value's own toString()
    // unguarded unless this is caught. An error handler that itself throws
    // hides the original failure — the worst possible place for a crash.
    const evil = {
      toString() {
        throw new Error('toString boom')
      },
    }
    const out: string[] = []
    expect(() => emitError(evil, 'json', (s) => out.push(s))).not.toThrow()
    const parsed = JSON.parse(out.join(''))
    expect(parsed.code).toBe('error')
    expect(typeof parsed.error).toBe('string')
  })

  it('does not crash on a value whose Symbol.toPrimitive itself throws', () => {
    const evil = {
      [Symbol.toPrimitive]() {
        throw new Error('toPrimitive boom')
      },
    }
    const out: string[] = []
    expect(() => emitError(evil, 'json', (s) => out.push(s))).not.toThrow()
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

  it('does not crash on a value whose own prototype chain cannot be walked (a poisoned Proxy)', () => {
    // describeError's `instanceof` checks run before any of its own
    // fallback guards — `instanceof` invokes Symbol.hasInstance, which
    // walks the value's prototype chain via getPrototypeOf. A Proxy whose
    // getPrototypeOf trap throws makes `err instanceof ApiError` itself
    // throw, on the very first line of describeError, before safeDescribe
    // (round 1's guard) is ever reached.
    const evil = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('getPrototypeOf trap boom')
        },
      },
    )
    const out: string[] = []
    expect(() => emitError(evil, 'json', (s) => out.push(s))).not.toThrow()
    const parsed = JSON.parse(out.join(''))
    expect(parsed.code).toBe('error')
    expect(typeof parsed.error).toBe('string')
  })

  it('does not crash on a Proxy whose every trap throws', () => {
    // Invented beyond the reviewer's named case: a Proxy poisoned across
    // has/get/ownKeys/getOwnPropertyDescriptor too, not just
    // getPrototypeOf, to confirm the outer catch is a genuine backstop
    // rather than one that happens to cover exactly the traps tested so far.
    const boom = () => {
      throw new Error('trap boom')
    }
    const evil = new Proxy(
      {},
      {
        getPrototypeOf: boom,
        has: boom,
        get: boom,
        ownKeys: boom,
        getOwnPropertyDescriptor: boom,
      },
    )
    const out: string[] = []
    expect(() => emitError(evil, 'json', (s) => out.push(s))).not.toThrow()
    expect(() => emitError(evil, 'human', (s) => out.push(s))).not.toThrow()
    const lines = out.join('').split('\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    const parsed = JSON.parse(lines[0] as string)
    expect(parsed.code).toBe('error')
  })

  it('a write callback that throws still propagates — the outer guard must not swallow it', () => {
    // The specific way an outermost catch can be wrong: if it wrapped the
    // write() call too, a real, actionable failure (a closed stdout, a
    // broken pipe) would vanish into the same bland fallback as a poisoned
    // input. emitError computes the line first and calls write() outside
    // any try, so a throwing write must still reach the caller unchanged.
    const boom = new Error('write boom')
    expect(() =>
      emitError(new Error('irrelevant'), 'json', () => {
        throw boom
      }),
    ).toThrow(boom)
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

describe('the table path survives a first-party bug', () => {
  const throwingHeader: Column = {
    get header(): string {
      throw new Error('header getter boom')
    },
    get: (row: never) => String((row as { a: unknown }).a),
  }

  it('renders a table whose Column.header getter throws', () => {
    // A Column is CLI-authored, so a throwing header means a bug in a command
    // definition -- exactly when the table must still render enough to read
    // the bug from, rather than taking the process down while reporting it.
    // col.get already had this protection via safeGet; col.header did not.
    const out: string[] = []
    expect(() =>
      emitRecords([{ a: 1 }], 'human', [throwingHeader], (s) => out.push(s)),
    ).not.toThrow()
    expect(out.join('')).toBe('\n1\n')
  })

  it('renders an object in human mode whose ownKeys trap throws', () => {
    // json mode is already immune to this via safeJsonLine. A fallback format
    // that survives less than the format it backs up is the wrong way round.
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('ownKeys trap boom')
        },
      },
    )
    const out: string[] = []
    expect(() => emitObject(hostile, 'human', (s) => out.push(s))).not.toThrow()
    expect(out).toHaveLength(1)
    expect(out[0]?.endsWith('\n')).toBe(true)
  })
})
