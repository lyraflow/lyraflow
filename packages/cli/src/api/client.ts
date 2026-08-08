/**
 * The CLI's HTTP client for Lyraflow's read/privacy API. Every later command
 * built on this CLI composes on `Client` rather than calling `fetch` itself.
 *
 * `x-lyraflow-server-key` (SERVER_KEY_HEADER below) matches
 * packages/server/src/ingest/routes.ts's SERVER_KEY_HEADER — this client
 * talks to the same header the server-key-gated routes already expect.
 */

const SERVER_KEY_HEADER = 'x-lyraflow-server-key'

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
    return (await res.json()) as T
  }

  async delete<T>(path: string): Promise<T> {
    const res = await this.#request('DELETE', path)
    return (await res.json()) as T
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
   */
  async *getLines(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): AsyncGenerator<string> {
    const res = await this.#request('GET', path, query)
    if (!res.body) return

    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true })
      let newlineAt = buffer.indexOf('\n')
      while (newlineAt !== -1) {
        yield buffer.slice(0, newlineAt)
        buffer = buffer.slice(newlineAt + 1)
        newlineAt = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) yield buffer
  }

  async #request(
    method: string,
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<Response> {
    const url = this.#buildUrl(path, query)

    let res: Response
    try {
      res = await this.#fetchImpl(url, {
        method,
        headers: { [SERVER_KEY_HEADER]: this.#serverKey },
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

    if (!res.ok) throw await this.#toApiError(res)
    return res
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
