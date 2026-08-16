import type {
  CreatedProject,
  EventsPage,
  EventsQuery,
  Funnel,
  FunnelDefinition,
  FunnelRunResult,
  FunnelStep,
  PreviewOptions,
  Project,
  ProjectIdentity,
  ProjectLimits,
  ProjectPatch,
  RangeBody,
  RejectionsPage,
  RejectionsQuery,
  Segment,
  SegmentPreview,
  StatsPage,
  StatsQuery,
  Usage,
} from './types.js'

/** The feed's default page size. Explicit on every request -- see #32. */
export const DEFAULT_LIMIT = 100

/** One entry of a validation 400's `detail[]` -- `{ path, message }` against
 * the offending field, e.g. `{ path: "window_seconds", message: "Expected
 * positive integer" }`. */
export interface ApiErrorDetail {
  path: string
  message: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    // MINOR (whole-branch review): a validation 400 carries a per-path
    // `detail[]` the server already computed -- this is the one place that
    // ever reaches the wire, so a caller that wants to say WHICH field was
    // wrong (rather than a code an operator cannot act on) needs it kept,
    // not discarded at the one call site that parses the response body.
    readonly detail?: ApiErrorDetail[],
  ) {
    super(`${status} ${code}`)
    this.name = 'ApiError'
  }
}

export interface ApiClient {
  authState(): Promise<{ configured: boolean }>
  login(email: string, password: string): Promise<{ email: string }>
  logout(): Promise<void>
  // `email` is nullable: the server answers `{ email: null }` when the
  // session cookie is still valid but the admin row it names is gone
  // (MINOR from the whole-branch review). Typing this `string` was simply
  // false for that real response shape.
  session(): Promise<{ email: string | null }>
  projects(): Promise<Project[]>
  // Instance-scoped like `projects()` -- "does this name collide" has no
  // project to resolve against, so this must not carry the project header.
  // The server key in the response exists nowhere else, ever: only its
  // SHA-256 is stored, so this is the caller's one chance to show it.
  createProject(name: string): Promise<CreatedProject>
  project(projectId: number): Promise<ProjectIdentity>
  // A field ABSENT from `patch` means "leave unchanged" -- the caller must
  // never send `monthly_event_quota: 0` for "no change", only omit the
  // key entirely. See `ProjectPatch`'s docstring.
  patchProject(projectId: number, patch: ProjectPatch): Promise<ProjectLimits>
  usage(projectId: number): Promise<Usage>
  events(projectId: number, q: EventsQuery): Promise<EventsPage>
  stats(projectId: number, q: StatsQuery): Promise<StatsPage>
  rejections(projectId: number, q: RejectionsQuery): Promise<RejectionsPage>
  funnels(projectId: number): Promise<Funnel[]>
  funnel(projectId: number, id: number): Promise<Funnel>
  createFunnel(projectId: number, name: string, definition: FunnelDefinition): Promise<Funnel>
  patchFunnel(
    projectId: number,
    id: number,
    patch: {
      name?: string
      steps?: FunnelStep[]
      window_seconds?: number
      segment_id?: number | null
    },
  ): Promise<Funnel>
  deleteFunnel(projectId: number, id: number): Promise<void>
  // POST, not GET: both carry a range body. The server ignores query params here.
  previewFunnel(
    projectId: number,
    definition: FunnelDefinition,
    range: RangeBody,
  ): Promise<FunnelRunResult>
  runFunnel(projectId: number, id: number, range: RangeBody): Promise<FunnelRunResult>
  segments(projectId: number): Promise<Segment[]>
  segment(projectId: number, id: number): Promise<Segment>
  createSegment(
    projectId: number,
    name: string,
    query: { ast_version: number; filter: unknown },
  ): Promise<Segment>
  // Rename ONLY. Deliberately cannot carry a tree -- see the test.
  renameSegment(projectId: number, id: number, name: string): Promise<Segment>
  // Tree update ONLY. Deliberately cannot carry a name.
  updateSegmentTree(
    projectId: number,
    id: number,
    query: { ast_version: number; filter: unknown },
  ): Promise<Segment>
  deleteSegment(projectId: number, id: number): Promise<void>
  previewSegment(
    projectId: number,
    query: { ast_version: number; filter: unknown },
    options?: PreviewOptions,
  ): Promise<SegmentPreview>
  previewSavedSegment(
    projectId: number,
    id: number,
    options?: PreviewOptions,
  ): Promise<SegmentPreview>
  // Task 6's behaviour form needs property autocomplete as well as event
  // autocomplete. `schemaEvents` already exists from the funnels work;
  // this one does not, and adding it here rather than mid-task keeps Task 6
  // from inventing a second fetch site.
  schemaProperties(projectId: number, event: string | undefined, q: string): Promise<string[]>
  schemaEvents(projectId: number, q: string): Promise<string[]>
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
      let detail: ApiErrorDetail[] | undefined
      try {
        const body = (await res.json()) as { error?: string; detail?: unknown }
        if (typeof body.error === 'string') code = body.error
        if (Array.isArray(body.detail)) {
          const parsed = body.detail.filter(
            (d): d is ApiErrorDetail =>
              typeof d === 'object' &&
              d !== null &&
              typeof (d as Record<string, unknown>).path === 'string' &&
              typeof (d as Record<string, unknown>).message === 'string',
          )
          if (parsed.length > 0) detail = parsed
        }
      } catch {
        /* keep 'unknown', detail stays absent */
      }
      throw new ApiError(res.status, code, detail)
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
    // No third argument -- deliberately. This route is instance-scoped:
    // "create a project" has no existing project to resolve, and sending
    // the header would claim a scope this call doesn't have.
    createProject: (name) =>
      call('/v1/projects', { method: 'POST', body: JSON.stringify({ name }) }),
    // Both project-scoped the same way `events` is -- the header the client
    // attaches from `projectId`, not a path segment or query param.
    project: (projectId) => call('/v1/project', {}, projectId),
    patchProject: (projectId, patch) =>
      call('/v1/project', { method: 'PATCH', body: JSON.stringify(patch) }, projectId),
    usage: (projectId) => call('/v1/project/usage', {}, projectId),
    events: (projectId, q) =>
      call(`/v1/events${qs({ ...q, limit: q.limit ?? DEFAULT_LIMIT })}`, {}, projectId),
    stats: (projectId, q) => call(`/v1/events/stats${qs({ ...q })}`, {}, projectId),
    rejections: (projectId, q) =>
      call(`/v1/events/rejections${qs({ ...q, limit: q.limit ?? DEFAULT_LIMIT })}`, {}, projectId),
    funnels: async (projectId) =>
      (await call<{ funnels: Funnel[] }>('/v1/funnels', {}, projectId)).funnels,
    funnel: (projectId, id) => call(`/v1/funnels/${id}`, {}, projectId),
    createFunnel: (projectId, name, definition) =>
      call(
        '/v1/funnels',
        { method: 'POST', body: JSON.stringify({ name, ...definition }) },
        projectId,
      ),
    patchFunnel: (projectId, id, patch) =>
      call(`/v1/funnels/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, projectId),
    deleteFunnel: (projectId, id) => call(`/v1/funnels/${id}`, { method: 'DELETE' }, projectId),
    previewFunnel: (projectId, definition, range) =>
      call(
        '/v1/funnels/preview',
        { method: 'POST', body: JSON.stringify({ ...definition, ...range }) },
        projectId,
      ),
    runFunnel: (projectId, id, range) =>
      call(`/v1/funnels/${id}/run`, { method: 'POST', body: JSON.stringify(range) }, projectId),
    segments: async (projectId) =>
      (await call<{ segments: Segment[] }>('/v1/segments', {}, projectId)).segments,
    segment: (projectId, id) => call(`/v1/segments/${id}`, {}, projectId),
    createSegment: (projectId, name, query) =>
      call('/v1/segments', { method: 'POST', body: JSON.stringify({ name, ...query }) }, projectId),
    renameSegment: (projectId, id, name) =>
      call(`/v1/segments/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }, projectId),
    updateSegmentTree: (projectId, id, query) =>
      call(`/v1/segments/${id}`, { method: 'PATCH', body: JSON.stringify(query) }, projectId),
    deleteSegment: (projectId, id) => call(`/v1/segments/${id}`, { method: 'DELETE' }, projectId),
    previewSegment: (projectId, query, options) =>
      call(
        '/v1/segments/preview',
        { method: 'POST', body: JSON.stringify({ ...query, ...options }) },
        projectId,
      ),
    previewSavedSegment: (projectId, id, options) =>
      call(
        `/v1/segments/${id}/preview`,
        { method: 'POST', body: JSON.stringify({ ...options }) },
        projectId,
      ),
    schemaProperties: async (projectId, event, q) =>
      (
        await call<{ properties: { property_key: string }[] }>(
          `/v1/schema/properties${qs({ event, q, limit: 50 })}`,
          {},
          projectId,
        )
      ).properties.map((p) => p.property_key),
    schemaEvents: async (projectId, q) =>
      (
        await call<{ events: { event_name: string }[] }>(
          `/v1/schema/events${qs({ q, limit: 50 })}`,
          {},
          projectId,
        )
      ).events.map((e) => e.event_name),
  }
}
