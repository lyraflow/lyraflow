/**
 * The CLI's HTTP client for Lyraflow's read/privacy API. Every later command
 * built on this CLI composes on `Client` rather than calling `fetch` itself.
 *
 * `x-lyraflow-server-key` (SERVER_KEY_HEADER below) matches
 * packages/server/src/ingest/routes.ts's SERVER_KEY_HEADER — this client
 * talks to the same header the server-key-gated routes already expect.
 */

const SERVER_KEY_HEADER = 'x-lyraflow-server-key'

/**
 * The real export route (packages/server/src/privacy/export.ts) writes bare
 * `\n` — this only matters if something between it and the caller rewrites
 * line endings to CRLF (a proxy, a Windows pipe). Left unstripped, the `\r`
 * becomes part of the line's content and `JSON.parse` on it fails at the far
 * end with no indication the line itself was otherwise fine.
 */
function stripTrailingCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

export interface ClientConfig {
  host: string
  serverKey: string
  fetchImpl?: typeof fetch
}

/**
 * A request that reached the server and was answered with a non-2xx status,
 * OR a request that never reached it at all (network failure, malformed
 * host/path). `status` is the real HTTP status in the first case; `0` in the
 * second, since there is no status to report.
 *
 * `code` is the server's own `error` field when the response carried a
 * parseable JSON body with one (every route in this API sends at least
 * `{ error: string }` on a non-2xx response) — otherwise a synthetic
 * `http_<status>` / `no_response` fallback. `message` is always a fixed,
 * human-readable sentence chosen by this client, NEVER a passthrough of
 * anything the server or the underlying network stack said — see the
 * class-wide guarantee below.
 *
 * GUARANTEE: nothing that reaches this class — not `message`, not `code`,
 * not the inherited `stack` — may ever contain `serverKey`. That value goes
 * out in one request header and nowhere else: never interpolated into a
 * message, never attached as `cause`, never logged. An error that echoed it
 * would land in shell history, CI logs and an agent's transcript, none of
 * which are secret-safe storage. See client.test.ts's "no leak" suite for
 * the specific paths this was checked against.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * A minimal HTTP client for the read/privacy API — no dependencies beyond
 * Node 22's global `fetch`, matching the rest of this package (see
 * packages/cli/package.json and its use of node:util's parseArgs instead of
 * a CLI framework).
 */
export class Client {
  #host: string
  #serverKey: string
  #fetchImpl: typeof fetch

  constructor(config: ClientConfig) {
    this.#host = config.host
    this.#serverKey = config.serverKey
    this.#fetchImpl = config.fetchImpl ?? globalThis.fetch.bind(globalThis)
  }

  async get<T>(path: string, query?: Record<string, string | number | undefined>): Promise<T> {
    const res = await this.#request('GET', path, query)
    return this.#readJson<T>(res)
  }

  async delete<T>(path: string): Promise<T> {
    const res = await this.#request('DELETE', path)
    return this.#readJson<T>(res)
  }

  /**
   * `body`, when given, is sent as a JSON request body (`content-type:
   * application/json`) — every POST route this client talks to today
   * (`/v1/segments/:id/preview`) accepts an optional JSON body of options,
   * never a form or raw payload. Routes through the same `#request` every
   * other method uses, so it inherits the same guarantees by construction
   * rather than by a second copy of them: `redirect: 'manual'` (the key is
   * never forwarded across an origin change — see `#request`'s own
   * docstring), and `#readJson` turning a non-JSON 2xx body into `ApiError`
   * instead of a raw `SyntaxError`.
   */
  async post<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.#request('POST', path, undefined, body)
    return this.#readJson<T>(res)
  }

  /**
   * Streams a response body line by line — for NDJSON endpoints (currently
   * only GET /v1/persons/:id/export, whose lines each already end in `\n`;
   * see packages/server/src/privacy/export.ts).
   *
   * Reads `res.body` chunk by chunk and yields each completed line as soon
   * as a `\n` shows up in the decoded buffer — it does NOT wait for the
   * response to finish before yielding anything. That matters for export:
   * a caller can start acting on the `person` line (always first) and each
   * `event` line while a large history is still streaming in, rather than
   * holding the whole body in memory until the connection closes.
   *
   * A final line with no trailing `\n` (should not happen against this
   * server — every line it writes ends in `\n` — but a truncated or
   * malformed stream could produce one) is still yielded once the body
   * ends, so a caller never silently loses trailing content.
   *
   * A server ending its OWN generator cleanly without a final terminator
   * line (export.ts's own documented truncation signal) is NOT this
   * method's concern — that is indistinguishable, at this layer, from a
   * normal end of a short response, and callers (persons.ts's `runExport`)
   * detect it themselves by checking for the terminator among the lines
   * they received. What IS this method's concern: the CONNECTION itself
   * dying mid-read — a killed server process, a proxy timeout, ClickHouse
   * taking the socket down — which surfaces as the body's own async
   * iterator THROWING (a bare `TypeError` from undici, e.g. `'terminated'`,
   * carrying no relation to `ApiError` at all). Every OTHER failure path in
   * this client surfaces as `ApiError` — `#request`'s network/redirect/
   * status handling, `#readJson`'s non-JSON-body guard — and callers catch
   * `ApiError` specifically to map exit codes (`reportCommandFailure`,
   * command-support.ts); a raw, unrelated error escaping ONLY from this one
   * streaming method would be the single path that breaks that contract,
   * reaching a caller as an uncaught exception with a raw Node stack trace
   * instead of a reportable failure. Wrapped here, once, so every future
   * streaming caller inherits the fix rather than repeating it.
   */
  async *getLines(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): AsyncGenerator<string> {
    const res = await this.#request('GET', path, query)
    if (!res.body) return

    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true })
        let newlineAt = buffer.indexOf('\n')
        while (newlineAt !== -1) {
          yield stripTrailingCR(buffer.slice(0, newlineAt))
          buffer = buffer.slice(newlineAt + 1)
          newlineAt = buffer.indexOf('\n')
        }
      }
    } catch {
      // The body's own iterator threw mid-stream — never the raw error
      // itself (untrusted, and its shape is not this client's to promise;
      // see the docstring above), always a fresh ApiError built from
      // values already known to be safe (the response's own status).
      throw new ApiError(
        res.status,
        'stream_interrupted',
        'the response stream ended unexpectedly while reading it',
      )
    }
    buffer += decoder.decode()
    if (buffer.length > 0) yield stripTrailingCR(buffer)
  }

  async #request(
    method: string,
    path: string,
    query?: Record<string, string | number | undefined>,
    body?: unknown,
  ): Promise<Response> {
    const url = this.#buildUrl(path, query)

    let res: Response
    try {
      res = await this.#fetchImpl(url, {
        method,
        // NOT the default 'follow'. Fetch's cross-origin redirect handling
        // strips Authorization/Cookie/Proxy-Authorization — nothing else,
        // by spec — so `x-lyraflow-server-key` sails straight through to
        // wherever a redirect points, including a different host entirely.
        // This client talks to exactly one configured host; a redirect
        // from it is never part of the normal contract (confirmed: no
        // route under packages/server/src ever sends one), so the only
        // safe move is to refuse to follow at all and fail loudly. A
        // compromised reverse proxy, DNS rebinding, or a MITM answering
        // with a redirect is precisely the scenario this defends — see
        // the redirect probe in client.test.ts, which proves against two
        // real local servers that the target never receives the header.
        redirect: 'manual',
        headers: {
          [SERVER_KEY_HEADER]: this.#serverKey,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch {
      // Deliberately not `${(err as Error).message}` or `{ cause: err }`:
      // the caught value is whatever the injected fetchImpl chose to throw,
      // and this client does not get to assume it is safe to repeat. A
      // real unreachable-host TypeError ("fetch failed", cause ECONNREFUSED
      // etc.) never mentions request headers — but nothing enforces that on
      // every fetch-shaped thing this could be called with, so the message
      // below is built fresh rather than forwarded.
      throw new ApiError(0, 'no_response', `could not reach ${this.#host}`)
    }

    // `res.type === 'opaqueredirect'` covers a fetch implementation that
    // follows the spec's browser-facing shape (status 0, opaque body) for a
    // manual redirect instead of Node's own (a real 3xx status, readable
    // headers) — checked against Node 22 directly, which does the latter,
    // but nothing guarantees every fetchImpl this client is ever handed
    // agrees. Either shape must be refused the same way. The message never
    // includes `Location`: it is attacker-controlled text chosen by
    // whatever answered the request, and printing it is the same mistake
    // as printing the key.
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      throw new ApiError(
        res.status,
        'unexpected_redirect',
        `the host answered with a redirect (status ${res.status}); this client will not follow it`,
      )
    }

    if (!res.ok) throw await this.#toApiError(res)
    return res
  }

  /**
   * Guards `res.json()` for every 2xx path. Not reachable against the real
   * server today — every 2xx route sends a JSON body — but every OTHER
   * failure path in this client surfaces as `ApiError`, and later tasks
   * catch `ApiError` specifically to map exit codes. A bare `SyntaxError`
   * from a non-JSON or empty body would be the one path that breaks that
   * contract. The body itself is never included in the message: it is
   * untrusted response text, same reasoning as not echoing `Location`.
   */
  async #readJson<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T
    } catch {
      throw new ApiError(res.status, 'invalid_response_body', 'the server returned a non-JSON body')
    }
  }

  #buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    let url: URL
    try {
      url = new URL(path, this.#host)
    } catch {
      // A malformed `host` (from a misconfigured env var, say) throws here
      // before any network call — same reasoning as the network-failure
      // catch above: build a clear message from values already known to be
      // safe (host, path — neither is ever the key) rather than forwarding
      // whatever URL's own TypeError said.
      throw new ApiError(
        0,
        'invalid_url',
        `could not build a request URL from host "${this.#host}" and path "${path}"`,
      )
    }
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        // Dropped, not stringified: `undefined` becoming the literal
        // three-letter query value "undefined" is exactly the kind of bug
        // an agent-driven caller (this CLI's whole reason to exist) would
        // never notice locally and would ship straight into a query string.
        if (value === undefined) continue
        url.searchParams.set(key, String(value))
      }
    }
    return url.toString()
  }

  /**
   * Every route in this API answers a non-2xx with at least
   * `{ error: string }` (see packages/server/src/**\/routes.ts) — `error`
   * becomes `code` here unconditionally, so a caller can always branch on
   * it. `message` is a fixed, hand-picked sentence per status: never the
   * server's own text verbatim, and never anything about the request (which
   * carried the key in a header this method never reads).
   */
  async #toApiError(res: Response): Promise<ApiError> {
    const status = res.status

    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      // No body, an empty body, or a body that isn't JSON (an intermediary
      // proxy's own error page, say). Treated the same as "no error field".
    }
    const serverError =
      body !== null &&
      typeof body === 'object' &&
      typeof (body as { error?: unknown }).error === 'string'
        ? ((body as { error: string }).error as string)
        : undefined
    const code = serverError ?? `http_${status}`

    if (status === 401) return new ApiError(status, code, 'the server key was rejected')
    if (status === 404) return new ApiError(status, code, 'not found')
    if (status === 400 || status === 422) {
      return new ApiError(status, code, serverError ?? `the request was rejected (${status})`)
    }
    if (status === 503) {
      let retryAfter: string | null = null
      try {
        retryAfter = res.headers.get('retry-after')
      } catch {
        retryAfter = null
      }
      const message = retryAfter
        ? `the server is saturated or shutting down; retry after ${retryAfter}s`
        : 'the server is saturated or shutting down; retry'
      return new ApiError(status, code, message)
    }
    return new ApiError(status, code, serverError ?? `the request failed with status ${status}`)
  }
}
