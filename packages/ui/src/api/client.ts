import { dedupeInFlight } from './dedupe.js'
import type {
  CreatedProject,
  Dashboard,
  DashboardInput,
  DashboardPatch,
  DashboardShare,
  DashboardSummary,
  DeletionStatus,
  EventsPage,
  EventsQuery,
  Funnel,
  FunnelDefinition,
  FunnelPeoplePage,
  FunnelPeopleQuery,
  FunnelRunResult,
  FunnelStep,
  Meta,
  Person,
  PersonDeletion,
  PreviewOptions,
  Project,
  ProjectDeletion,
  ProjectIdentity,
  ProjectLimits,
  ProjectPatch,
  ProjectUpdate,
  PropertyKind,
  RangeBody,
  RejectionsPage,
  RejectionsQuery,
  RetentionReport,
  RetentionReportInput,
  RetentionRequest,
  RetentionResult,
  SchemaProperty,
  Segment,
  SegmentPreview,
  SharedDashboard,
  SharedRangePreset,
  SharedRunResult,
  StatsPage,
  StatsQuery,
  TrendReport,
  TrendReportInput,
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
    // Seconds to wait before retrying, off a 429's `retry-after` header --
    // the shared-viewer run route is the one caller that can hit this
    // (120 runs/token/60s), and a UI that shows "try again" needs the
    // number rather than having to re-parse the header itself. Absent for
    // every other error, including a 429 that (unexpectedly) carries no
    // header or a non-numeric one.
    readonly retryAfterSeconds?: number,
  ) {
    super(`${status} ${code}`)
    this.name = 'ApiError'
  }
}

/**
 * Reads `retry-after` off an error response as a positive whole number of
 * seconds, or `undefined` for anything that isn't one -- missing header,
 * `NaN`, zero, negative. Factored out of `call` and `callPublic` so the two
 * cannot drift: both throw `ApiError` on the same failure path and both
 * need the exact same tolerance for a header that is absent or malformed.
 */
function parseRetryAfter(res: Response): number | undefined {
  const retryAfter = Number(res.headers.get('retry-after'))
  return Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined
}

/**
 * Parses an error response body -- shared by `call` and `callBlob`, the
 * two `fetchImpl` call sites, because both need the same tolerance: a 5xx
 * from a proxy is frequently HTML, so parsing must not throw a SyntaxError
 * that replaces the real status with a parse failure. Both fall back to
 * `'unknown'` rather than propagate one.
 *
 * `callBlob`'s SUCCESS body is NDJSON, not JSON -- that is the entire
 * reason it exists instead of using `call`. Its ERROR body is JSON like
 * every other route's, which is what makes one helper correct for both
 * call sites rather than merely convenient.
 */
async function parseErrorCode(res: Response): Promise<{ code: string; detail?: ApiErrorDetail[] }> {
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
  return { code, detail }
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
  /**
   * What release this install is running, for the Settings screen's Install
   * card. Instance-scoped like `projects()` -- "what version is this" names
   * no project, so this must not carry the project header.
   */
  meta(): Promise<Meta>
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
   * Destroys a project and everything it holds, in both databases. `slug`
   * travels as the confirmation the server re-checks -- the UI having
   * already matched it is not the guarantee, the server's own check is.
   * 202: the teardown runs asynchronously, and `id` here is the DELETION
   * REQUEST's id (`projectDeletion`'s own param), not the project's.
   */
  deleteProject(
    id: number,
    slug: string,
  ): Promise<{ id: number; project_id: number; status: string }>
  /** Polls one deletion request by the id `deleteProject` returned. */
  projectDeletion(id: number): Promise<ProjectDeletion>
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
  /**
   * The people at one step -- either everyone who reached it or only those
   * who stopped there, per `body.mode`. Its own signed cursor label on the
   * server, so a page fetched for one mode cannot be replayed against the
   * other.
   */
  funnelPeople(projectId: number, id: number, body: FunnelPeopleQuery): Promise<FunnelPeoplePage>
  /**
   * The saved-report CRUD surfaces. Same five-method shape as
   * `funnels`/`funnel`/`createFunnel`/`patchFunnel`/`deleteFunnel` above,
   * for both report kinds -- including that each list unwraps its own
   * envelope key, named for the resource (`{ trends: [...] }`,
   * `{ retention_reports: [...] }`), like every other list endpoint in
   * this API.
   */
  trendReports(projectId: number): Promise<TrendReport[]>
  trendReport(projectId: number, id: number): Promise<TrendReport>
  createTrendReport(projectId: number, body: TrendReportInput): Promise<TrendReport>
  patchTrendReport(
    projectId: number,
    id: number,
    patch: Partial<TrendReportInput>,
  ): Promise<TrendReport>
  deleteTrendReport(projectId: number, id: number): Promise<void>
  retentionReports(projectId: number): Promise<RetentionReport[]>
  retentionReport(projectId: number, id: number): Promise<RetentionReport>
  createRetentionReport(projectId: number, body: RetentionReportInput): Promise<RetentionReport>
  patchRetentionReport(
    projectId: number,
    id: number,
    patch: Partial<RetentionReportInput>,
  ): Promise<RetentionReport>
  deleteRetentionReport(projectId: number, id: number): Promise<void>
  dashboards(projectId: number): Promise<DashboardSummary[]>
  dashboard(projectId: number, id: number): Promise<Dashboard>
  createDashboard(projectId: number, body: DashboardInput): Promise<Dashboard>
  patchDashboard(projectId: number, id: number, patch: DashboardPatch): Promise<Dashboard>
  deleteDashboard(projectId: number, id: number): Promise<void>
  /**
   * Mints (or re-mints) this dashboard's share link. Session-authenticated
   * like every other dashboard call above -- sharing is an owner action,
   * not a viewer one -- and the plaintext token in the response is the
   * caller's one chance to show or copy it, same one-time-disclosure
   * discipline as `createProject`'s `server_key`.
   */
  shareDashboard(projectId: number, id: number): Promise<DashboardShare>
  /** Revokes this dashboard's share link. Any viewer holding the old token
   * gets `share_not_found` from `sharedDashboard` afterwards. */
  unshareDashboard(projectId: number, id: number): Promise<void>
  /**
   * The two calls a share link's VIEWER makes -- unauthenticated, unlike
   * every method above this pair. Routed through `callPublic`, not `call`:
   * a person holding a link has no session, and must not be handed the
   * owner's cookie, UI header or project header by accident. See
   * `callPublic`'s own docstring for why.
   */
  sharedDashboard(token: string): Promise<SharedDashboard>
  /** Runs one tile's report for the viewer, over the given preset range.
   * Rate-limited server-side (120/token/60s, 3 in flight) -- a 429 here
   * carries `ApiError.retryAfterSeconds`. */
  runSharedTile(token: string, index: number, range: SharedRangePreset): Promise<SharedRunResult>
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
  runRetention(projectId: number, body: RetentionRequest): Promise<RetentionResult>
  // The values one trait holds. `trait` is required, not optional like
  // `schemaProperties`' `event`: the endpoint refuses a request without one,
  // and the type says so here rather than letting a caller discover it as a
  // 400. Expensive on the server — see the route's own comment — so callers
  // must reach it on an explicit interaction, never on render.
  schemaTraitValues(projectId: number, trait: string, q: string): Promise<string[]>
  /** `GET /v1/persons/:id`. `id` is caller-supplied -- `identify('someone@example.com')`
   * is the ordinary case -- so the route always encodes it with
   * `encodeURIComponent`, never `encodeURI`: an id containing `/`, `?` or
   * `#` would otherwise reach a different route, or a different query,
   * entirely. */
  person(projectId: number, id: string): Promise<Person>
  /**
   * Downloads the subject-access export as a `Blob`, NOT through `call` --
   * the export is NDJSON and `call` always ends in `res.json()`. See
   * `callBlob`'s own docstring for why this buffers despite the server
   * streaming deliberately, and for who owns the size ceiling.
   */
  personExport(projectId: number, id: string): Promise<Blob>
  /** `DELETE /v1/persons/:id`. Same id-encoding requirement as `person()`. */
  deletePerson(projectId: number, id: string): Promise<PersonDeletion>
  /** Polls one deletion request by the id `deletePerson` returned as `request_id`. */
  deletion(projectId: number, requestId: number): Promise<DeletionStatus>
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
      const { code, detail } = await parseErrorCode(res)
      throw new ApiError(res.status, code, detail, parseRetryAfter(res))
    }

    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  /**
   * The viewer surface. No session header, no project header, and
   * `credentials: 'omit'`: a person holding a share link has no session and
   * must not be handed one by accident, and the routes ignore both headers
   * anyway. Shares `parseErrorCode` with `call` and nothing else.
   */
  async function callPublic<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const res = await fetchImpl(path, { ...init, headers, credentials: 'omit' })
    if (!res.ok) {
      const { code, detail } = await parseErrorCode(res)
      throw new ApiError(res.status, code, detail, parseRetryAfter(res))
    }
    return (await res.json()) as T
  }

  /**
   * The one request whose body is not JSON. `call` ends in `res.json()`,
   * and the subject-access export is NDJSON.
   *
   * It buffers. The endpoint streams deliberately -- `export.ts`'s
   * docstring explains that a second copy of one person's complete
   * personal data is the liability that route refuses to create -- and a
   * buffered `Blob` puts exactly that copy in browser memory. It is here
   * anyway because `auth/bridge.ts` requires both `x-lyraflow-ui` and
   * `x-lyraflow-project` on the session path, and no `<a download>`, form,
   * or opened window can set a header. The size ceiling this trade-off
   * needs is enforced by the CALLER, which knows the person's event count
   * -- not here.
   *
   * Shares `call`'s error path via `parseErrorCode` and nothing else: it is
   * not built by refactoring `call` to accommodate a non-JSON SUCCESS body,
   * because every other caller of `call` still wants that. The error body
   * is JSON regardless -- see `parseErrorCode`'s own docstring.
   */
  async function callBlob(path: string, projectId: number): Promise<Blob> {
    const headers = new Headers()
    headers.set('x-lyraflow-ui', '1')
    headers.set('x-lyraflow-project', String(projectId))
    const res = await fetchImpl(path, { headers, credentials: 'include' })

    if (!res.ok) {
      const { code } = await parseErrorCode(res)
      throw new ApiError(res.status, code)
    }

    return res.blob()
  }

  return {
    authState: () => call('/v1/auth/state'),
    login: (email, password) =>
      call('/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
    logout: () => call('/v1/auth/logout', { method: 'POST' }),
    session: () => call('/v1/auth/session'),
    // No third argument, deliberately -- see `createProject` just below for
    // the same reasoning. This route is instance-scoped.
    meta: () => call<Meta>('/v1/meta'),
    projects: async () => (await call<{ projects: Project[] }>('/v1/projects')).projects,
    // No third argument -- deliberately. This route is instance-scoped:
    // "create a project" has no existing project to resolve, and sending
    // the header would claim a scope this call doesn't have.
    createProject: (name) =>
      call('/v1/projects', { method: 'POST', body: JSON.stringify({ name }) }),
    updateProject: (id: number, patch: ProjectUpdate) =>
      call<Project>(`/v1/projects/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    deleteProject: (id: number, slug: string) =>
      call<{ id: number; project_id: number; status: string }>(`/v1/projects/${id}`, {
        method: 'DELETE',
        // The slug travels in the body as the confirmation the server
        // re-checks. The UI having already matched it is not the guarantee --
        // the server's own check is.
        body: JSON.stringify({ slug }),
      }),
    projectDeletion: (id: number) => call<ProjectDeletion>(`/v1/project-deletions/${id}`),
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
    funnelPeople: (projectId, id, body) =>
      call(`/v1/funnels/${id}/people`, { method: 'POST', body: JSON.stringify(body) }, projectId),
    trendReports: async (projectId) =>
      (await call<{ trends: TrendReport[] }>('/v1/trends', {}, projectId)).trends,
    trendReport: (projectId, id) => call(`/v1/trends/${id}`, {}, projectId),
    createTrendReport: (projectId, body) =>
      call('/v1/trends', { method: 'POST', body: JSON.stringify(body) }, projectId),
    patchTrendReport: (projectId, id, patch) =>
      call(`/v1/trends/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, projectId),
    deleteTrendReport: (projectId, id) => call(`/v1/trends/${id}`, { method: 'DELETE' }, projectId),
    retentionReports: async (projectId) =>
      (await call<{ retention_reports: RetentionReport[] }>('/v1/retention-reports', {}, projectId))
        .retention_reports,
    retentionReport: (projectId, id) => call(`/v1/retention-reports/${id}`, {}, projectId),
    createRetentionReport: (projectId, body) =>
      call('/v1/retention-reports', { method: 'POST', body: JSON.stringify(body) }, projectId),
    patchRetentionReport: (projectId, id, patch) =>
      call(
        `/v1/retention-reports/${id}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
        projectId,
      ),
    deleteRetentionReport: (projectId, id) =>
      call(`/v1/retention-reports/${id}`, { method: 'DELETE' }, projectId),
    dashboards: async (projectId) =>
      (await call<{ dashboards: DashboardSummary[] }>('/v1/dashboards', {}, projectId)).dashboards,
    dashboard: (projectId, id) => call(`/v1/dashboards/${id}`, {}, projectId),
    createDashboard: (projectId, body) =>
      call('/v1/dashboards', { method: 'POST', body: JSON.stringify(body) }, projectId),
    patchDashboard: (projectId, id, patch) =>
      call(`/v1/dashboards/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }, projectId),
    deleteDashboard: (projectId, id) =>
      call(`/v1/dashboards/${id}`, { method: 'DELETE' }, projectId),
    shareDashboard: (projectId, id) =>
      call(`/v1/dashboards/${id}/share`, { method: 'POST' }, projectId),
    unshareDashboard: (projectId, id) =>
      call(`/v1/dashboards/${id}/share`, { method: 'DELETE' }, projectId),
    sharedDashboard: (token) => callPublic(`/v1/shared/${encodeURIComponent(token)}`),
    runSharedTile: (token, index, range) =>
      callPublic(`/v1/shared/${encodeURIComponent(token)}/tiles/${index}/run`, {
        method: 'POST',
        body: JSON.stringify({ range }),
      }),
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
    runRetention: (projectId, body) =>
      call<RetentionResult>(
        '/v1/reports/retention',
        { method: 'POST', body: JSON.stringify(body) },
        projectId,
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
    person: (projectId, id) => call(`/v1/persons/${encodeURIComponent(id)}`, {}, projectId),
    deletePerson: (projectId, id) =>
      call(`/v1/persons/${encodeURIComponent(id)}`, { method: 'DELETE' }, projectId),
    deletion: (projectId, requestId) => call(`/v1/deletions/${requestId}`, {}, projectId),
    personExport: (projectId, id) =>
      callBlob(`/v1/persons/${encodeURIComponent(id)}/export`, projectId),
  }
}
