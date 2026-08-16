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

  // Invented: the brief's mutation table names this row a question rather
  // than a prescribed test, because Settings.test.tsx drives a fake
  // `ApiClient` object and never touches `call()` at all -- attaching the
  // header there would be unobservable from that suite. It IS observable
  // here, the same way it already is for `projects()` above, so pin it
  // the same way rather than leave the guard resting on "nobody happened
  // to pass a project id".
  it('does NOT send the project header on createProject either', async () => {
    const f = fakeFetch(200, {
      name: 'Beta',
      slug: 'beta',
      write_key: 'wk_new',
      server_key: 'sk_new',
    })
    await createClient(f as unknown as typeof fetch).createProject('Beta')
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

  // MINOR (whole-branch review): a validation 400's `detail[]` -- the
  // per-path `{ path, message }` array the funnel routes already compute --
  // used to be discarded at the one call site that parses the response
  // body, leaving `describeError` nothing to build a field-specific message
  // from. This is the one place that response is ever read.
  it('carries a 400 response body detail[] onto the thrown ApiError', async () => {
    const f = fakeFetch(400, {
      error: 'invalid funnel',
      detail: [{ path: 'window_seconds', message: 'Expected positive integer' }],
    })
    const client = createClient(f as unknown as typeof fetch)
    await expect(client.projects()).rejects.toMatchObject({
      status: 400,
      code: 'invalid funnel',
      detail: [{ path: 'window_seconds', message: 'Expected positive integer' }],
    })
  })

  it('leaves detail undefined when the response body carries none', async () => {
    const f = fakeFetch(403, { error: 'missing_ui_header' })
    const client = createClient(f as unknown as typeof fetch)
    await expect(client.projects()).rejects.toMatchObject({ detail: undefined })
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

  describe('funnels', () => {
    it('lists funnels for the active project and unwraps the envelope', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ funnels: [{ id: 7, name: 'Signup' }] }), { status: 200 }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      const out = await client.funnels(3)

      expect(out).toEqual([{ id: 7, name: 'Signup' }])
      const [path, init] = fetchImpl.mock.calls[0] ?? []
      expect(path).toBe('/v1/funnels')
      expect(init?.method ?? 'GET').toBe('GET')
      expect(new Headers(init?.headers).get('x-lyraflow-project')).toBe('3')
      expect(new Headers(init?.headers).get('x-lyraflow-ui')).toBe('1')
    })

    // Fix round 1: a singular GET had zero coverage. Pinned the same way as
    // the list -- verb, path, project header -- plus that the id lands in
    // the path, not the query string.
    it('funnel GETs a single funnel by id under the project header', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ id: 7, name: 'Signup' }), { status: 200 }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      const out = await client.funnel(3, 7)

      expect(out).toEqual({ id: 7, name: 'Signup' })
      const [path, init] = fetchImpl.mock.calls[0] ?? []
      expect(path).toBe('/v1/funnels/7')
      expect(init?.method ?? 'GET').toBe('GET')
      expect(new Headers(init?.headers).get('x-lyraflow-project')).toBe('3')
    })

    it('runs a funnel with POST and sends the range in the body, not the query', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ entered: 0, converted: 0, steps: [] }), { status: 200 }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      await client.runFunnel(3, 7, { since: '2026-08-01T00:00:00.000Z' })

      const [path, init] = fetchImpl.mock.calls[0] ?? []
      // POST, not GET: run carries a range body. A `?since=` here would be
      // silently ignored by the server and the range would default to 7 days.
      expect(path).toBe('/v1/funnels/7/run')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('x-lyraflow-project')).toBe('3')
      expect(JSON.parse(init?.body as string)).toEqual({ since: '2026-08-01T00:00:00.000Z' })
    })

    // Fix round 1: the original test only asserted `resolves.toBeUndefined()`
    // and never inspected `fetchImpl.mock.calls` -- a stub `deleteFunnel`
    // that never calls fetch at all still resolved undefined and passed.
    // Pinned the verb, the path and the project header the same way every
    // other method in this describe block now is.
    it('deleteFunnel sends DELETE to the funnel path under the project header', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(null, { status: 204 }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      await expect(client.deleteFunnel(3, 7)).resolves.toBeUndefined()

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [path, init] = fetchImpl.mock.calls[0] ?? []
      expect(path).toBe('/v1/funnels/7')
      expect(init?.method).toBe('DELETE')
      expect(new Headers(init?.headers).get('x-lyraflow-project')).toBe('3')
    })

    // Invented: the three prescribed tests above each pin transport mechanics
    // (path, method, headers) but none of them pin the actual JSON shape of a
    // create/patch/preview body. `createFunnel` is exactly the case the brief
    // calls out as consequential: the server parses one flat object twice --
    // once as `{ name }`, once as `FunnelDefinition` -- so a caller that nests
    // `{ name, definition: {...} }` gets a 400 that this suite would not have
    // caught. Mutating the spread to a nested body left all prior tests green.
    it('createFunnel sends name and the definition flattened into ONE object, not nested', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ id: 9, name: 'Signup' }), { status: 201 }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      await client.createFunnel(3, 'Signup', {
        steps: [{ event: 'signed_up' }],
        window_seconds: 604800,
        segment_id: null,
      })

      const [path, init] = fetchImpl.mock.calls[0] ?? []
      expect(path).toBe('/v1/funnels')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('x-lyraflow-project')).toBe('3')
      expect(JSON.parse(init?.body as string)).toEqual({
        name: 'Signup',
        steps: [{ event: 'signed_up' }],
        window_seconds: 604800,
        segment_id: null,
      })
    })

    // Fix round 1: patchFunnel had zero coverage -- the reviewer mutated it to
    // send PUT with an unrelated body and the full suite stayed green. Pins
    // verb, path, project header, and that the patch object is sent verbatim
    // (a field ABSENT from the call must stay absent on the wire, the same
    // "omit means unchanged" contract `ProjectPatch` documents elsewhere).
    it('patchFunnel sends PATCH to the funnel path with exactly the given patch', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ id: 7, name: 'Renamed' }), { status: 200 }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      await client.patchFunnel(3, 7, { name: 'Renamed' })

      const [path, init] = fetchImpl.mock.calls[0] ?? []
      expect(path).toBe('/v1/funnels/7')
      expect(init?.method).toBe('PATCH')
      expect(new Headers(init?.headers).get('x-lyraflow-project')).toBe('3')
      expect(JSON.parse(init?.body as string)).toEqual({ name: 'Renamed' })
    })

    // Same body-shape family as createFunnel: `/v1/funnels/preview` also
    // parses one flat object, so the definition and the range must both be
    // flattened into it rather than nested under separate keys.
    it('previewFunnel flattens the definition and the range into ONE body', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(JSON.stringify({ entered: 0, converted: 0, steps: [] }), { status: 200 }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      await client.previewFunnel(
        3,
        { steps: [{ event: 'signed_up' }], window_seconds: 604800 },
        { since: '2026-08-01T00:00:00.000Z' },
      )

      const [path, init] = fetchImpl.mock.calls[0] ?? []
      expect(path).toBe('/v1/funnels/preview')
      expect(init?.method).toBe('POST')
      expect(new Headers(init?.headers).get('x-lyraflow-project')).toBe('3')
      expect(JSON.parse(init?.body as string)).toEqual({
        steps: [{ event: 'signed_up' }],
        window_seconds: 604800,
        since: '2026-08-01T00:00:00.000Z',
      })
    })

    // Fix round 1: segments had zero coverage. Pins the verb, path, project
    // header AND the envelope-unwrapping -- the route answers
    // `{ segments: [...] }`, and a client that forgot to unwrap it, or
    // unwrapped the wrong key, would still typecheck.
    it('segments lists segments for the active project and unwraps the envelope', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({ segments: [{ id: 1, name: 'Power users', stale: false }] }),
            { status: 200 },
          ),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      const out = await client.segments(3)

      expect(out).toEqual([{ id: 1, name: 'Power users', stale: false }])
      const [path, init] = fetchImpl.mock.calls[0] ?? []
      expect(path).toBe('/v1/segments')
      expect(init?.method ?? 'GET').toBe('GET')
      expect(new Headers(init?.headers).get('x-lyraflow-project')).toBe('3')
    })

    // Fix round 1: schemaEvents had zero coverage. Pins the verb, path,
    // project header, that `q` reaches the query string, and the
    // `{ events: [{ event_name }] }` -> `string[]` unwrapping/mapping --
    // a client that returned the objects unmapped, or read the wrong key,
    // would still typecheck against a loosely-shaped stub.
    it('schemaEvents sends q in the query string and maps events to their names', async () => {
      const fetchImpl = vi.fn(
        async (_input: RequestInfo | URL, _init?: RequestInit) =>
          new Response(
            JSON.stringify({ events: [{ event_name: 'signed_up' }, { event_name: 'page_view' }] }),
            { status: 200 },
          ),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      const out = await client.schemaEvents(3, 'sig')

      expect(out).toEqual(['signed_up', 'page_view'])
      const [path, init] = fetchImpl.mock.calls[0] ?? []
      const url = String(path)
      expect(url).toMatch(/^\/v1\/schema\/events\?/)
      expect(url).toMatch(/[?&]q=sig(&|$)/)
      expect(init?.method ?? 'GET').toBe('GET')
      expect(new Headers(init?.headers).get('x-lyraflow-project')).toBe('3')
    })
  })

  describe('segments', () => {
    // Invented: `segment` (singular) had zero coverage the way `funnel`
    // (singular) once did (see fix round 1 above) -- mutating it to send
    // PUT to the wrong path left the whole suite green. Pins verb, path and
    // project header the same way the funnel equivalent already does.
    it('segment GETs a single segment by id under the project header', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ id: 7, name: 'Power users' }), { status: 200 }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      const out = await client.segment(3, 7)

      expect(out).toEqual({ id: 7, name: 'Power users' })
      const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(path).toBe('/v1/segments/7')
      expect(init?.method ?? 'GET').toBe('GET')
      expect(new Headers(init?.headers).get('x-lyraflow-project')).toBe('3')
    })

    // Invented: same body-shape family as createFunnel/previewSegment --
    // `/v1/segments` also parses one flat object, so a caller that nests
    // `{ name, definition: {...} }` gets a 400 this suite would not have
    // caught. Mutating the spread to a nested body left the whole suite
    // green, the same as createSegment having zero coverage at all.
    it('createSegment sends name and the query flattened into ONE object, not nested', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ id: 9, name: 'Power users' }), { status: 201 }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)
      const filter = { kind: 'trait', key: 'plan', operator: '=', value: 'pro' }

      await client.createSegment(3, 'Power users', { ast_version: 1, filter })

      const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(path).toBe('/v1/segments')
      expect(init.method).toBe('POST')
      expect(new Headers(init.headers).get('x-lyraflow-project')).toBe('3')
      expect(JSON.parse(init.body as string)).toEqual({
        name: 'Power users',
        ast_version: 1,
        filter,
      })
    })

    it('previews an ad-hoc tree with the tree and the options in one flat body', async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ person_count: 3, warnings: [], as_of: 'x' }), {
            status: 200,
          }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)
      const filter = { kind: 'trait', key: 'plan', operator: '=', value: 'pro' }

      await client.previewSegment(3, { ast_version: 1, filter }, { include: ['members'] })

      const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(path).toBe('/v1/segments/preview')
      expect(init.method).toBe('POST')
      // The route parses the SAME body twice -- once as SegmentQuery, once as
      // PreviewOptions. A nested { query, options } shape fails both.
      expect(JSON.parse(init.body as string)).toEqual({
        ast_version: 1,
        filter,
        include: ['members'],
      })
      expect(new Headers(init.headers).get('x-lyraflow-project')).toBe('3')
    })

    // Fix round 1: previewSavedSegment had zero coverage -- a reviewer
    // stubbed all nine segment methods in turn and this was the only one
    // where the whole suite (40/40) stayed green against a no-op stub.
    // Pins verb, path, project header, and that a call with no options
    // sends `{}` rather than `undefined` -- the route does
    // `PreviewOptions.safeParse(req.body ?? {})`, and `JSON.stringify(undefined)`
    // is the string `"undefined"`, not valid JSON, which is a different
    // failure than an empty-but-valid body.
    it('previewSavedSegment POSTs to the saved segment path and sends {} with no options', async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ person_count: 3, warnings: [], as_of: 'x' }), {
            status: 200,
          }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      await client.previewSavedSegment(3, 7)

      const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(path).toBe('/v1/segments/7/preview')
      expect(init.method).toBe('POST')
      expect(new Headers(init.headers).get('x-lyraflow-project')).toBe('3')
      expect(JSON.parse(init.body as string)).toEqual({})
    })

    it('previewSavedSegment sends the given options in the body', async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify({ person_count: 3, warnings: [], as_of: 'x' }), {
            status: 200,
          }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      await client.previewSavedSegment(3, 7, { include: ['members'], cursor: 'abc' })

      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(JSON.parse(init.body as string)).toEqual({ include: ['members'], cursor: 'abc' })
    })

    it('renames without sending a tree', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }))
      const client = createClient(fetchImpl as unknown as typeof fetch)

      await client.renameSegment(3, 7, 'New name')

      const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(path).toBe('/v1/segments/7')
      expect(init.method).toBe('PATCH')
      // The server decides whether to touch the filter by whether the body
      // carries a tree AT ALL. A rename that ships the tree resets the count
      // snapshot -- the same defect as #92, except here the client owns it.
      expect(JSON.parse(init.body as string)).toEqual({ name: 'New name' })
    })

    it('updates a tree by sending it', async () => {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { status: 200 }))
      const client = createClient(fetchImpl as unknown as typeof fetch)
      const filter = { kind: 'trait', key: 'plan', operator: '=', value: 'pro' }

      await client.updateSegmentTree(3, 7, { ast_version: 1, filter })

      const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect(body).toEqual({ ast_version: 1, filter })
      expect(body.name).toBeUndefined()
    })

    it('deleteSegment tolerates the 204 with no body', async () => {
      const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }))
      const client = createClient(fetchImpl as unknown as typeof fetch)
      await expect(client.deleteSegment(3, 7)).resolves.toBeUndefined()

      // Invented: `resolves.toBeUndefined()` alone is also true of a stub
      // that never calls fetch at all -- confirmed by mutating deleteSegment
      // to `async () => undefined` and watching the suite stay green. Pin
      // the verb, path and project header the same way deleteFunnel's test
      // already does, so a no-op stub fails here too.
      expect(fetchImpl).toHaveBeenCalledTimes(1)
      const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(path).toBe('/v1/segments/7')
      expect(init.method).toBe('DELETE')
      expect(new Headers(init.headers).get('x-lyraflow-project')).toBe('3')
    })

    it('schemaProperties sends event and q in the query string and maps to property_key', async () => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              properties: [
                { property_key: 'plan', value_kind: 'string' },
                { property_key: 'plan_price', value_kind: 'number' },
              ],
            }),
            { status: 200 },
          ),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      const out = await client.schemaProperties(3, 'signed_up', 'pla')

      expect(out).toEqual(['plan', 'plan_price'])
      const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      const url = String(path)
      expect(url).toMatch(/^\/v1\/schema\/properties\?/)
      expect(url).toMatch(/[?&]event=signed_up(&|$)/)
      expect(url).toMatch(/[?&]q=pla(&|$)/)
      expect(new Headers(init.headers).get('x-lyraflow-project')).toBe('3')
    })

    it('schemaProperties omits event when undefined', async () => {
      const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify({ properties: [] }), { status: 200 }),
      )
      const client = createClient(fetchImpl as unknown as typeof fetch)

      await client.schemaProperties(3, undefined, 'pla')

      const [path] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
      expect(String(path)).not.toMatch(/[?&]event=/)
    })
  })
})
