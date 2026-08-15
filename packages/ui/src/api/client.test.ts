import { describe, expect, it, vi } from 'vitest'
import { ApiError, createClient } from './client.js'

function fakeFetch(status: number, body: unknown) {
  return vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
}

describe('createClient', () => {
  it('sends the UI header on every request', async () => {
    const f = fakeFetch(200, { configured: true })
    await createClient(f as unknown as typeof fetch).authState()
    const init = f.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('x-lyraflow-ui')).toBe('1')
  })

  // Without this the browser does not send lf_session on same-origin
  // requests initiated by fetch, and every authenticated call 401s in a way
  // that looks like a broken session rather than a missing option.
  it('sends credentials on every request', async () => {
    const f = fakeFetch(200, { configured: true })
    await createClient(f as unknown as typeof fetch).authState()
    const init = f.mock.calls[0]?.[1] as RequestInit
    expect(init.credentials).toBe('include')
  })

  it('sends the project header on project-scoped requests', async () => {
    const f = fakeFetch(200, { events: [], next_cursor: null })
    await createClient(f as unknown as typeof fetch).events(7, { limit: 50 })
    const init = f.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('x-lyraflow-project')).toBe('7')
  })

  it('does NOT send the project header on instance-scoped requests', async () => {
    const f = fakeFetch(200, { projects: [] })
    await createClient(f as unknown as typeof fetch).projects()
    const init = f.mock.calls[0]?.[1] as RequestInit
    expect(new Headers(init.headers).get('x-lyraflow-project')).toBeNull()
  })

  // #32: an omitted limit means the server's default, and a caller that
  // never states one cannot reason about whether a page was full.
  it('always sends an explicit limit on the feed', async () => {
    const f = fakeFetch(200, { events: [], next_cursor: null })
    await createClient(f as unknown as typeof fetch).events(1, {})
    const url = String(f.mock.calls[0]?.[0])
    expect(url).toMatch(/[?&]limit=\d+/)
  })

  it('raises ApiError carrying the status and the code', async () => {
    const f = fakeFetch(403, { error: 'missing_ui_header' })
    const client = createClient(f as unknown as typeof fetch)
    await expect(client.projects()).rejects.toMatchObject({
      status: 403,
      code: 'missing_ui_header',
    })
  })

  // A 401 must be distinguishable so the shell can route to login rather
  // than showing an error banner over an empty screen.
  it('raises ApiError with status 401 when the session is gone', async () => {
    const f = fakeFetch(401, { error: 'invalid_session' })
    const client = createClient(f as unknown as typeof fetch)
    await expect(client.session()).rejects.toBeInstanceOf(ApiError)
    await expect(client.session()).rejects.toMatchObject({ status: 401 })
  })

  // MINOR from the whole-branch review: GET /v1/auth/session answers
  // `{ email: null }` when the session cookie is still valid but the admin
  // row it names is gone. This must resolve, not reject -- a null email is
  // a different session state from no session at all.
  it('resolves with a null email rather than rejecting or coercing it', async () => {
    const f = fakeFetch(200, { email: null })
    const client = createClient(f as unknown as typeof fetch)
    await expect(client.session()).resolves.toEqual({ email: null })
  })

  // A 5xx from a proxy is often HTML, not JSON. Parsing must not throw a
  // SyntaxError that hides the real status from the caller.
  it('survives a non-JSON error body', async () => {
    const f = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response('<html>502</html>', { status: 502 }),
    )
    const client = createClient(f as unknown as typeof fetch)
    await expect(client.projects()).rejects.toMatchObject({ status: 502 })
  })

  it('returns the parsed body on success', async () => {
    const f = fakeFetch(200, { projects: [{ id: 1, name: 'A', slug: 'a' }] })
    const out = await createClient(f as unknown as typeof fetch).projects()
    expect(out[0]?.name).toBe('A')
  })

  // login is the single most important call in this client -- a body sent
  // without content-type gets 400 invalid_body server-side, which presents
  // to a user as "my password is wrong".
  describe('login and logout', () => {
    it('login POSTs to /v1/auth/login', async () => {
      const f = fakeFetch(200, { email: 'a@b.com' })
      await createClient(f as unknown as typeof fetch).login('a@b.com', 'hunter2')
      const url = String(f.mock.calls[0]?.[0])
      const init = f.mock.calls[0]?.[1] as RequestInit
      expect(url).toBe('/v1/auth/login')
      expect(init.method).toBe('POST')
    })

    it('login sends a JSON body with exactly the given email and password', async () => {
      const f = fakeFetch(200, { email: 'a@b.com' })
      await createClient(f as unknown as typeof fetch).login('a@b.com', 'hunter2')
      const init = f.mock.calls[0]?.[1] as RequestInit
      expect(JSON.parse(init.body as string)).toEqual({ email: 'a@b.com', password: 'hunter2' })
    })

    it('login sets content-type: application/json', async () => {
      const f = fakeFetch(200, { email: 'a@b.com' })
      await createClient(f as unknown as typeof fetch).login('a@b.com', 'hunter2')
      const init = f.mock.calls[0]?.[1] as RequestInit
      expect(new Headers(init.headers).get('content-type')).toBe('application/json')
    })

    it('login carries the UI header and credentials like every other call', async () => {
      const f = fakeFetch(200, { email: 'a@b.com' })
      await createClient(f as unknown as typeof fetch).login('a@b.com', 'hunter2')
      const init = f.mock.calls[0]?.[1] as RequestInit
      expect(new Headers(init.headers).get('x-lyraflow-ui')).toBe('1')
      expect(init.credentials).toBe('include')
    })

    it('login does NOT carry the project header -- it is instance-scoped', async () => {
      const f = fakeFetch(200, { email: 'a@b.com' })
      await createClient(f as unknown as typeof fetch).login('a@b.com', 'hunter2')
      const init = f.mock.calls[0]?.[1] as RequestInit
      expect(new Headers(init.headers).get('x-lyraflow-project')).toBeNull()
    })

    it('logout POSTs and tolerates a 204 with no body', async () => {
      const f = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(null, { status: 204 }),
      )
      const client = createClient(f as unknown as typeof fetch)
      await expect(client.logout()).resolves.toBeUndefined()
      const init = f.mock.calls[0]?.[1] as RequestInit
      expect(init.method).toBe('POST')
    })
  })

  // #32's sibling: `offset: 0` is the rejections feed's literal first page,
  // not "no value" -- the guard in qs() must keep it while still omitting
  // an unset param.
  describe('qs() and falsy values', () => {
    it('sends an explicit offset of 0 on the rejections feed', async () => {
      const f = fakeFetch(200, { rejections: [], has_more: false, next_offset: 0 })
      await createClient(f as unknown as typeof fetch).rejections(1, { offset: 0 })
      const url = String(f.mock.calls[0]?.[0])
      expect(url).toMatch(/[?&]offset=0(&|$)/)
    })

    it('omits a param that was never set', async () => {
      const f = fakeFetch(200, { rejections: [], has_more: false, next_offset: 0 })
      await createClient(f as unknown as typeof fetch).rejections(1, {})
      const url = String(f.mock.calls[0]?.[0])
      expect(url).not.toMatch(/[?&]offset=/)
    })

    // An empty string from an unfilled filter input means "no filter", not
    // a literal filter value -- unlike `offset: 0`, which is meaningful.
    it('omits an empty-string reason filter', async () => {
      const f = fakeFetch(200, { rejections: [], has_more: false, next_offset: 0 })
      await createClient(f as unknown as typeof fetch).rejections(1, { reason: '' })
      const url = String(f.mock.calls[0]?.[0])
      expect(url).not.toMatch(/[?&]reason=/)
    })

    it('sends a non-empty reason filter', async () => {
      const f = fakeFetch(200, { rejections: [], has_more: false, next_offset: 0 })
      await createClient(f as unknown as typeof fetch).rejections(1, { reason: 'bad_schema' })
      const url = String(f.mock.calls[0]?.[0])
      expect(url).toMatch(/[?&]reason=bad_schema(&|$)/)
    })
  })
})
