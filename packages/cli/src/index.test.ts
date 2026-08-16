import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import type { Client } from './api/client.js'
import { CLI_VERSION, OUTPUT_SCHEMA_VERSION } from './api/output.js'
import {
  type CommandContext,
  createPrompt,
  extractOverride,
  hostFromDomain,
  resolveHost,
  runVersion,
} from './index.js'

// `runVersion` itself only ever touches `write`/`isTty` — the rest of
// `CommandContext` exists for Task 7's `events`/`stats`, but the interface
// is shared, so a test context still has to satisfy all of it. `client` is
// never called here, so an unused fake stands in rather than a real one.
function makeCtx(isTty: boolean): { ctx: CommandContext; out: string[]; errOut: string[] } {
  const out: string[] = []
  const errOut: string[] = []
  return {
    ctx: {
      client: {} as Client,
      write: (s) => out.push(s),
      // Was `throw new Error('runVersion should never write to stderr')`.
      // It never did — because it had no parse-failure path at all, which
      // was the bug: an unrecognised flag escaped as a raw UsageError with
      // a stack trace and exit 1, where the contract says 2 and JSON under
      // --json. Collected rather than forbidden now; the success-path tests
      // below assert it stays empty for them specifically.
      writeErr: (s) => errOut.push(s),
      isTty,
      stdinIsTty: false,
      now: () => new Date('2026-08-08T12:00:00.000Z'),
      sleep: () => Promise.resolve(),
      prompt: () => Promise.reject(new Error('runVersion should never prompt')),
    },
    out,
    errOut,
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

  it('returns 0 and writes nothing to stderr on the ordinary path', async () => {
    // The other half of loosening makeCtx's writeErr from "throw" to
    // "collect": without this, that loosening would silently remove a real
    // assertion the success-path tests used to make for free.
    const { ctx, errOut } = makeCtx(true)
    expect(await runVersion(['--json'], ctx)).toBe(0)
    expect(errOut).toEqual([])
  })

  it('reports an unrecognised flag as a usage error instead of throwing, honouring --json', async () => {
    // This is the command the README tells an agent to run FIRST, to read
    // output_schema before trusting any field name — and it was the one
    // command with no parse-failure handling at all. All six command groups
    // wrap parseCommandArgs in try/catch → reportParseFailure; runVersion
    // came from Task 6, reportParseFailure was extracted in Task 7, and
    // nobody went back. `lyraflow --version --unknown-flag` printed a raw
    // UsageError stack trace and exited 1.
    const { ctx, out, errOut } = makeCtx(true)
    expect(await runVersion(['--json', '--unknown-flag'], ctx)).toBe(2)
    expect(out).toEqual([])
    const parsed = JSON.parse(errOut.join('')) as { error: string; code: string }
    expect(parsed.code).toBe('usage_error')
    // Renders as JSON because a --json that DID parse still wins over isTty
    // (true here) — the same rule reportParseFailure gives every other
    // command.
    expect(parsed.error).toMatch(/unrecognised option/)
  })

  it('rejects --host here rather than silently ignoring it, and says so as a usage error', async () => {
    // --host is accepted by all six other commands, so an operator reaching
    // for it here is likely. This command talks to nothing, so accepting
    // and ignoring it would be the silently-vanishing-flag failure
    // checkStrayFlags exists to prevent. Exit 2, not a stack trace.
    const { ctx, errOut } = makeCtx(false)
    expect(await runVersion(['--host', 'http://example.test'], ctx)).toBe(2)
    expect(JSON.parse(errOut.join('')).code).toBe('usage_error')
  })

  it('never echoes an unrecognised flag’s own text, even here', async () => {
    // The same sweep every other command group has. `--<secret>` reaches
    // node:util's ERR_PARSE_ARGS_UNKNOWN_OPTION, which bakes the raw token
    // into its message twice; args.ts rebuilds the message from an index
    // instead, and this pins that runVersion gets that for free now that it
    // routes through the same path.
    const secret = 'sk_live_SENTINEL_never_here'
    for (const argv of [[`--${secret}`], ['--json', `--${secret}`], [secret]]) {
      const { ctx, out, errOut } = makeCtx(false)
      await runVersion(argv, ctx)
      expect(out.join('')).not.toContain(secret)
      expect(errOut.join('')).not.toContain(secret)
    }
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

describe('hostFromDomain', () => {
  it('prepends https:// to a bare domain', () => {
    expect(hostFromDomain('analytics.example.com')).toBe('https://analytics.example.com')
  })

  it('preserves a trailing slash — downstream URL parsing normalises it the same way it would for an explicit --host', () => {
    expect(hostFromDomain('analytics.example.com/')).toBe('https://analytics.example.com/')
  })

  it('trims surrounding whitespace before deciding anything else', () => {
    expect(hostFromDomain('  analytics.example.com  ')).toBe('https://analytics.example.com')
  })

  it('returns a value that already carries a scheme AS IS, instead of double-prepending', () => {
    // Naive `https://${domain}` concatenation here would silently build
    // `https://https://analytics.example.com`, whose `.origin` resolves to
    // the wrong-but-parseable `https://https` — a quiet bad default, the
    // exact failure mode #61 was filed to close.
    expect(hostFromDomain('https://analytics.example.com')).toBe('https://analytics.example.com')
    expect(hostFromDomain('http://analytics.example.com')).toBe('http://analytics.example.com')
  })

  it('trims whitespace before the scheme check too', () => {
    expect(hostFromDomain('  https://analytics.example.com  ')).toBe(
      'https://analytics.example.com',
    )
  })
})

describe('resolveHost', () => {
  it('an explicit --host wins over LYRAFLOW_HOST and LYRAFLOW_DOMAIN, for snippet', () => {
    expect(
      resolveHost('snippet', ['--host', 'https://flag.test'], {
        LYRAFLOW_HOST: 'https://env-host.test',
        LYRAFLOW_DOMAIN: 'env-domain.test',
      }),
    ).toBe('https://flag.test')
  })

  it('LYRAFLOW_HOST wins over LYRAFLOW_DOMAIN when --host is absent, and matches passing that same value via --host explicitly', () => {
    const viaEnv = resolveHost('snippet', [], {
      LYRAFLOW_HOST: 'https://env-host.test',
      LYRAFLOW_DOMAIN: 'env-domain.test',
    })
    const viaFlag = resolveHost('snippet', ['--host', 'https://env-host.test'], {})
    expect(viaEnv).toBe('https://env-host.test')
    expect(viaEnv).toBe(viaFlag)
  })

  it('falls back to LYRAFLOW_DOMAIN, derived through hostFromDomain, when neither --host nor LYRAFLOW_HOST is set — snippet only', () => {
    expect(resolveHost('snippet', [], { LYRAFLOW_DOMAIN: 'analytics.example.com' })).toBe(
      'https://analytics.example.com',
    )
  })

  it('never consults LYRAFLOW_DOMAIN for any command other than snippet', () => {
    // The other seven commands sharing this dispatch branch only ever need a
    // host that answers a request — #61 asked for this fallback on
    // `snippet` alone, where a wrong scheme is the mixed-content failure the
    // issue describes.
    for (const command of [
      'events',
      'stats',
      'persons',
      'deletions',
      'segments',
      'funnels',
      'schema',
    ]) {
      expect(resolveHost(command, [], { LYRAFLOW_DOMAIN: 'analytics.example.com' })).toBeUndefined()
    }
  })

  it('returns undefined with none of the three set, for snippet — todays "must be set" usage error is unchanged', () => {
    expect(resolveHost('snippet', [], {})).toBeUndefined()
  })

  it('an explicit but empty --host= falls through to LYRAFLOW_HOST, same as before this change', () => {
    expect(resolveHost('snippet', ['--host='], { LYRAFLOW_HOST: 'https://env-host.test' })).toBe(
      'https://env-host.test',
    )
  })

  it('an empty LYRAFLOW_HOST falls through to LYRAFLOW_DOMAIN, for snippet', () => {
    expect(
      resolveHost('snippet', [], { LYRAFLOW_HOST: '', LYRAFLOW_DOMAIN: 'analytics.example.com' }),
    ).toBe('https://analytics.example.com')
  })

  it.each([
    ['a trailing slash', 'analytics.example.com/'],
    ['a scheme already present', 'https://analytics.example.com'],
    ['surrounding whitespace', '  analytics.example.com  '],
  ])(
    'LYRAFLOW_DOMAIN set to an odd value (%s) behaves the same as passing the derived value to --host directly',
    (_label, domain) => {
      const derived = hostFromDomain(domain)
      const viaDomain = resolveHost('snippet', [], { LYRAFLOW_DOMAIN: domain })
      const viaFlag = resolveHost('snippet', ['--host', derived], {})
      expect(viaDomain).toBe(derived)
      expect(viaDomain).toBe(viaFlag)
    },
  )
})

describe('createPrompt', () => {
  // The one property `persons delete`'s safety design actually rests on:
  // an irreversible operation must never hang waiting for an answer nobody
  // is going to give it. A review round found "the input stream closed" —
  // the only ending the first version handled — is one of FOUR distinct
  // ways an answer never arrives, proven against a real pty: a clean
  // `end()`, `destroy()` with no error (never reaches `'end'` at all,
  // so `rl`'s own `'close'` never fires either), `destroy(err)` (which
  // ALSO must not become an unhandled `'error'`-event crash), and input
  // that simply never produces anything, ever — closed only by a bounded
  // timeout, since no stream event can ever announce "nothing is
  // happening".

  it('resolves false, not hang, when the input stream ends with no answer at all (end())', async () => {
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

  it('resolves false, not hang, when the input stream is destroyed with no error — never reaches "end", so rl\'s own "close" never fires', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const prompt = createPrompt(input, output)
    const result = prompt('Continue?')
    input.destroy()
    await expect(result).resolves.toBe(false)
  })

  it('resolves false, not hang, when the input stream is destroyed WITH an error — and the error does not crash the process', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const prompt = createPrompt(input, output)
    const result = prompt('Continue?')
    // If this listener were the only thing standing between this and an
    // unhandled 'error' event, the test process itself would crash before
    // the assertion below ever ran — the absence of a crash IS part of
    // what this test proves, not just the resolved value.
    input.destroy(new Error('stream boom'))
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

  // --- the fourth ending: input that simply never says anything, ever ---
  // The shape a `stdinIsTty: true` check alone cannot rule out (a pty
  // allocated but nothing typed into it) — the bounded timeout is the
  // backstop of last resort for exactly this case. Uses a short overridden
  // `timeoutMs` rather than the real two-minute `PROMPT_TIMEOUT_MS`.

  it('resolves false after the timeout when the input never produces anything at all', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const prompt = createPrompt(input, output, 20)
    const result = prompt('Continue?')
    await expect(result).resolves.toBe(false)
  })

  it('writes an explicit "no reply" message to output when the timeout fires — distinct from a real decline', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    let written = ''
    output.on('data', (chunk: Buffer) => {
      written += chunk.toString()
    })
    const prompt = createPrompt(input, output, 20)
    await prompt('Continue?')
    expect(written).toMatch(/no reply/i)
  })

  it('an answer arriving before the timeout still wins — the timeout is a backstop, not a race it competes to lose', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    // A generous timeout relative to how fast the answer arrives below —
    // if the timeout fired first this would resolve false, not true.
    const prompt = createPrompt(input, output, 60_000)
    const result = prompt('Continue?')
    input.write('y\n')
    await expect(result).resolves.toBe(true)
  })
})
