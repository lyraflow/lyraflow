import { SNIPPET_METHODS, VERSION } from '@lyraflow/sdk-browser'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../client.js'
import type { Client } from '../client.js'
import type { CommandContext } from '../context.js'
import { runSnippet } from './snippet.js'

const NOW = new Date('2026-08-08T12:00:00.000Z')
const HOST = 'https://analytics.example.test'

interface FakeCall {
  method: 'get'
  path: string
  arg?: Record<string, string | number | undefined>
}

interface Responses {
  project?: unknown | Error
  schemaEvents?: unknown | Error
  stats?: unknown | Error
}

/**
 * Builds a fake `Client` that answers this command's three GET requests by
 * path — an `Error` value for any of them is thrown instead of returned,
 * the same convention `catalog.test.ts`'s own `makeClient` uses.
 */
function fakeGetClient(responses: Responses): Client {
  const client = {
    get: async (path: string) => {
      const value =
        path === '/v1/project'
          ? responses.project
          : path === '/v1/schema/events'
            ? responses.schemaEvents
            : path === '/v1/events/stats'
              ? responses.stats
              : undefined
      if (value instanceof Error) throw value
      return value
    },
  }
  return client as unknown as Client
}

const PROJECT = { name: 'Test Project', slug: 'test-project', write_key: 'wk_test_key' }

/**
 * `makeCtx` wraps a fake `Client` with call recording AND builds the
 * `CommandContext` in one step (unlike `catalog.test.ts`'s split
 * `makeClient`/`makeCtx`) — this file's own tests need `calls` alongside
 * `ctx`/`out`/`errOut` from a single call site.
 *
 * `isTty: true` by default, DELIBERATELY unlike every other command's own
 * test file (which default to `false`, i.e. JSON mode): this command's
 * whole point is a human-readable, paste-ready snippet plus a readable
 * events table, and several of this file's own assertions (a table row
 * matching `/legacy_event\s+0/`, a bare snippet's `"init"` appearing
 * unescaped) only hold against the HUMAN renderer — `JSON.stringify` would
 * escape the same quote to `\"`, which is not a substring of `"init"`.
 * `--json` is exercised explicitly, by name, in its own test below.
 */
function makeCtx(
  client: Client,
  overrides: Partial<CommandContext> = {},
): { ctx: CommandContext; out: string[]; errOut: string[]; calls: FakeCall[] } {
  const out: string[] = []
  const errOut: string[] = []
  const calls: FakeCall[] = []
  const tracked: Client = {
    get: async (path: string, query?: Record<string, string | number | undefined>) => {
      calls.push({ method: 'get', path, arg: query })
      return client.get(path, query)
    },
  } as unknown as Client
  return {
    ctx: {
      client: tracked,
      host: HOST,
      isTty: true,
      stdinIsTty: false,
      write: (s) => out.push(s),
      writeErr: (s) => errOut.push(s),
      now: () => NOW,
      sleep: () => Promise.resolve(),
      prompt: () => Promise.reject(new Error('runSnippet never prompts')),
      ...overrides,
    },
    out,
    errOut,
    calls,
  }
}

const SCHEMA_EVENTS_BASIC = {
  events: [{ event_name: 'page_view' }, { event_name: 'signup' }],
}

const STATS_BASIC = {
  buckets: [
    { bucket: '2026-08-02T00:00:00.000Z', event_name: 'signup', events: 100 },
    { bucket: '2026-08-06T00:00:00.000Z', event_name: 'signup', events: 143 },
    { bucket: '2026-08-02T00:00:00.000Z', event_name: 'page_view', events: 50 },
  ],
}

const fakeClient = fakeGetClient({
  project: PROJECT,
  schemaEvents: SCHEMA_EVENTS_BASIC,
  stats: STATS_BASIC,
})

const clientWithStaleEvent = fakeGetClient({
  project: PROJECT,
  schemaEvents: { events: [{ event_name: 'legacy_event' }, { event_name: 'signup' }] },
  stats: { buckets: [{ bucket: '2026-08-02T00:00:00.000Z', event_name: 'signup', events: 5 }] },
})

const clientWithNoEvents = fakeGetClient({
  project: PROJECT,
  schemaEvents: { events: [] },
  stats: { buckets: [] },
})

const clientRejecting401 = fakeGetClient({
  project: new ApiError(401, 'invalid_server_key', 'the server key was rejected'),
})

describe('runSnippet', () => {
  it('emits a snippet carrying the host and the write key', async () => {
    const { ctx, out } = makeCtx(fakeClient)
    expect(await runSnippet([], ctx)).toBe(0)
    const text = out.join('')
    expect(text).toContain('https://analytics.example.test')
    expect(text).toContain('wk_test_key')
  })

  it('prints the write key and never the server key', async () => {
    // THE exemption test, and both halves matter. The write key is public
    // by construction -- it ships in the browser bundle -- and printing it
    // is this command's entire job, so asserting it is PRESENT is what
    // stops a later redaction pass from silently emptying the snippet.
    //
    // There is no server key anywhere in this test's fixtures for
    // `runSnippet` to accidentally read (`CommandContext` carries no such
    // field, and `Client`'s own `#serverKey` is private) -- so this test
    // gives the fake `/v1/project` response an EXTRA field a real server
    // never sends, shaped like a secret. The only way it could leak is if
    // this command ever spread the raw response object into its output
    // instead of naming the fields it actually prints; that is the
    // regression this guards against.
    const SENTINEL = 'sk_SENTINEL_never_here'
    const client = fakeGetClient({
      project: { ...PROJECT, server_key_hash: SENTINEL },
      schemaEvents: { events: [] },
      stats: { buckets: [] },
    })
    const { ctx, out, errOut } = makeCtx(client)
    await runSnippet([], ctx)
    expect(out.join('')).toContain('wk_test_key')
    expect(out.join('') + errOut.join('')).not.toContain(SENTINEL)
  })

  it("builds the stub's method list from the SDK, not a local copy", async () => {
    const { ctx, out } = makeCtx(fakeClient)
    await runSnippet([], ctx)
    const text = out.join('')
    for (const m of SNIPPET_METHODS) expect(text).toContain(`"${m}"`)
  })

  it('lists recorded event names with their counts and names the window', async () => {
    const { ctx, out } = makeCtx(fakeClient)
    await runSnippet(['--since', '7d'], ctx)
    const text = out.join('')
    expect(text).toContain('signup')
    expect(text).toContain('243')
    expect(text).toContain('7d')
  })

  it('shows an event recorded historically but absent from the window, with a zero', async () => {
    // schema/events is all-time; the counts are windowed. An event that
    // fired once and stopped must still appear, because "it is not
    // arriving any more" is the single most useful thing this output can
    // tell someone.
    const { ctx, out } = makeCtx(clientWithStaleEvent)
    await runSnippet([], ctx)
    expect(out.join('')).toMatch(/legacy_event\s+0/)
  })

  it('succeeds with an empty list when nothing has been recorded yet', async () => {
    // The state every first-time user is in. Not an error.
    const { ctx, out } = makeCtx(clientWithNoEvents)
    expect(await runSnippet([], ctx)).toBe(0)
    expect(out.join('')).toContain('No events recorded yet')
  })

  it('emits the identical field set under --json', async () => {
    const { ctx, out } = makeCtx(fakeClient)
    await runSnippet(['--json'], ctx)
    const parsed = JSON.parse(out.join(''))
    expect(Object.keys(parsed).sort()).toEqual(
      ['events', 'host', 'methods', 'sdk_version', 'snippet', 'write_key'].sort(),
    )
    expect(parsed.sdk_version).toBe(VERSION)
    expect(parsed.write_key).toBe('wk_test_key')
    expect(parsed.host).toBe(HOST)
    expect(parsed.snippet).toContain('wk_test_key')
  })

  it('returns 1 when the project endpoint rejects the key', async () => {
    const { ctx, calls } = makeCtx(clientRejecting401)
    expect(await runSnippet([], ctx)).toBe(1)
    // The second and third requests never fire once the first has failed.
    expect(calls).toHaveLength(1)
  })

  it('returns 2 on an unexpected positional, naming no value', async () => {
    const SECRET = 'sk_SENTINEL_never_here'
    const { ctx, errOut, calls } = makeCtx(fakeClient)
    expect(await runSnippet([SECRET], ctx)).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain(SECRET)
  })

  it('rejects a bad --since without calling the API, and never echoes it', async () => {
    const { ctx, calls, errOut } = makeCtx(fakeClient)
    const code = await runSnippet(['--since', 'not-a-duration'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
    expect(errOut.join('')).not.toContain('not-a-duration')
  })

  it('rejects an unrecognised flag outright, without calling the API', async () => {
    const { ctx, calls } = makeCtx(fakeClient)
    const code = await runSnippet(['--members'], ctx)
    expect(code).toBe(2)
    expect(calls).toHaveLength(0)
  })

  // --- sentinel sweep -------------------------------------------------
  //
  // Copies the shape of `catalog.test.ts`'s own sweep, but DELIBERATELY
  // DIFFERS in what it asserts: every other command group's sweep checks
  // that NO key of any kind appears in output, because none of them ever
  // legitimately prints one. This command's entire job is to print the
  // WRITE key (`wk_test_key`, asserted present in several tests above) --
  // so this sweep only asserts that the SERVER key sentinel never appears,
  // never that all keys are absent.
  it('never leaks a server-key-shaped sentinel placed in ANY argv slot', async () => {
    const secret = 'sk_live_SENTINEL_never_here'
    const shapes: string[][] = [
      [secret],
      [`--server-key=${secret}`],
      ['--server-key', secret],
      ['--host', 'H', '--', secret],
      ['--host', 'H', '--', '--server-key', secret],
      ['a', secret],
      [secret, secret],
      [`--${secret}`],
      // `--since`'s own value: rejected by `resolveInstant` before any
      // request or render, same as the dedicated test above -- covered
      // here too since a sentinel is exactly the shape that check exists
      // to keep out of any message.
      ['--since', secret],
      [`--since=${secret}`],
    ]
    for (const argv of shapes) {
      const { ctx, out, errOut } = makeCtx(fakeClient)
      await runSnippet(argv, ctx)
      expect(out.join('') + errOut.join('')).not.toContain(secret)
    }
  })
})
