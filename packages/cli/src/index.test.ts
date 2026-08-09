import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { Client } from './api/client.js'
import { CLI_VERSION, OUTPUT_SCHEMA_VERSION } from './api/output.js'
import { type CommandContext, createPrompt, extractOverride, runVersion } from './index.js'

// `runVersion` itself only ever touches `write`/`isTty` — the rest of
// `CommandContext` exists for Task 7's `events`/`stats`, but the interface
// is shared, so a test context still has to satisfy all of it. `client` is
// never called here, so an unused fake stands in rather than a real one.
function makeCtx(isTty: boolean): { ctx: CommandContext; out: string[] } {
  const out: string[] = []
  return {
    ctx: {
      client: {} as Client,
      write: (s) => out.push(s),
      writeErr: () => {
        throw new Error('runVersion should never write to stderr')
      },
      isTty,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
      sleep: () => Promise.resolve(),
      prompt: () => Promise.reject(new Error('runVersion should never prompt')),
    },
    out,
  }
}

describe('runVersion', () => {
  it('reports both versions under --json', async () => {
    // An agent checks what it is talking to before trusting field names. The CLI
    // version moves with every release; the schema version moves only when a
    // documented JSON field changes shape or meaning, which is the one an agent
    // actually needs.
    const { ctx, out } = makeCtx(true)
    await runVersion(['--json'], ctx)
    expect(JSON.parse(out.join(''))).toEqual({
      version: CLI_VERSION,
      output_schema: OUTPUT_SCHEMA_VERSION,
    })
  })

  it('also reports both versions under --json when not at a terminal', async () => {
    const { ctx, out } = makeCtx(false)
    await runVersion(['--json'], ctx)
    expect(JSON.parse(out.join(''))).toEqual({
      version: CLI_VERSION,
      output_schema: OUTPUT_SCHEMA_VERSION,
    })
  })

  it('prints both in one human line at a terminal', async () => {
    const { ctx, out } = makeCtx(true)
    await runVersion([], ctx)
    const text = out.join('')
    expect(text.split('\n').filter(Boolean)).toHaveLength(1)
    expect(text).toBe(`version: ${CLI_VERSION}  output_schema: ${OUTPUT_SCHEMA_VERSION}\n`)
  })

  it('an explicit --human wins even when not at a terminal', async () => {
    const { ctx, out } = makeCtx(false)
    await runVersion(['--human'], ctx)
    const text = out.join('')
    expect(text).toBe(`version: ${CLI_VERSION}  output_schema: ${OUTPUT_SCHEMA_VERSION}\n`)
  })
})

describe('extractOverride', () => {
  it('reads --flag value form', () => {
    expect(extractOverride(['--host', 'https://a.test'], 'host')).toBe('https://a.test')
  })

  it('reads --flag=value form', () => {
    expect(extractOverride(['--host=https://a.test'], 'host')).toBe('https://a.test')
  })

  it("extracts a literal empty string for --host= — it is main()'s `||`, not this function, that treats that as absent", () => {
    // This function is a faithful extraction, nothing more: `--host=`
    // really was passed with an empty value, so it returns `''`. The env
    // fallback for that case lives in main() (`host || process.env...`,
    // not `??`) precisely because this function does not — and must not —
    // guess that an empty string means "try somewhere else".
    expect(extractOverride(['--host='], 'host')).toBe('')
  })

  it('stops scanning at a bare `--`, agreeing with the strict parser about what is a flag', () => {
    // `events --host H -- --server-key K`: after `--`, `--server-key` is a
    // positional to the strict command-level parser, not the real
    // override. This scanner must agree, or the two layers see different
    // things for the identical argv.
    expect(
      extractOverride(['--host', 'H', '--', '--server-key', 'K'], 'server-key'),
    ).toBeUndefined()
    expect(extractOverride(['--host', 'H', '--', '--server-key', 'K'], 'host')).toBe('H')
  })

  it('keeps the last occurrence of a repeated flag, the same convention parseCommandArgs uses', () => {
    expect(extractOverride(['--host', 'first', '--host', 'second'], 'host')).toBe('second')
  })
})

describe('createPrompt', () => {
  // The one property `persons delete`'s safety design actually rests on:
  // an irreversible operation must never hang waiting for an answer nobody
  // is going to give it. Both "the stream ends outright" (piped from
  // /dev/null) and "the stream ends after the user typed something but
  // never pressed enter" (Ctrl+D on a partial/empty line at a real
  // terminal) close the input stream without ever emitting a 'line' event
  // — both must resolve `false`, not hang.

  it('resolves false, not hang, when the input stream ends with no answer at all', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const prompt = createPrompt(input, output)
    const result = prompt('Continue?')
    input.end()
    await expect(result).resolves.toBe(false)
  })

  it('resolves false, not hang, when the input stream ends mid-line (no newline ever sent)', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const prompt = createPrompt(input, output)
    const result = prompt('Continue?')
    input.write('y')
    input.end()
    await expect(result).resolves.toBe(false)
  })

  it('resolves true for "y" and "yes", case-insensitively, once a real line arrives', async () => {
    for (const answer of ['y', 'Y', 'yes', 'YES']) {
      const input = new PassThrough()
      const output = new PassThrough()
      const prompt = createPrompt(input, output)
      const result = prompt('Continue?')
      input.write(`${answer}\n`)
      await expect(result).resolves.toBe(true)
    }
  })

  it('resolves false for anything else, including empty input followed by enter', async () => {
    for (const answer of ['n', 'no', '', 'sure']) {
      const input = new PassThrough()
      const output = new PassThrough()
      const prompt = createPrompt(input, output)
      const result = prompt('Continue?')
      input.write(`${answer}\n`)
      await expect(result).resolves.toBe(false)
    }
  })

  it('writes the question to the output stream, not swallowed silently', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let written = ''
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString()
    })
    const prompt = createPrompt(input, output)
    const result = prompt('Really delete this?')
    input.write('n\n')
    await result
    expect(written).toContain('Really delete this?')
  })
})
