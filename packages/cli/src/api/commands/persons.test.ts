import { describe, expect, it, vi } from 'vitest'
import type { Client } from '../client.js'
import { ApiError } from '../client.js'
import type { CommandContext } from '../context.js'
import { runPersons } from './persons.js'

const NOW = new Date('2026-08-08T12:00:00.000Z')

interface FakeCall {
  method: 'get' | 'delete' | 'getLines'
  path: string
}

interface FakeClientOpts {
  get?: unknown | Error
  del?: unknown | Error
  lines?: string[] | Error
  /** Yields `lines` first, then throws `error` — the shape a mid-stream
   * connection failure produces (some lines already delivered, then the
   * body's own iterator throws). Distinct from `lines: Error`, which
   * throws immediately with nothing yielded first. */
  linesPartial?: { lines: string[]; error: Error }
}

function makeClient(opts: FakeClientOpts): { client: Client; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const client = {
    get: async (path: string) => {
      calls.push({ method: 'get', path })
      if (opts.get instanceof Error) throw opts.get
      return opts.get
    },
    delete: async (path: string) => {
      calls.push({ method: 'delete', path })
      if (opts.del instanceof Error) throw opts.del
      return opts.del
    },
    getLines: async function* (path: string) {
      calls.push({ method: 'getLines', path })
      if (opts.linesPartial) {
        for (const line of opts.linesPartial.lines) yield line
        throw opts.linesPartial.error
      }
      if (opts.lines instanceof Error) throw opts.lines
      for (const line of opts.lines ?? []) yield line
    },
  }
  return { client: client as unknown as Client, calls }
}

function epipe(): Error {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
}

function makeCtx(
  client: Client,
  overrides: Partial<CommandContext> = {},
): { ctx: CommandContext; out: string[]; errOut: string[] } {
  const out: string[] = []
  const errOut: string[] = []
  return {
    ctx: {
      client,
      isTty: false,
      stdinIsTty: false,
      write: (s) => out.push(s),
      writeErr: (s) => errOut.push(s),
      now: () => NOW,
      sleep: () => Promise.resolve(),
      prompt: () => Promise.reject(new Error('this test did not expect a prompt')),
      ...overrides,
    },
    out,
    errOut,
  }
}

function parseJsonLines(lines: string[]): Record<string, unknown>[] {
  return lines
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const PERSON_RECORD = {
  person_id: 'p1',
  ids: ['user-42', 'anon-1'],
  first_seen: '2026-08-01T00:00:00.000Z',
  last_seen: '2026-08-08T11:00:00.000Z',
  events: 12,
}

describe('runPersons > get', () => {
  it("prints a person's profile", async () => {
    const { client, calls } = makeClient({ get: PERSON_RECORD })
    const { ctx, out } = makeCtx(client)
    const code = await runPersons(['get', 'user-42'], ctx)
    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'get', path: '/v1/persons/user-42' }])
    expect(parseJsonLines(out)).toEqual([PERSON_RECORD])
  })

  it('URL-encodes the id in the request path', async () => {
    const { client, calls } = makeClient({ get: PERSON_RECORD })
    const { ctx } = makeCtx(client)
    await runPersons(['get', 'a/b c'], ctx)
    expect(calls[0]?.path).toBe('/v1/persons/a%2Fb%20c')
  })

  it('a 404 from the API is exit 1, not a crash', async () => {
    const { client } = makeClient({ get: new ApiError(404, 'person_not_found', 'not found') })
    const { ctx, errOut } = makeCtx(client)
    const code = await runPersons(['get', 'nobody'], ctx)
    expect(code).toBe(1)
    expect(parseJsonLines(errOut)[0]?.code).toBe('person_not_found')
  })

  it('requires an id', async () => {
    const { client, calls } = makeClient({})
    const { ctx } = makeCtx(client)
    const code = await runPersons(['get'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('treats an EPIPE on write as a clean stop (exit 0)', async () => {
    const { client } = makeClient({ get: PERSON_RECORD })
    const { ctx } = makeCtx(client, {
      write: () => {
        throw epipe()
      },
    })
    const code = await runPersons(['get', 'user-42'], ctx)
    expect(code).toBe(0)
  })

  it('rejects a flag belonging to a sibling subcommand (--yes is delete-only)', async () => {
    const { client, calls } = makeClient({ get: PERSON_RECORD })
    const { ctx } = makeCtx(client)
    const code = await runPersons(['get', 'user-42', '--yes'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })
})

describe('runPersons > export', () => {
  const PERSON_LINE = '{"type":"person","person_id":"p1"}'
  const EVENT_LINE = '{"type":"event","event_id":"e1"}'
  const END_LINE = '{"type":"end","events":1}'

  it("passes the export's NDJSON through unchanged, terminator included", async () => {
    const { client, calls } = makeClient({ lines: [PERSON_LINE, EVENT_LINE, END_LINE] })
    const { ctx, out } = makeCtx(client)
    const code = await runPersons(['export', 'user-42'], ctx)
    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'getLines', path: '/v1/persons/user-42/export' }])
    // Byte-exact: exactly the three lines, each re-terminated with a single
    // `\n`, nothing added, nothing re-wrapped, nothing re-parsed.
    expect(out.join('')).toBe(`${PERSON_LINE}\n${EVENT_LINE}\n${END_LINE}\n`)
  })

  it('does not re-wrap the export in a JSON array or any other shape', async () => {
    const { client } = makeClient({ lines: [PERSON_LINE, END_LINE] })
    const { ctx, out } = makeCtx(client)
    await runPersons(['export', 'user-42'], ctx)
    const text = out.join('')
    expect(text.startsWith('[')).toBe(false)
    expect(text).not.toContain('[{')
  })

  it('exits 1 and warns on stderr when the stream ends without the end line — but still writes what it received', async () => {
    const { client } = makeClient({ lines: [PERSON_LINE, EVENT_LINE] })
    const { ctx, out, errOut } = makeCtx(client)
    const code = await runPersons(['export', 'user-42'], ctx)
    expect(code).toBe(1)
    expect(out.join('')).toBe(`${PERSON_LINE}\n${EVENT_LINE}\n`)
    expect(parseJsonLines(errOut)[0]?.error).toMatch(/incomplete/)
    // A distinguishable code — not the generic 'error' every other
    // unexpected failure gets — so a caller can tell "incomplete but real
    // data" apart from any other failure shape without string-matching.
    expect(parseJsonLines(errOut)[0]?.code).toBe('export_incomplete')
  })

  it('exits 0 with no stderr warning when the end line is present', async () => {
    const { client } = makeClient({ lines: [PERSON_LINE, END_LINE] })
    const { ctx, errOut } = makeCtx(client)
    const code = await runPersons(['export', 'user-42'], ctx)
    expect(code).toBe(0)
    expect(errOut).toHaveLength(0)
  })

  it('does not report success just because the LAST line happens to be a non-terminator (sawEnd is not sticky)', async () => {
    // A malformed/unreachable-against-the-real-server shape, but the
    // module's own guarantee is "the last line was the terminator", not
    // "an end line appeared somewhere" — this pins that the stronger
    // reading is what's actually implemented.
    const { client } = makeClient({ lines: [END_LINE, EVENT_LINE] })
    const { ctx } = makeCtx(client)
    const code = await runPersons(['export', 'user-42'], ctx)
    expect(code).toBe(1)
  })

  it('treats a write EPIPE as a clean stop (exit 0), matching events/stats', async () => {
    const { client } = makeClient({ lines: [PERSON_LINE, EVENT_LINE, END_LINE] })
    const { ctx } = makeCtx(client, {
      write: () => {
        throw epipe()
      },
    })
    const code = await runPersons(['export', 'user-42'], ctx)
    expect(code).toBe(0)
  })

  it('a write error that is not EPIPE still propagates', async () => {
    const { client } = makeClient({ lines: [PERSON_LINE] })
    const boom = new Error('disk full')
    const { ctx } = makeCtx(client, {
      write: () => {
        throw boom
      },
    })
    await expect(runPersons(['export', 'user-42'], ctx)).rejects.toBe(boom)
  })

  it('an ApiError from the export route (e.g. 404) is exit 1', async () => {
    const { client } = makeClient({
      lines: new ApiError(404, 'person_not_found', 'not found'),
    })
    const { ctx } = makeCtx(client)
    const code = await runPersons(['export', 'nobody'], ctx)
    expect(code).toBe(1)
  })

  it('an ApiError raised mid-stream (a real connection failure, per Client#getLines) is exit 1 with the already-received lines written', async () => {
    const { client } = makeClient({
      linesPartial: {
        lines: [PERSON_LINE],
        error: new ApiError(200, 'stream_interrupted', 'the response stream ended unexpectedly'),
      },
    })
    const { ctx, out, errOut } = makeCtx(client)
    const code = await runPersons(['export', 'user-42'], ctx)
    expect(code).toBe(1)
    expect(out.join('')).toBe(`${PERSON_LINE}\n`)
    expect(parseJsonLines(errOut)[0]?.code).toBe('stream_interrupted')
  })

  it('rejects a flag belonging to a sibling subcommand (--yes is delete-only)', async () => {
    const { client, calls } = makeClient({ lines: [PERSON_LINE, END_LINE] })
    const { ctx } = makeCtx(client)
    const code = await runPersons(['export', 'user-42', '--yes'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })
})

describe('runPersons > delete', () => {
  const DELETE_RESPONSE = {
    request_id: 7,
    person_id: 'p1',
    suppressed_at: '2026-08-08T12:00:00.000Z',
  }

  it('prompts before deleting when stdin is a terminal', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx } = makeCtx(client, { stdinIsTty: true, prompt: async () => false })
    const code = await runPersons(['delete', 'user-42'], ctx)
    expect(code).toBe(1)
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0)
  })

  it('requires --yes when stdin is not a terminal, and says so — naming --yes, not just a bare code', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx, errOut } = makeCtx(client, { stdinIsTty: false })
    const code = await runPersons(['delete', 'user-42'], ctx)
    expect(code).toBe(2)
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0)
    expect(errOut.join('')).toContain('--yes')
  })

  it('a stdout TTY alone does NOT skip --yes — only stdin matters (the pty hang this fix closes)', async () => {
    // The exact shape a pty-allocated agent harness produces: stdout looks
    // like a terminal, stdin does not (or is not answerable). Keying the
    // requirement on stdout (isTty) would have wrongly skipped --yes here.
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx } = makeCtx(client, { isTty: true, stdinIsTty: false })
    const code = await runPersons(['delete', 'user-42'], ctx)
    expect(code).toBe(2)
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0)
  })

  it('deletes with --yes and prints the request id', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx, out } = makeCtx(client)
    const code = await runPersons(['delete', 'user-42', '--yes'], ctx)
    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'delete', path: '/v1/persons/user-42' }])
    expect(parseJsonLines(out)).toEqual([DELETE_RESPONSE])
  })

  it('deletes when the prompt is accepted at a terminal', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx } = makeCtx(client, { stdinIsTty: true, prompt: async () => true })
    const code = await runPersons(['delete', 'user-42'], ctx)
    expect(code).toBe(0)
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(1)
  })

  it('rejects a prompt resolving a truthy non-boolean — confirmed must be === true, not merely truthy', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    // @ts-expect-error deliberately violating prompt's boolean contract,
    // the way a hostile or buggy caller-supplied implementation could.
    const { ctx } = makeCtx(client, { stdinIsTty: true, prompt: async () => 'yes' })
    const code = await runPersons(['delete', 'user-42'], ctx)
    expect(code).toBe(1)
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0)
  })

  it('--yes skips the prompt even at a terminal', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const promptSpy = vi.fn(async () => false)
    const { ctx } = makeCtx(client, { stdinIsTty: true, prompt: promptSpy })
    const code = await runPersons(['delete', 'user-42', '--yes'], ctx)
    expect(code).toBe(0)
    expect(promptSpy).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(1)
  })

  it('a rejected prompt is treated as a safe decline, not an unhandled rejection', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx, errOut } = makeCtx(client, {
      stdinIsTty: true,
      prompt: () => Promise.reject(new Error('readline exploded')),
    })
    const code = await runPersons(['delete', 'user-42'], ctx)
    expect(code).toBe(1)
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0)
    expect(parseJsonLines(errOut)[0]?.error).toMatch(/prompt failed/)
  })

  it('an ApiError from the delete route (e.g. 404) is exit 1', async () => {
    const { client } = makeClient({ del: new ApiError(404, 'person_not_found', 'not found') })
    const { ctx } = makeCtx(client)
    const code = await runPersons(['delete', 'nobody', '--yes'], ctx)
    expect(code).toBe(1)
  })

  it('treats an EPIPE on write as a clean stop (exit 0) on the successful-delete path', async () => {
    const { client } = makeClient({ del: DELETE_RESPONSE })
    const { ctx } = makeCtx(client, {
      write: () => {
        throw epipe()
      },
    })
    const code = await runPersons(['delete', 'user-42', '--yes'], ctx)
    expect(code).toBe(0)
  })

  it('never puts the raw id into the confirmation prompt text', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client } = makeClient({ del: DELETE_RESPONSE })
    let question = ''
    const { ctx } = makeCtx(client, {
      stdinIsTty: true,
      prompt: async (q) => {
        question = q
        return false
      },
    })
    await runPersons(['delete', SECRET], ctx)
    expect(question).not.toContain(SECRET)
  })

  it('never puts the raw id into the "declined" message on stderr', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client } = makeClient({ del: DELETE_RESPONSE })
    const { ctx, errOut } = makeCtx(client, { stdinIsTty: true, prompt: async () => false })
    await runPersons(['delete', SECRET], ctx)
    expect(errOut.join('')).not.toContain(SECRET)
  })

  it('never puts the raw id into the "--yes required" message on stderr', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client } = makeClient({ del: DELETE_RESPONSE })
    const { ctx, errOut } = makeCtx(client, { stdinIsTty: false })
    await runPersons(['delete', SECRET], ctx)
    expect(errOut.join('')).not.toContain(SECRET)
  })

  it('URL-encodes the id in the delete request path', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx } = makeCtx(client)
    await runPersons(['delete', 'a/b c', '--yes'], ctx)
    expect(calls[0]?.path).toBe('/v1/persons/a%2Fb%20c')
  })
})

describe('runPersons > usage', () => {
  it('rejects a missing subcommand', async () => {
    const { client, calls } = makeClient({})
    const { ctx } = makeCtx(client)
    const code = await runPersons([], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  it('rejects an unknown subcommand without echoing it', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client, calls } = makeClient({})
    const { ctx, errOut } = makeCtx(client)
    const code = await runPersons([SECRET, 'user-42'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(SECRET)
  })

  it('rejects an unexpected extra positional without echoing it', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client, calls } = makeClient({ get: PERSON_RECORD })
    const { ctx, errOut } = makeCtx(client)
    const code = await runPersons(['get', 'user-42', SECRET], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(SECRET)
  })

  it('a --json that did parse still wins even when an unrelated flag makes the parse fail', async () => {
    const { client } = makeClient({})
    const { ctx, errOut } = makeCtx(client)
    const code = await runPersons(['get', 'user-42', '--json', '--nope'], ctx)
    expect(code).toBe(2)
    expect(() => JSON.parse(errOut.join(''))).not.toThrow()
  })

  // --- the generalised sweep: a secret placed in ANY argv slot, across
  // every subcommand this command group has, must never appear anywhere
  // in stdout or stderr — on any code path. Modelled on events.test.ts's
  // own ten-slot sweep, plus the `--<secret>`-as-an-unrecognised-flag
  // shape Task 8's review found is NOT covered by that precedent either
  // (a leak in node:util's own parseArgs error message, closed in args.ts).

  it('never leaks a sentinel secret placed in ANY argv slot, across get/export/delete', async () => {
    const secret = 'sk_live_SENTINEL_never_here'
    const shapes: string[][] = [
      [secret], // bare positional, unknown subcommand
      ['get', secret], // used as the id — a legitimate slot, sent to the
      // fake client, which never echoes it back (per PERSON_RECORD's fixed
      // shape) — pinning that the CLI's OWN messages don't leak it either
      ['get', 'user-42', secret], // extra positional after the id
      [`--server-key=${secret}`, 'get', 'user-42'], // --flag=value
      ['--server-key', secret, 'get', 'user-42'], // flag's own separate value
      ['--host', 'H', '--', secret], // past a `--` terminator
      ['--host', 'H', '--', '--server-key', secret], // past --, flag-shaped positional + value
      ['get', 'user-42', 'a', secret], // not first, not last
      [secret, secret], // repeated
      [`--${secret}`, 'get', 'user-42'], // secret AS an unrecognised flag name
      ['delete', secret], // the irreversible command's own id slot too
    ]

    for (const argv of shapes) {
      const { client } = makeClient({ get: PERSON_RECORD, del: { request_id: 1 } })
      const { ctx, out, errOut } = makeCtx(client, { stdinIsTty: false })
      await runPersons(argv, ctx)
      expect(out.join('')).not.toContain(secret)
      expect(errOut.join('')).not.toContain(secret)
    }
  })
})
