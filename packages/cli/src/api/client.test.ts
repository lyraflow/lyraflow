import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, Client } from './client.js'

const SERVER_KEY = 'sk_test_do_not_leak_me'

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers })

function make(fetchImpl: typeof fetch) {
  return new Client({ host: 'https://a.test', serverKey: SERVER_KEY, fetchImpl })
}

/**
 * A ReadableStream this test can push chunks into and close on its own
 * schedule, rather than one that resolves its whole body at once — a fake
 * whose body arrives all-at-once cannot distinguish `getLines` from a
 * buffering implementation (e.g. `(await res.text()).split('\n')`), because
 * both would produce the same final list of lines.
 */
function controllableBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  const enc = new TextEncoder()
  return {
    stream,
    push: (s: string) => controller.enqueue(enc.encode(s)),
    close: () => controller.close(),
  }
}

// A real (macro)task tick, not a fake-timer advance: the stream internals
// and the async generator's own `await`s are genuine promises, and fake
// timers don't drive those.
const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('Client', () => {
  it('sends the server key in the documented header', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { events: [] })) as unknown as typeof fetch
    const client = make(fetchImpl)
    await client.get('/v1/events')

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    if (!call) throw new Error('fetchImpl was not called')
    const [url, init] = call as [string, RequestInit & { headers: Record<string, string> }]
    expect(url).toBe('https://a.test/v1/events')
    expect(init.headers['x-lyraflow-server-key']).toBe(SERVER_KEY)
  })

  it('drops undefined query values rather than sending "undefined"', async () => {
    const fetchImpl = vi.fn(async () => reply(200, {})) as unknown as typeof fetch
    const client = make(fetchImpl)
    await client.get('/v1/events', { event: 'signup', person: undefined, limit: 0 })

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    if (!call) throw new Error('fetchImpl was not called')
    const [url] = call as [string, RequestInit]
    const search = new URL(url).searchParams
    expect(search.get('event')).toBe('signup')
    expect(search.has('person')).toBe(false)
    expect(search.toString()).not.toContain('undefined')
    // 0 is a legitimate value, not "falsy and therefore droppable" — a
    // `value ? … : skip` check would wrongly drop this one too.
    expect(search.get('limit')).toBe('0')
  })

  it('maps a 401 to a clear message that does not echo the key', async () => {
    // The key is a secret. An error that prints it lands in shell history, CI
    // logs and an agent's transcript.
    const fetchImpl = vi.fn(async () =>
      reply(401, { error: 'invalid_server_key' }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)
    const err = (await client.get('/v1/events').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(String(err.message)).not.toContain(SERVER_KEY)
  })

  it('maps a 503 to a retryable message naming retry-after', async () => {
    const fetchImpl = vi.fn(async () =>
      reply(503, { error: 'overloaded' }, { 'retry-after': '5' }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)
    const err = (await client.get('/v1/events').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(503)
    expect(err.message).toContain('retry')
    expect(err.message).toContain('5')
  })

  it("surfaces the server's error code when it sends one", async () => {
    // Distinct from the fixed, human message: `code` carries the server's
    // own `error` field verbatim so a caller can branch on it, while
    // `message` stays the constant "not found" sentence below — proving
    // the two are not the same value round-tripped.
    const fetchImpl = vi.fn(async () =>
      reply(404, { error: 'person_not_found' }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)
    const err = (await client.get('/v1/persons/p1').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.code).toBe('person_not_found')
    expect(err.message).toBe('not found')
  })

  it("maps 400/422 to the server's error field as the message", async () => {
    const fetchImpl = vi.fn(async () =>
      reply(422, { error: 'this person spans too many device windows' }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)
    const err = (await client.get('/v1/persons/p1').catch((e) => e)) as ApiError
    expect(err.status).toBe(422)
    expect(err.code).toBe('this person spans too many device windows')
    expect(err.message).toBe('this person spans too many device windows')
  })

  it('fails clearly when the host is unreachable, without a stack trace', async () => {
    const fetchImpl = vi.fn(async () => {
      // What Node's real fetch throws against a genuinely unreachable host.
      throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') })
    }) as unknown as typeof fetch
    const client = make(fetchImpl)
    const err = (await client.get('/v1/events').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(0)
    // A clear, single-line sentence — not the underlying error's own
    // "TypeError: fetch failed" text, and not a dumped stack (no frame
    // lines, which look like "    at ...").
    expect(err.message).not.toMatch(/\n\s*at /)
    expect(err.message).not.toContain('TypeError')
    expect(err.message).toContain('a.test')
  })

  it('streams NDJSON line by line rather than buffering', async () => {
    const { stream, push, close } = controllableBody()
    const fetchImpl = vi.fn(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)

    const seen: string[] = []
    let finished = false
    const consumer = (async () => {
      for await (const line of client.getLines('/v1/persons/p1/export')) {
        seen.push(line)
      }
      finished = true
    })()

    push('{"type":"person"}\n')
    await tick()
    expect(seen).toEqual(['{"type":"person"}'])
    // The stream is still open at this point — nobody has called close()
    // yet. A buffering implementation (e.g. `(await res.text()).split`)
    // cannot have produced anything here, because res.text() cannot
    // resolve until the stream ends.
    expect(finished).toBe(false)

    push('{"type":"event","event_id":"e1"}\n')
    await tick()
    expect(seen).toEqual(['{"type":"person"}', '{"type":"event","event_id":"e1"}'])
    expect(finished).toBe(false)

    push('{"type":"end","events":1}\n')
    close()
    await consumer
    expect(finished).toBe(true)
    expect(seen).toHaveLength(3)
  })

  it('getLines yields a final line even without a trailing newline', async () => {
    const { stream, push, close } = controllableBody()
    const fetchImpl = vi.fn(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)

    const seen: string[] = []
    const consumer = (async () => {
      for await (const line of client.getLines('/v1/persons/p1/export')) seen.push(line)
    })()

    push('{"type":"person"}\n{"type":"end","events":0}') // no trailing \n
    close()
    await consumer
    expect(seen).toEqual(['{"type":"person"}', '{"type":"end","events":0}'])
  })

  it('delete() sends DELETE and returns the parsed body', async () => {
    const fetchImpl = vi.fn(async () =>
      reply(202, { request_id: 'r1', person_id: 'p1' }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)
    const result = await client.delete<{ request_id: string }>('/v1/persons/p1')
    expect(result.request_id).toBe('r1')

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    if (!call) throw new Error('fetchImpl was not called')
    const [, init] = call as [string, RequestInit]
    expect(init.method).toBe('DELETE')
  })

  // --- Hunting the key leak beyond the 401 path --------------------------
  // The brief has one test for this, on the obvious path. The instruction
  // is explicit that the leak, if there is one, is somewhere else — so each
  // of these targets a distinct place the key could end up: a hostile
  // network error, a malformed host, JSON.stringify(err), and err.stack
  // (what console.error(err) would actually print, since Node's default
  // Error inspection is built from message + stack, not a custom toString).

  it('never echoes the underlying fetch error, even one that mentions the key', async () => {
    // Simulates a hostile/leaky fetchImpl — not what Node's real fetch does
    // (confirmed separately: it throws TypeError('fetch failed') with an
    // ECONNREFUSED cause, never anything about headers), but nothing
    // guarantees every fetch-shaped thing this client is ever called with
    // behaves that well. The request headers, including the key, are
    // exactly the kind of thing a badly-behaved shim might dump into an
    // error message.
    const fetchImpl = vi.fn(async () => {
      throw new Error(
        `connect failed; request headers were {"x-lyraflow-server-key":"${SERVER_KEY}"}`,
      )
    }) as unknown as typeof fetch
    const client = make(fetchImpl)
    const err = (await client.get('/v1/events').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(String(err.message)).not.toContain(SERVER_KEY)
    expect(String(err.stack)).not.toContain(SERVER_KEY)
  })

  it('does not leak the key when the host itself is malformed', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const client = new Client({
      host: 'not a valid host at:all',
      serverKey: SERVER_KEY,
      fetchImpl,
    })
    const err = (await client.get('/v1/events').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(String(err.message)).not.toContain(SERVER_KEY)
    expect(String(err.stack)).not.toContain(SERVER_KEY)
    // The bad URL is caught before any network attempt.
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('does not leak the key via JSON.stringify(err)', async () => {
    // ApiError's own enumerable fields are `status` and `code` — neither
    // ever holds the key — but this pins the whole serialised shape rather
    // than trusting that by construction.
    const fetchImpl = vi.fn(async () =>
      reply(401, { error: 'invalid_server_key' }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)
    const err = await client.get('/v1/events').catch((e) => e)
    expect(JSON.stringify(err)).not.toContain(SERVER_KEY)
  })

  it('does not leak the key via err.stack (what console.error(err) prints)', async () => {
    const fetchImpl = vi.fn(async () =>
      reply(401, { error: 'invalid_server_key' }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)
    const err = (await client.get('/v1/events').catch((e) => e)) as ApiError
    expect(String(err.stack)).not.toContain(SERVER_KEY)
  })

  // --- Redirects: a live exfiltration path, not a printed-string one ------
  // Fetch's cross-origin redirect handling strips only Authorization,
  // Cookie and Proxy-Authorization — an arbitrary header like the server
  // key is NOT stripped by spec, and `fetch`'s default `redirect: 'follow'`
  // would hand it to whatever `Location` names. A faked `fetchImpl` cannot
  // prove this either way: the forwarding happens inside the real `fetch`
  // implementation, between the two real requests, which a fake never
  // makes. This spins up two real local HTTP servers — one that redirects
  // to the other — and uses the client's real, uninjected `fetchImpl`.

  it('does not forward the server key to a redirect target, and fails loudly instead', async () => {
    let targetReceivedKey: string | undefined
    let targetWasHit = false
    const target = createServer((req, res) => {
      targetWasHit = true
      targetReceivedKey = req.headers['x-lyraflow-server-key'] as string | undefined
      res.end(JSON.stringify({ events: [] }))
    })
    const origin = createServer((req, res) => {
      const targetPort = (target.address() as AddressInfo).port
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/elsewhere` })
      res.end()
    })

    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve))
    try {
      const originPort = (origin.address() as AddressInfo).port
      const client = new Client({
        host: `http://127.0.0.1:${originPort}`,
        serverKey: SERVER_KEY,
        // Deliberately no fetchImpl override: the real global fetch is
        // exactly the thing under test here.
      })

      const err = (await client.get('/v1/events').catch((e) => e)) as ApiError
      expect(err).toBeInstanceOf(ApiError)
      expect(err.status).toBe(302)
      expect(err.message.toLowerCase()).toContain('redirect')
      expect(err.message).not.toContain(SERVER_KEY)
      // Not just "the client raised an ApiError" — the target must never
      // have been reached at all, and if it was, it must not have seen the
      // key.
      expect(targetWasHit).toBe(false)
      expect(targetReceivedKey).toBeUndefined()
    } finally {
      await new Promise((resolve) => target.close(resolve))
      await new Promise((resolve) => origin.close(resolve))
    }
  })

  // --- Minor: non-JSON 2xx bodies must still surface as ApiError ---------

  it('wraps a non-JSON 2xx body in ApiError instead of a raw SyntaxError', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('not json', { status: 200 }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)
    const err = (await client.get('/v1/events').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(200)
    expect(err.message).not.toContain('not json')
    expect(err.message.toLowerCase()).toContain('non-json')
  })

  it('wraps an empty 2xx body in ApiError instead of a raw SyntaxError', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('', { status: 200 }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)
    const err = (await client.delete('/v1/persons/p1').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(200)
  })

  // --- Minor: getLines strips a trailing \r from CRLF-terminated lines ---

  it('strips a trailing \\r so a CRLF stream still yields parseable lines', async () => {
    const { stream, push, close } = controllableBody()
    const fetchImpl = vi.fn(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch
    const client = make(fetchImpl)

    const seen: string[] = []
    const consumer = (async () => {
      for await (const line of client.getLines('/v1/persons/p1/export')) seen.push(line)
    })()

    push('{"type":"person"}\r\n{"type":"end","events":0}\r\n')
    close()
    await consumer

    expect(seen).toEqual(['{"type":"person"}', '{"type":"end","events":0}'])
    for (const line of seen) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})
