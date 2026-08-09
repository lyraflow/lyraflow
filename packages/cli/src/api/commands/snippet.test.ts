import { SNIPPET_METHODS, VERSION } from '@lyraflow/sdk-browser'
import { describe, expect, it } from 'vitest'
import { ApiError, Client } from '../client.js'
import type { CommandContext } from '../context.js'
import { SCHEMA_MAX_LIMIT } from './catalog.js'
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
 * `--json` is exercised explicitly, by name, in its own tests below.
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

/**
 * Structural parse of the snippet's own script elements — used to prove
 * the write-key encoding is actually load-bearing (an injected value that
 * breaks it produces a DIFFERENT element count and a syntax error, not
 * merely "the sentinel string is absent somewhere in the blob").
 */
function extractScriptBodies(html: string): string[] {
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g
  const bodies: string[] = []
  let m = re.exec(html)
  while (m !== null) {
    bodies.push(m[1] ?? '')
    m = re.exec(html)
  }
  return bodies
}

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

  it('prints the write key and never the server key, in --json too', async () => {
    // The human-mode version above and the sentinel sweep below both ran
    // exclusively in human mode (this file's own default) -- a review
    // finding on this exact command: leaking the raw `/v1/project`
    // response inside the `events` key of the JSON output would pass
    // every other test unchanged, since the top-level key set is
    // untouched. Forces `--json` explicitly to close that gap.
    const SENTINEL = 'sk_SENTINEL_never_here_json'
    const client = fakeGetClient({
      project: { ...PROJECT, server_key_hash: SENTINEL },
      schemaEvents: { events: [] },
      stats: { buckets: [] },
    })
    const { ctx, out, errOut } = makeCtx(client)
    await runSnippet(['--json'], ctx)
    const text = out.join('') + errOut.join('')
    expect(text).toContain('wk_test_key')
    expect(text).not.toContain(SENTINEL)
  })

  it("builds the stub's method list from the SDK, not a local copy", async () => {
    const { ctx, out } = makeCtx(fakeClient)
    await runSnippet([], ctx)
    const text = out.join('')
    for (const m of SNIPPET_METHODS) expect(text).toContain(`"${m}"`)
  })

  it('pins --json methods to the exact SNIPPET_METHODS array, not a superset or subset', async () => {
    const { ctx, out } = makeCtx(fakeClient)
    await runSnippet(['--json'], ctx)
    const parsed = JSON.parse(out.join(''))
    expect(parsed.methods).toEqual([...SNIPPET_METHODS])
  })

  it('lists recorded event names with their counts and names the window', async () => {
    const { ctx, out } = makeCtx(fakeClient)
    await runSnippet(['--since', '7d'], ctx)
    const text = out.join('')
    expect(text).toContain('signup')
    expect(text).toContain('243')
    // The RESOLVED window, not the raw flag value — see below for why the
    // raw value cannot be in this sentence.
    expect(text).toContain('Event counts for 2026-08-01T12:00:00.000Z to 2026-08-08T12:00:00.000Z')
  })

  it('names the window the same way for an ISO --since as for a duration', async () => {
    // The sentence used to read `Event counts since ${sinceRaw} ago`, and
    // `resolveInstant` (args.ts) accepts an absolute ISO instant as readily
    // as a duration — so this exact invocation printed "Event counts since
    // 2026-01-01T00:00:00.000Z ago", which is not a thing. args.ts had
    // already reasoned its way to the same rule for its own messages: a
    // flag value does not belong in output. The resolved window says what
    // was asked, in one form for both spellings.
    const { ctx, out } = makeCtx(fakeClient)
    expect(await runSnippet(['--since', '2026-01-01T00:00:00.000Z'], ctx)).toBe(0)
    const text = out.join('')
    expect(text).not.toContain('ago')
    expect(text).toContain('Event counts for 2026-01-01T00:00:00.000Z to 2026-08-08T12:00:00.000Z')
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
    expect(parsed.events.counts).toEqual([
      { event_name: 'page_view', count: 50 },
      { event_name: 'signup', count: 243 },
    ])
    expect(parsed.events.truncated).toBe(false)
  })

  it('emits the identical snippet string in both modes, not merely one that contains the write key', async () => {
    // The brief's own test title was "emits the identical snippet string
    // under --json" -- the weaker "contains wk_test_key" check a
    // prefixed-but-otherwise-diverged snippet (e.g. an injected HTML
    // comment) would still pass. This compares the exact strings.
    const { ctx: humanCtx, out: humanOut } = makeCtx(fakeClient, { isTty: true })
    await runSnippet([], humanCtx)
    // `renderHuman` joins [snippet, '', ...eventsLines] with '\n' -- the
    // snippet itself contains no blank line, so splitting on the first
    // '\n\n' recovers exactly the snippet text with nothing else attached.
    const humanSnippet = humanOut.join('').split('\n\n')[0]

    const { ctx: jsonCtx, out: jsonOut } = makeCtx(fakeClient, { isTty: false })
    await runSnippet(['--json'], jsonCtx)
    const parsed = JSON.parse(jsonOut.join(''))

    expect(parsed.snippet).toBe(humanSnippet)
    expect(parsed.snippet).toContain('wk_test_key')
  })

  it('embeds the identical host in BOTH substitution sites (src and init)', async () => {
    // A wrong host in only one of the two sites (the bundle loads from the
    // right place, but every event goes to someone else's server, or vice
    // versa) is the failure mode a single "does the text contain HOST
    // somewhere" assertion cannot catch.
    const { ctx, out } = makeCtx(fakeClient)
    await runSnippet([], ctx)
    const text = out.join('')
    expect(text).toContain(`src="${HOST}/lyraflow.js"`)
    expect(text).toContain(`host: "${HOST}"`)
  })

  describe('write key encoding', () => {
    // The write key comes straight from `GET /v1/project`'s response body
    // — server-supplied, and unlike `host` it is NEVER normalised (there
    // is no "origin" to reduce it to). `jsStringLiteral`'s `</` guard is
    // LOAD-BEARING here, not belt-and-suspenders: without it, a write key
    // shaped like this closes the inline `<script>` element early and
    // whatever follows is parsed and executed as real markup on every page
    // that pastes the snippet.
    const INJECTED_KEY = 'wk_"+alert(1)+"</script><script>alert(2)</script>'

    it('keeps the snippet at exactly three script elements, each parseable, with the key round-tripping exactly', async () => {
      const client = fakeGetClient({
        project: { ...PROJECT, write_key: INJECTED_KEY },
        schemaEvents: { events: [] },
        stats: { buckets: [] },
      })
      const { ctx, out } = makeCtx(client)
      const code = await runSnippet([], ctx)
      expect(code).toBe(0)
      const text = out.join('')

      const bodies = extractScriptBodies(text)
      expect(bodies).toHaveLength(3)
      for (const body of bodies) {
        expect(() => new Function(body)).not.toThrow()
      }

      // Not just "does not crash" -- the init() block's own `writeKey`
      // literal must decode to EXACTLY the original injected value.
      const initBody = bodies[2] ?? ''
      const literalMatch = /writeKey:\s*("(?:[^"\\]|\\.)*")/.exec(initBody)
      expect(literalMatch).not.toBeNull()
      const undoScriptGuard = (literalMatch?.[1] ?? '').replace(/<\\\//g, '</')
      expect(JSON.parse(undoScriptGuard)).toBe(INJECTED_KEY)
    })
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

  // --- host normalisation (the branch's Critical) ------------------------
  //
  // `Client` dials via `new URL(path, host)`, which normalises; the
  // snippet's own template used to interpolate `host` raw into an HTML
  // attribute and a JS string literal. Every case below exited 0 and
  // produced broken or dangerous output before this fix.

  describe('host normalisation', () => {
    it('strips a trailing slash — the shape a real person actually hits', async () => {
      const { ctx, out } = makeCtx(fakeClient, { host: `${HOST}/` })
      const code = await runSnippet([], ctx)
      expect(code).toBe(0)
      const text = out.join('')
      expect(text).toContain(`src="${HOST}/lyraflow.js"`)
      expect(text).not.toContain(`${HOST}//lyraflow.js`)
    })

    it("normalizes a trailing slash in --json's host field too", async () => {
      const { ctx, out } = makeCtx(fakeClient, { host: `${HOST}/` })
      await runSnippet(['--json'], ctx)
      const parsed = JSON.parse(out.join(''))
      expect(parsed.host).toBe(HOST)
    })

    it('an unparseable host fails through the ordinary invalid_url path (exit 1), the same as every other command', async () => {
      // A REAL `Client`, not the fake — this is specifically about parity
      // with `Client`'s own `#buildUrl` failure, which a fake client
      // cannot exercise at all (it never parses `host` as a URL in the
      // first place). A first cut of this fix ran `normalizeHost` BEFORE
      // any request and reported it as a usage error — exit 2,
      // `usage_error` — while every other command in this CLI (and this
      // command itself, before that fix) reaches `Client`'s own
      // `invalid_url` and exits 1 for the identical bad host. Fixed by
      // deferring `normalizeHost` until after `GET /v1/project` has
      // already parsed the same string successfully — a bad host now
      // fails AT that request, through the exact same code path.
      const realClient = new Client({ host: 'not a url at all', serverKey: 'sk_test' })
      const { ctx, out, errOut } = makeCtx(realClient, { host: 'not a url at all' })
      const code = await runSnippet(['--json'], ctx)
      expect(code).toBe(1)
      const text = out.join('') + errOut.join('')
      const parsed = JSON.parse(text.trim())
      expect(parsed.code).toBe('invalid_url')
      expect(parsed.error).toBe(
        'the configured host is not a usable base URL (--host, or LYRAFLOW_HOST)',
      )
    })

    const MALICIOUS_PATH_SHAPES: { label: string; raw: string; forbidden: string[] }[] = [
      { label: 'a quote', raw: `${HOST}/x'y`, forbidden: [`${HOST}/x'y`, "x'y'"] },
      {
        label: 'a script-closing tag',
        raw: `${HOST}/</script><script>alert(1)</script>`,
        forbidden: ['</script><script>alert(1)</script>', 'alert(1)'],
      },
      { label: 'a backslash', raw: `${HOST}/a\\b`, forbidden: ['a\\b'] },
    ]
    for (const { label, raw, forbidden } of MALICIOUS_PATH_SHAPES) {
      it(`normalizes a host carrying ${label} — the path is discarded entirely, exit 0`, async () => {
        const { ctx, out } = makeCtx(fakeClient, { host: raw })
        const code = await runSnippet([], ctx)
        expect(code).toBe(0)
        const text = out.join('')
        for (const f of forbidden) expect(text).not.toContain(f)
        // Still a working, correctly-hosted snippet -- normalisation
        // degrades to the clean origin, not to a broken or empty one.
        expect(text).toContain(`src="${HOST}/lyraflow.js"`)
        expect(text).toContain(`host: "${HOST}"`)
      })
    }

    // --- what did the fix break? -----------------------------------------
    //
    // Host normalisation changes every request this command makes, not
    // just the printed string -- these confirm a host that worked before
    // still works after.

    it('still works with a host that carries a port', async () => {
      const { ctx, out } = makeCtx(fakeClient, { host: 'http://127.0.0.1:4600' })
      const code = await runSnippet([], ctx)
      expect(code).toBe(0)
      expect(out.join('')).toContain('src="http://127.0.0.1:4600/lyraflow.js"')
    })

    it('still works with a host configured with a path prefix the client already ignored', async () => {
      // `Client` resolves every request path via `new URL(path, host)`;
      // every path this CLI ever sends is absolute ("/v1/..."), and per URL
      // resolution rules that discards the base's own path entirely -- a
      // path in `--host`/`LYRAFLOW_HOST` has never affected a single real
      // request, in any command, before or after this fix. This proves the
      // snippet's own host now visibly matches that pre-existing behaviour.
      const { ctx, out } = makeCtx(fakeClient, { host: `${HOST}/some/sub/path` })
      const code = await runSnippet([], ctx)
      expect(code).toBe(0)
      expect(out.join('')).toContain(`src="${HOST}/lyraflow.js"`)
    })

    it('still works over plain http, not just https', async () => {
      const { ctx, out } = makeCtx(fakeClient, { host: 'http://localhost:3000' })
      const code = await runSnippet([], ctx)
      expect(code).toBe(0)
      expect(out.join('')).toContain('src="http://localhost:3000/lyraflow.js"')
    })
  })

  // --- truncation ("every event name ever recorded" is not always true) --

  describe('schema/events truncation', () => {
    it('flags a truncated event list when schema/events returns exactly the page ceiling, in both modes', async () => {
      const manyEvents = Array.from({ length: SCHEMA_MAX_LIMIT }, (_, i) => ({
        event_name: `event_${i}`,
      }))
      const client = fakeGetClient({
        project: PROJECT,
        schemaEvents: { events: manyEvents },
        stats: { buckets: [] },
      })

      const { ctx: jsonCtx, out: jsonOut } = makeCtx(client)
      await runSnippet(['--json'], jsonCtx)
      expect(JSON.parse(jsonOut.join('')).events.truncated).toBe(true)

      const { ctx: humanCtx, out: humanOut } = makeCtx(client)
      await runSnippet([], humanCtx)
      // Hedged, not asserted as fact: `truncated` is a heuristic (the
      // list came back exactly at the page ceiling), and a project with
      // EXACTLY that many names would otherwise get a false claim.
      expect(humanOut.join('')).toContain('this project may have more than that')
      expect(humanOut.join('')).not.toContain('has more than that')
    })

    it('does not flag truncation when the list is under the ceiling', async () => {
      const { ctx, out } = makeCtx(fakeClient)
      await runSnippet(['--json'], ctx)
      expect(JSON.parse(out.join('')).events.truncated).toBe(false)
    })
  })

  // --- event name union: schema/events alone is not enough ---------------
  //
  // `event_schema` (schema/events' source) is fed by a materialized view
  // keyed on `mapKeys(properties)`/`mapKeys(properties_num)` (002_events.sql)
  // -- an event that has NEVER carried a property produces ZERO rows there,
  // no matter how many times it fired. `lyraflow.track('signup')` with no
  // second argument -- the single most common first call anyone makes -- is
  // exactly this shape. Before this section's fix, a project in exactly that
  // state got "No events recorded yet." on a genuinely working install,
  // because the event list came from schema/events alone. `events/stats`
  // aggregates the raw `events` table directly, so it sees a property-less
  // event fine as long as it fired inside the window -- these tests pin the
  // UNION of the two sources, not schema/events' list alone.

  describe('event name union — a name absent from schema/events can still surface', () => {
    it('includes a name events/stats reports but schema/events has never seen, with its real count', async () => {
      const client = fakeGetClient({
        project: PROJECT,
        // `raw_signup` never appears here -- the fixture for "this event has
        // never carried a property".
        schemaEvents: { events: [{ event_name: 'page_view' }] },
        stats: {
          buckets: [
            { bucket: '2026-08-08T00:00:00.000Z', event_name: 'raw_signup', events: 4 },
            { bucket: '2026-08-08T00:00:00.000Z', event_name: 'page_view', events: 1 },
          ],
        },
      })
      const { ctx, out } = makeCtx(client)
      const code = await runSnippet(['--json'], ctx)
      expect(code).toBe(0)
      const parsed = JSON.parse(out.join(''))
      expect(parsed.events.counts).toEqual([
        { event_name: 'page_view', count: 1 },
        { event_name: 'raw_signup', count: 4 },
      ])
    })

    it('renders a property-less-only event in human mode too, instead of "No events recorded yet"', async () => {
      const client = fakeGetClient({
        project: PROJECT,
        schemaEvents: { events: [] },
        stats: {
          buckets: [{ bucket: '2026-08-08T00:00:00.000Z', event_name: 'raw_signup', events: 1 }],
        },
      })
      const { ctx, out } = makeCtx(client)
      const code = await runSnippet([], ctx)
      expect(code).toBe(0)
      const text = out.join('')
      expect(text).not.toContain('No events recorded yet')
      expect(text).toMatch(/raw_signup\s+1/)
    })

    it('does not double-count a name present in both sources', async () => {
      const client = fakeGetClient({
        project: PROJECT,
        schemaEvents: { events: [{ event_name: 'signup' }] },
        stats: {
          buckets: [
            { bucket: '2026-08-08T00:00:00.000Z', event_name: 'signup', events: 3 },
            { bucket: '2026-08-09T00:00:00.000Z', event_name: 'signup', events: 2 },
          ],
        },
      })
      const { ctx, out } = makeCtx(client)
      await runSnippet(['--json'], ctx)
      const parsed = JSON.parse(out.join(''))
      expect(parsed.events.counts).toEqual([{ event_name: 'signup', count: 5 }])
    })

    it('sorts the merged list alphabetically regardless of which source a name came from', async () => {
      // A name schema/events never saw (so it can only enter via the union)
      // sorts BEFORE a name schema/events did see -- if the merge just
      // appended stats-only names after schema's own list, this would come
      // out schema-order-then-stats-order instead of one alphabetical list.
      const client = fakeGetClient({
        project: PROJECT,
        schemaEvents: { events: [{ event_name: 'zzz_from_schema' }] },
        stats: {
          buckets: [
            { bucket: '2026-08-08T00:00:00.000Z', event_name: 'aaa_from_stats', events: 2 },
          ],
        },
      })
      const { ctx, out } = makeCtx(client)
      await runSnippet(['--json'], ctx)
      const parsed = JSON.parse(out.join(''))
      expect(parsed.events.counts.map((c: { event_name: string }) => c.event_name)).toEqual([
        'aaa_from_stats',
        'zzz_from_schema',
      ])
    })
  })

  // --- informational requests degrade instead of failing the command -----

  describe('a hostile event name cannot drive the terminal or rewrite the snippet', () => {
    // The Critical the whole-branch review found. `event_name` is not this
    // CLI's text: it reaches the server through `/v1/track`, whose write
    // key ships inside the browser bundle of every instrumented page, and
    // whose validation bounds only LENGTH (`z.string().min(1).max(128)`,
    // packages/core/src/ingest/payloads.ts) — no character class. So any
    // visitor to the customer's site chooses these bytes.
    //
    // Each payload below is under 128 characters, i.e. actually sendable.
    const CURSOR_ATTACK =
      '\u001b[6A\u001b[2K<script async src="https://evil.test/l.js"></script>\u001b[6B'
    const NEWLINE_FORGERY = 'zz_nl\n  wk_FORGED_KEY_LOOKS_REAL  999'
    const CARRIAGE_RETURN = 'zz_cr\rwk_OVERWRITTEN'

    function clientWithName(name: string): Client {
      return fakeGetClient({
        project: PROJECT,
        schemaEvents: { events: [{ event_name: 'aaa_normal' }, { event_name: name }] },
        stats: {
          buckets: [
            { bucket: '2026-08-02T00:00:00.000Z', event_name: 'aaa_normal', events: 7 },
            { bucket: '2026-08-02T00:00:00.000Z', event_name: name, events: 999 },
          ],
        },
      })
    }

    for (const [label, name] of [
      ['an ESC-driven cursor attack', CURSOR_ATTACK],
      ['a bare newline', NEWLINE_FORGERY],
      ['a bare carriage return', CARRIAGE_RETURN],
    ] as const) {
      it(`keeps one row per event, with alignment intact, for ${label}`, async () => {
        const { ctx, out } = makeCtx(clientWithName(name))
        expect(await runSnippet([], ctx)).toBe(0)
        const text = out.join('')

        // 1. Nothing the terminal will OBEY. Not "this particular escape is
        //    gone" — no control character at all survives into the table.
        //    (The snippet above the table has real newlines, by design, so
        //    this checks the table region only.)
        const table = text.slice(text.indexOf('A zero count means'))
        // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence is the point.
        expect(table).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)

        // 2. One row per event, not three: a forged row is exactly what a
        //    raw newline buys, and it is indistinguishable from a real one.
        const rows = table.split('\n').filter((l) => l.startsWith('  '))
        expect(rows).toHaveLength(2)

        // 3. Alignment survives — the escaped form is what occupies
        //    columns, so the count column still lines up. Measuring the RAW
        //    name would put these two counts at different offsets.
        const offsets = rows.map((r) => r.lastIndexOf('  '))
        expect(offsets[0]).toBe(offsets[1])

        // 4. And the snippet itself is untouched: the bundle-loading line
        //    still names the real host, on its own line, whatever the event
        //    name tried to overwrite it with. The forged URL may well
        //    appear further down as INERT TEXT inside the escaped row —
        //    that is the fix working, not failing — so this checks the
        //    paste-ready block above the table, which is the region the
        //    operator selects and the region the attack rewrote.
        const block = text.slice(0, text.indexOf('Event counts'))
        expect(block).toContain(`<script async src="${HOST}/lyraflow.js"></script>`)
        expect(block).not.toContain('evil.test')
      })
    }

    it('--json is safe by construction, and this checks it rather than assuming it', async () => {
      // `JSON.stringify` escapes every control character inside a string it
      // serialises — `\n` to two characters, ESC to the six characters
      // `\`+`u001b`. Asserted here, not taken on trust, because the human
      // path was ALSO assumed safe by inheritance from every other renderer
      // in this CLI and was not.
      const { ctx, out } = makeCtx(clientWithName(CURSOR_ATTACK))
      await runSnippet(['--json'], ctx)
      const text = out.join('')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence is the point.
      expect(text.replace(/\n$/, '')).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
      const parsed = JSON.parse(text)
      // The name round-trips EXACTLY — the JSON contract carries the real
      // bytes, escaped; it is the terminal renderer that must not.
      expect(parsed.events.counts).toContainEqual({ event_name: CURSOR_ATTACK, count: 999 })
    })
  })

  describe('schema/events and events/stats are informational, and degrade INDEPENDENTLY', () => {
    // The message a REAL `Client` produces for a 400. `#toApiError`
    // (client.ts) sets `message` to the body's `error` field — the bare
    // code — and discards the server's own `detail`. Every fixture here
    // uses that, because the previous version of this suite asserted
    // against a message the client cannot produce (`'this window at 1d
    // resolution would produce 1500 buckets…'`, which is the server's
    // `detail`), and a test written against an impossible value proves
    // nothing about the real path.
    const WINDOW_TOO_LARGE = new ApiError(400, 'window_too_large', 'window_too_large')

    it('leaves the success arm exactly four keys — no `partial` when both requests answered', async () => {
      // The risk the `partial` field introduces, pinned at the layer a
      // consumer actually reads: the CLI README documents the success arm
      // as exact-set `{since, until, counts, truncated}`, and adding an
      // optional field is exactly the change that quietly widens it.
      //
      // KNOWN LIMIT, since a test that overstates what it proves is worse
      // than none: this reads the SERIALISED output, and `JSON.stringify`
      // drops a key whose value is `undefined` — so a `partial: undefined`
      // written into the success shape passes here (verified, not assumed).
      // What it does catch is a `partial` carrying a real value on the
      // success path, which is the mutation that would break a consumer.
      const { ctx, out } = makeCtx(fakeClient)
      await runSnippet(['--json'], ctx)
      const parsed = JSON.parse(out.join(''))
      expect(Object.keys(parsed.events).sort()).toEqual(
        ['counts', 'since', 'truncated', 'until'].sort(),
      )
    })

    it('keeps the all-time schema names when events/stats fails, instead of losing both', async () => {
      // The Important the whole-branch review found. One `try` around both
      // requests meant a `window_too_large` from `events/stats` — which the
      // README's own remedy ("widen the window") walks a caller straight
      // into past ~1000 days — discarded the ALL-TIME, un-windowed
      // `schema/events` result that had already succeeded. `--since 999d`
      // printed four names; `--since 1001d` printed an error and nothing
      // else. The old test could not see it: its fixture set `schemaEvents:
      // { events: [] }`, so there was no successful half to lose.
      const client = fakeGetClient({
        project: PROJECT,
        schemaEvents: {
          events: [{ event_name: 'legacy_import' }, { event_name: 'signup' }],
        },
        stats: WINDOW_TOO_LARGE,
      })
      const { ctx, out } = makeCtx(client)
      expect(await runSnippet(['--since', '1500d'], ctx)).toBe(0)
      const text = out.join('')
      expect(text).toContain('wk_test_key')
      // The names survive — this is the whole point.
      expect(text).toContain('legacy_import')
      expect(text).toContain('signup')
      // And what happened is still said, without the stutter (M3): the
      // client's message for a 400 IS the code, so `${message} (${code})`
      // printed `window_too_large (window_too_large)`.
      expect(text).toContain('Event counts unavailable: (window_too_large)')
      expect(text).not.toContain('window_too_large (window_too_large)')
      // Counts are UNKNOWN, not zero: `0` would assert "it fired before
      // this window", which nothing here established.
      expect(text).toMatch(/legacy_import\s+-/)
      expect(text).not.toMatch(/legacy_import\s+0/)
    })

    it('reports the same degradation in --json, with null counts and a named source', async () => {
      const client = fakeGetClient({
        project: PROJECT,
        schemaEvents: { events: [{ event_name: 'legacy_import' }] },
        stats: WINDOW_TOO_LARGE,
      })
      const { ctx, out } = makeCtx(client)
      await runSnippet(['--json', '--since', '1500d'], ctx)
      const parsed = JSON.parse(out.join(''))
      expect(Object.keys(parsed).sort()).toEqual(
        ['events', 'host', 'methods', 'sdk_version', 'snippet', 'write_key'].sort(),
      )
      expect(parsed.events.counts).toEqual([{ event_name: 'legacy_import', count: null }])
      expect(parsed.events.partial).toEqual({
        source: 'events/stats',
        code: 'window_too_large',
        message: 'window_too_large',
      })
      // Not the both-failed shape: a consumer checking `.events.error`
      // first (as the README tells it to) must not see one here.
      expect(parsed.events.error).toBeUndefined()
    })

    it('keeps the windowed counts when schema/events fails, instead of losing both', async () => {
      // The same defect mirrored. `events/stats` alone is a complete,
      // useful answer for the window — losing it to a 503 on the ALL-TIME
      // list is the identical wrong trade.
      const client = fakeGetClient({
        project: PROJECT,
        schemaEvents: new ApiError(503, 'draining', 'the server is saturated or shutting down'),
        stats: {
          buckets: [{ bucket: '2026-08-02T00:00:00.000Z', event_name: 'signup', events: 12 }],
        },
      })
      const { ctx, out } = makeCtx(client)
      expect(await runSnippet([], ctx)).toBe(0)
      const text = out.join('')
      expect(text).toContain('wk_test_key')
      expect(text).toMatch(/signup\s+12/)
      expect(text).toContain('All-time event names unavailable')
      // A real message, distinct from the code, still renders in full.
      expect(text).toContain('the server is saturated or shutting down (draining)')
    })

    it('degrades to the both-failed shape only when BOTH requests fail', async () => {
      const client = fakeGetClient({
        project: PROJECT,
        schemaEvents: new ApiError(503, 'draining', 'retry'),
        stats: new ApiError(503, 'draining', 'retry'),
      })
      const { ctx, out } = makeCtx(client)
      await runSnippet(['--json'], ctx)
      const parsed = JSON.parse(out.join(''))
      expect(Object.keys(parsed).sort()).toEqual(
        ['events', 'host', 'methods', 'sdk_version', 'snippet', 'write_key'].sort(),
      )
      expect(parsed.events.error.code).toBe('draining')
      expect(parsed.events.counts).toBeUndefined()
    })

    it('still prints the snippet in every degraded shape, with exit 0', async () => {
      const shapes: Responses[] = [
        { project: PROJECT, schemaEvents: { events: [] }, stats: WINDOW_TOO_LARGE },
        {
          project: PROJECT,
          schemaEvents: new ApiError(503, 'draining', 'retry'),
          stats: { buckets: [] },
        },
        {
          project: PROJECT,
          schemaEvents: new ApiError(503, 'draining', 'retry'),
          stats: WINDOW_TOO_LARGE,
        },
      ]
      for (const shape of shapes) {
        const { ctx, out } = makeCtx(fakeGetClient(shape))
        expect(await runSnippet([], ctx)).toBe(0)
        expect(out.join('')).toContain('wk_test_key')
      }
    })
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

  it('never leaks a server-key-shaped sentinel placed in ANY argv slot, in --json mode too', async () => {
    // The exemption tests and the sweep above both default to this file's
    // own human-mode default (`isTty: true`) -- forced to `--json` here so
    // the same guarantee is pinned in the mode Task 4 actually parses.
    const secret = 'sk_live_SENTINEL_never_here_json'
    const shapes: string[][] = [
      ['--json', secret],
      ['--json', `--server-key=${secret}`],
      ['--json', '--server-key', secret],
      ['--json', '--since', secret],
    ]
    for (const argv of shapes) {
      const { ctx, out, errOut } = makeCtx(fakeClient)
      await runSnippet(argv, ctx)
      expect(out.join('') + errOut.join('')).not.toContain(secret)
    }
  })
})
