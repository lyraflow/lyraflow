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
  })

  it('exits 0 with no stderr warning when the end line is present', async () => {
    const { client } = makeClient({ lines: [PERSON_LINE, END_LINE] })
    const { ctx, errOut } = makeCtx(client)
    const code = await runPersons(['export', 'user-42'], ctx)
    expect(code).toBe(0)
    expect(errOut).toHaveLength(0)
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
})

describe('runPersons > delete', () => {
  const DELETE_RESPONSE = {
    request_id: 7,
    person_id: 'p1',
    suppressed_at: '2026-08-08T12:00:00.000Z',
  }

  it('prompts before deleting when stdout is a terminal', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx } = makeCtx(client, { isTty: true, prompt: async () => false })
    const code = await runPersons(['delete', 'user-42'], ctx)
    expect(code).toBe(1)
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0)
  })

  it('requires --yes when not a terminal, and says so', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx } = makeCtx(client, { isTty: false })
    const code = await runPersons(['delete', 'user-42'], ctx)
    expect(code).toBe(2)
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(0)
  })

  it('deletes with --yes and prints the request id', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx, out } = makeCtx(client, { isTty: false })
    const code = await runPersons(['delete', 'user-42', '--yes'], ctx)
    expect(code).toBe(0)
    expect(calls).toEqual([{ method: 'delete', path: '/v1/persons/user-42' }])
    expect(parseJsonLines(out)).toEqual([DELETE_RESPONSE])
  })

  it('deletes when the prompt is accepted at a terminal', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx } = makeCtx(client, { isTty: true, prompt: async () => true })
    const code = await runPersons(['delete', 'user-42'], ctx)
    expect(code).toBe(0)
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(1)
  })

  it('--yes skips the prompt even at a terminal', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const promptSpy = vi.fn(async () => false)
    const { ctx } = makeCtx(client, { isTty: true, prompt: promptSpy })
    const code = await runPersons(['delete', 'user-42', '--yes'], ctx)
    expect(code).toBe(0)
    expect(promptSpy).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.method === 'delete')).toHaveLength(1)
  })

  it('an ApiError from the delete route (e.g. 404) is exit 1', async () => {
    const { client } = makeClient({ del: new ApiError(404, 'person_not_found', 'not found') })
    const { ctx } = makeCtx(client, { isTty: false })
    const code = await runPersons(['delete', 'nobody', '--yes'], ctx)
    expect(code).toBe(1)
  })

  it('never puts the raw id into the confirmation prompt text', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client } = makeClient({ del: DELETE_RESPONSE })
    let question = ''
    const { ctx } = makeCtx(client, {
      isTty: true,
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
    const { ctx, errOut } = makeCtx(client, { isTty: true, prompt: async () => false })
    await runPersons(['delete', SECRET], ctx)
    expect(errOut.join('')).not.toContain(SECRET)
  })

  it('never puts the raw id into the "--yes required" message on stderr', async () => {
    const SECRET = 'sk_live_do_not_leak_me'
    const { client } = makeClient({ del: DELETE_RESPONSE })
    const { ctx, errOut } = makeCtx(client, { isTty: false })
    await runPersons(['delete', SECRET], ctx)
    expect(errOut.join('')).not.toContain(SECRET)
  })

  it('URL-encodes the id in the delete request path', async () => {
    const { client, calls } = makeClient({ del: DELETE_RESPONSE })
    const { ctx } = makeCtx(client, { isTty: false })
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
})
