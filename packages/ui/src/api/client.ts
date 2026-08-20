import { dedupeInFlight } from './dedupe.js'
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
  ProjectUpdate,
  PropertyKind,
  RangeBody,
  RejectionsPage,
  RejectionsQuery,
  SchemaProperty,
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
  /**
   * Rename a project, archive it, or restore it. Instance-scoped like
   * `projects()` and `createProject()` -- it names the project in the path
   * rather than in the header, because the caller may be operating on a
   * project that is not the active one.
   */
  updateProject(id: number, patch: ProjectUpdate): Promise<Project>
  /**
   * The admin account's own two mutations. Both take the CURRENT password:
   * a session is enough to read this install and deliberately not enough to
   * change what recovers the account.
   *
   * Instance-scoped, so neither carries the project header -- "who am I" has
   * no project to resolve against.
   */
  changeEmail(email: string, currentPassword: string): Promise<{ email: string }>
  changePassword(currentPassword: string, newPassword: string): Promise<void>
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
  // The behaviour form needs property autocomplete as well as event
  // autocomplete. `schemaEvents` already exists from the funnels work;
  // this one does not, and adding it here rather than inventing a second
  // fetch site mid-form.
  schemaProperties(
    projectId: number,
    event: string | undefined,
    q: string,
  ): Promise<SchemaProperty[]>
  schemaEvents(projectId: number, q: string): Promise<string[]>
  // The values one trait holds. `trait` is required, not optional like
  // `schemaProperties`' `event`: the endpoint refuses a request without one,
  // and the type says so here rather than letting a caller discover it as a
  // 400. Expensive on the server — see the route's own comment — so callers
  // must reach it on an explicit interaction, never on render.
  schemaTraitValues(projectId: number, trait: string, q: string): Promise<string[]>
}

/**
 * Collapses the endpoint's `(property_key, value_kind)` rows into one entry
 * per name.
 *
 * `value_kind` used to be dropped here, and that was the whole of #-this-bug:
 * `wherePredicate` and `traitExpr` choose which of the two property maps to
 * read from the JAVASCRIPT TYPE of the predicate's value, and a form whose
 * every control yields `e.target.value` can only ever produce a string. So a
 * predicate on a numeric property read the string map, matched nothing, and
 * said so with a zero. The kind was on the wire the entire time.
 *
 * The endpoint returns one row per DISTINCT pair, so a key a project has sent
 * both ways appears twice. That is `mixed`, and it is not the same as either:
 * a single predicate cannot read both maps, so a caller is told the fact
 * rather than handed a guess dressed as an answer.
 *
 * An unrecognised `value_kind` is ignored rather than trusted -- a name whose
 * only rows carry one is `string`, which is what this client did for every
 * name before it read the field at all.
 */
export function foldPropertyKinds(
  rows: { property_key: string; value_kind: string }[],
): SchemaProperty[] {
  const kinds = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.value_kind !== 'string' && row.value_kind !== 'number') continue
    const seen = kinds.get(row.property_key) ?? new Set<string>()
    seen.add(row.value_kind)
    kinds.set(row.property_key, seen)
  }
  const out: SchemaProperty[] = []
  const emitted = new Set<string>()
  // Driven off `rows`, not off the map, so the endpoint's own ORDER BY
  // survives -- the picker renders these verbatim.
  for (const row of rows) {
    if (emitted.has(row.property_key)) continue
    emitted.add(row.property_key)
    const seen = kinds.get(row.property_key)
    const kind: PropertyKind =
      seen === undefined || seen.size === 0
        ? 'string'
        : seen.size > 1
          ? 'mixed'
          : seen.has('number')
            ? 'number'
            : 'string'
    out.push({ name: row.property_key, kind })
  }
  return out
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
    updateProject: (id: number, patch: ProjectUpdate) =>
      call<Project>(`/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    changeEmail: (email, currentPassword) =>
      call<{ email: string }>('/v1/auth/email', {
        method: 'PATCH',
        body: JSON.stringify({ email, current_password: currentPassword }),
      }),
    changePassword: async (currentPassword, newPassword) => {
      // The response sets a fresh session cookie -- every session including
      // this one was revoked by the change, so the browser is carried by
      // the new cookie the server just issued. Nothing to return.
      await call('/v1/auth/password', {
        method: 'PATCH',
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      })
    },
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
    // DEDUPED: opening a segment mounts every condition at once, and sibling
    // `where` predicates under one behaviour ask for the identical list. See
    // `dedupeInFlight` -- nothing is retained once a request settles, so this
    // adds no staleness rules (#127).
    schemaProperties: dedupeInFlight(
      async (projectId: number, event: string | undefined, q: string) =>
        foldPropertyKinds(
          (
            await call<{ properties: { property_key: string; value_kind: string }[] }>(
              `/v1/schema/properties${qs({ event, q, limit: 50 })}`,
              {},
              projectId,
            )
          ).properties,
        ),
      (projectId: number, event: string | undefined, q: string) =>
        `${projectId}\u0000${event ?? ''}\u0000${q}`,
    ),
    schemaEvents: dedupeInFlight(
      async (projectId: number, q: string) =>
        // `last_seen` is in the response and deliberately dropped here: this
        // client returns names for a datalist, and nothing on screen ranks or
        // shows recency yet. Typed anyway so the wire shape is not a lie.
        (
          await call<{ events: { event_name: string; last_seen: string }[] }>(
            `/v1/schema/events${qs({ q, limit: 50 })}`,
            {},
            projectId,
          )
        ).events.map((e) => e.event_name),
      (projectId: number, q: string) => `${projectId}\u0000${q}`,
    ),
    // NOT deduped, and that asymmetry is deliberate. This one fetches on
    // FOCUS rather than on mount, because it scans the project's trait
    // partition rather than reading a purpose-built catalogue -- so it never
    // produces the simultaneous burst the two above do, and there is nothing
    // for a dedupe to collapse. Documented at the call site too (#127).
    schemaTraitValues: async (projectId, trait, q) =>
      (
        await call<{ values: { value: string }[] }>(
          `/v1/schema/trait-values${qs({ trait, q, limit: 50 })}`,
          {},
          projectId,
        )
      ).values.map((v) => v.value),
  }
}
