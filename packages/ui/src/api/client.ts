import type {
  EventsPage,
  EventsQuery,
  Project,
  RejectionsPage,
  RejectionsQuery,
  StatsPage,
  StatsQuery,
} from './types.js'

/** The feed's default page size. Explicit on every request -- see #32. */
export const DEFAULT_LIMIT = 100

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`)
    this.name = 'ApiError'
  }
}

export interface ApiClient {
  authState(): Promise<{ configured: boolean }>
  login(email: string, password: string): Promise<{ email: string }>
  logout(): Promise<void>
  session(): Promise<{ email: string }>
  projects(): Promise<Project[]>
  events(projectId: number, q: EventsQuery): Promise<EventsPage>
  stats(projectId: number, q: StatsQuery): Promise<StatsPage>
  rejections(projectId: number, q: RejectionsQuery): Promise<RejectionsPage>
}

function qs(params: Record<string, string | number | undefined>): string {
  const s = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue
    // An empty string is "no filter was chosen", not a literal filter value --
    // distinct from a legitimate falsy number like `offset: 0`, which must survive.
    if (v === '') continue
    s.set(k, String(v))
  }
  const out = s.toString()
  return out ? `?${out}` : ''
}

/**
 * The ONLY place this application calls fetch.
 *
 * Two things every request needs, and centralising them is why this module
 * exists: `credentials: 'include'`, without which the browser withholds
 * lf_session and every call 401s in a way that reads as a broken session;
 * and `x-lyraflow-ui`, which is the CSRF defence -- a form cannot set a
 * custom header, and a cross-origin XHR that tries triggers a preflight
 * these routes answer with no CORS headers at all.
 *
 * `fetchImpl` exists so tests can drive it without a network or a jsdom
 * fetch polyfill. Production passes nothing.
 */
export function createClient(fetchImpl: typeof fetch = fetch): ApiClient {
  async function call<T>(path: string, init: RequestInit = {}, projectId?: number): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('x-lyraflow-ui', '1')
    if (projectId !== undefined) headers.set('x-lyraflow-project', String(projectId))
    if (init.body !== undefined) headers.set('content-type', 'application/json')

    const res = await fetchImpl(path, { ...init, headers, credentials: 'include' })

    if (!res.ok) {
      // A 5xx from a proxy is frequently HTML. Parsing must not throw a
      // SyntaxError that replaces the real status with a parse failure.
      let code = 'unknown'
      try {
        const body = (await res.json()) as { error?: string }
        if (typeof body.error === 'string') code = body.error
      } catch {
        /* keep 'unknown' */
      }
      throw new ApiError(res.status, code)
    }

    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  return {
    authState: () => call('/v1/auth/state'),
    login: (email, password) =>
      call('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: () => call('/v1/auth/logout', { method: 'POST' }),
    session: () => call('/v1/auth/session'),
    projects: async () => (await call<{ projects: Project[] }>('/v1/projects')).projects,
    events: (projectId, q) =>
      call(`/v1/events${qs({ ...q, limit: q.limit ?? DEFAULT_LIMIT })}`, {}, projectId),
    stats: (projectId, q) => call(`/v1/events/stats${qs({ ...q })}`, {}, projectId),
    rejections: (projectId, q) =>
      call(`/v1/events/rejections${qs({ ...q, limit: q.limit ?? DEFAULT_LIMIT })}`, {}, projectId),
  }
}
