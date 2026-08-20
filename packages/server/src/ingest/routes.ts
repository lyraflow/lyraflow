import cors from '@fastify/cors'
import {
  BatchPayload,
  IngestPayload,
  isBot,
  isServerSideLibrary,
  parseUserAgent,
} from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Project, ProjectCache } from '../auth/project-cache.js'
import type { Readiness } from '../health.js'
import type { PersonAliases } from '../identity/aliases.js'
import type { IdentityBindings } from '../identity/bindings.js'
import type { IngestBuffer } from './buffer.js'
import { type IngestCounters, currentMonth } from './counters.js'
import type { GeoResolver } from './geo.js'
import { type CardinalityTracker, checkLimits } from './limits.js'
import { isOverQuota } from './quota.js'
import { type EventRow, chDateTime, parseChDateTime, toEventRow } from './row.js'

export interface IngestDeps {
  buffer: IngestBuffer<EventRow>
  projects: ProjectCache
  counters: IngestCounters
  cardinality: CardinalityTracker
  geo: GeoResolver
  readiness: Readiness
  ch: ClickHouseClient
  bindings: IdentityBindings
  aliases: PersonAliases
  /**
   * Origins permitted to call the write-key routes from a browser. Empty (or
   * omitted, for callers that construct IngestDeps directly rather than
   * through Config) means any origin — see config.ts's allowedOrigins for
   * why that is the right default. NOT a security boundary; see the same
   * docstring.
   */
  allowedOrigins?: string[]
  /**
   * Overridable so a test can cross a refresh boundary without sleeping for
   * the production value — the same seam, for the same reason, that
   * ProjectCache's `negativeTtlMs` parameter provides. Production uses the
   * default. Without it, every quota test completes inside one TTL and the
   * entire refresh half of the usage cache is unreachable: expiry, the
   * month check, and the in-flight cleanup can all be deleted with the suite
   * still green, and one of those three freezes a project's persisted figure
   * for the life of the process.
   */
  quotaUsageTtlMs?: number
}

export const WRITE_KEY_HEADER = 'x-lyraflow-write-key'
// Deliberately distinct from WRITE_KEY_HEADER: the write key is public (it
// ships in browser JavaScript) and can only append events. Aliasing mutates
// identity for the whole project and is not reversible in v0.1 (see
// PersonAliases's docstring), so it is gated on the secret server key
// instead — see `authenticateServer` below. GET /v1/persons/:id
// (identity/person.ts) reads person data rather than mutating it, but is
// gated the same way for the same underlying reason: it must not be
// reachable with the public, browser-shipped write key.
export const SERVER_KEY_HEADER = 'x-lyraflow-server-key'

/**
 * Builds an authenticator for one key type. `authenticate` (write key) and
 * `authenticateServer` (server key) previously duplicated this whole body,
 * differing only in header name, lookup, and the two error codes — a shape
 * that makes it structurally possible for the two to drift on the drain
 * check (the one line rule 2 actually depends on staying identical between
 * them). Parameterising it here makes that drift impossible instead of
 * merely unlikely.
 *
 * Exported at module scope (rather than nested inside registerIngestRoutes)
 * so identity/person.ts's GET /v1/persons/:id can build its own
 * server-key-gated authenticator through the exact same logic instead of
 * duplicating it a third time. `readiness` is an explicit parameter for
 * that reason: registerIngestRoutes's version used to close over its own
 * `deps.readiness` implicitly, which only worked because every caller lived
 * inside that one function.
 */
export function makeAuthenticator(
  readiness: Readiness,
  headerName: string,
  lookup: (key: string) => Promise<Project | null>,
  missingCode: string,
  invalidCode: string,
) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (readiness.draining) {
      reply.code(503).header('retry-after', '5').send({ error: 'draining' })
      return null
    }
    const key = req.headers[headerName]
    if (typeof key !== 'string' || key.length === 0) {
      reply.code(401).send({ error: missingCode })
      return null
    }
    const project = await lookup(key)
    if (!project) {
      reply.code(401).send({ error: invalidCode })
      return null
    }
    return project
  }
}

/**
 * How long a project's *persisted* accepted-event total is reused before it
 * is re-read from Postgres.
 *
 * The quota check runs on the hottest path in the product — once per event,
 * on an endpoint whose key ships in the browser bundle — so reading
 * `ingest_counters` per event would put a Postgres round trip in front of
 * every `/v1/track` against a `max: 10` pool. It is cached per project
 * instead, and the free in-memory `pendingAccepted` is added on every single
 * check, so the figure the check acts on still moves with each event this
 * process accepts.
 *
 * 5s, against the 10s counter flush interval in index.ts: the cached figure
 * is only ever wrong by the events flushed to Postgres since it was read, so
 * the window in which a project can exceed its quota is bounded by roughly
 * one TTL plus one flush interval of that project's traffic. Halving the TTL
 * relative to the flush interval keeps that window close to the flush
 * interval itself — which is the floor no cache TTL can get under — while
 * costing at most twelve queries per project per minute, against the one per
 * event it replaces.
 *
 * The overshoot that leaves is designed slack, and its size is set by ONE
 * thing: how stale the persisted figure is, i.e. roughly one TTL plus one
 * flush interval of that project's own traffic. A second server process has
 * its own pending tally and its own cache, which widens that same window by
 * roughly the process count rather than introducing a different kind of
 * error.
 *
 * Concurrency does NOT widen it, and that is a property of accept()'s atomic
 * block rather than of anything here. It has not always been true: while the
 * pending read sat behind an `await`, a burst of simultaneous requests all
 * decided against the same figure and the overshoot was set by the caller's
 * concurrency and this read's latency instead of by the project's own rate —
 * a quota that stopped working entirely at 25ms of read latency. See
 * `overQuotaNow`. Any statement of the bound, here or in the README, is a
 * claim about that block staying await-free.
 *
 * The same TTL bounds the FAILURE path: a read that throws records a
 * negative entry honoured for this long, so an unreachable Postgres costs
 * one attempt per project per TTL rather than one per event. See
 * `usageFailedAt` in registerIngestRoutes.
 *
 * This is the default; IngestDeps.quotaUsageTtlMs overrides it, and only a
 * test does.
 */
export const QUOTA_USAGE_TTL_MS = 5_000

interface DeadLetterRow {
  project_id: number
  received_at: string
  reason: string
  detail: string
  payload: string
}

function buildDeadLetterRow(
  projectId: number,
  reason: string,
  detail: string,
  payload: unknown,
): DeadLetterRow {
  return {
    project_id: projectId,
    received_at: chDateTime(new Date()),
    reason,
    detail: detail.slice(0, 1000),
    payload: JSON.stringify(payload).slice(0, 8000),
  }
}

/**
 * Writes every dead-letter row collected for one request in a single insert.
 * A batch can carry up to 500 items; writing each rejection as its own
 * ClickHouse round trip would let one request — sent with the public,
 * rate-limited write key — hold 500 sequential HTTP calls open against
 * ClickHouse. Dead letters skip IngestBuffer's batching by design (they are
 * already the exceptional path), so batching them here is this function's job.
 */
async function writeDeadLetters(
  ch: ClickHouseClient,
  rows: DeadLetterRow[],
  onError: (err: unknown, rows: DeadLetterRow[]) => void,
): Promise<void> {
  if (rows.length === 0) return
  try {
    // A synchronous throw from insert() (closed client, malformed value) must
    // be caught the same as a rejected promise — a bare .catch() attached to
    // the call's return value never runs for a throw that happens before
    // insert() returns a promise at all. See the identical reasoning in
    // IngestBuffer's #flushBatch.
    await ch.insert({ table: 'events_dead_letter', format: 'JSONEachRow', values: rows })
  } catch (err) {
    // A failing dead-letter write must never fail the request. The events are
    // already lost; failing the caller would only add a broken site to it.
    //
    // It must not be silent either: events_dead_letter is the *only* record of
    // rejected data, so a persistently failing write makes bad-data debugging
    // impossible with no signal that anything is wrong. IngestBuffer and
    // IngestCounters both surface their failures through an injected onError
    // wired to the Fastify logger; this follows that convention.
    try {
      onError(err, rows)
    } catch {
      // A throwing logger is a bug in the logger, not a reason to fail a
      // request that was already answered correctly.
    }
  }
}

/**
 * What a project's quota looks like from the ingest path's own cache, as of
 * the last time enforcement actually read it. See `quotaSnapshot`.
 */
export interface QuotaUsage {
  projectId: number
  /** Accepted events this month: the persisted figure plus this process's
   *  unflushed tally -- the SAME sum `overQuotaNow` compares. */
  used: number
  quota: number
  /** Epoch ms of the persisted read this is derived from. */
  readAt: number
}

export interface IngestRegistration {
  /**
   * Every quota-carrying project this process has enforced against this
   * month, read PURELY from memory.
   *
   * "Purely from memory" is the requirement, not an implementation detail.
   * #43 asks for a warning before the cliff, and the obvious way to build it
   * -- ask Postgres for current usage when /metrics is scraped -- would add a
   * database read per scrape per project, on an UNAUTHENTICATED endpoint, to
   * report a number the ingest path already has. A scrape must cost nothing.
   *
   * Which is why `quota` is captured at enforcement time rather than looked
   * up here: `ProjectCache.byId` is async and reads Postgres on a miss.
   *
   * Projects with no quota never appear, because they are short-circuited
   * before any usage read (`persistedForQuota`) and so were never recorded.
   * That is the right answer rather than a gap -- `null` is unlimited, and a
   * ratio against unlimited is not a number.
   */
  quotaSnapshot: () => QuotaUsage[]
}

export function registerIngestRoutes(app: FastifyInstance, deps: IngestDeps): IngestRegistration {
  const {
    buffer,
    projects,
    counters,
    cardinality,
    geo,
    readiness,
    ch,
    bindings,
    aliases,
    allowedOrigins = [],
    quotaUsageTtlMs = QUOTA_USAGE_TTL_MS,
  } = deps

  const onDeadLetterError = (err: unknown, rows: DeadLetterRow[]) =>
    app.log.error({ err, rows: rows.length }, 'dead-letter write failed')

  const authenticate = makeAuthenticator(
    readiness,
    WRITE_KEY_HEADER,
    (key) => projects.byWriteKey(key),
    'missing_write_key',
    'invalid_write_key',
  )
  // Gates /v1/alias on the secret server key rather than the public write
  // key — see SERVER_KEY_HEADER's docstring above for why.
  const authenticateServer = makeAuthenticator(
    readiness,
    SERVER_KEY_HEADER,
    (key) => projects.byServerKey(key),
    'missing_server_key',
    'invalid_server_key',
  )

  interface AcceptResult {
    outcome: 'accepted' | 'rejected' | 'bot' | 'overloaded' | 'over_quota'
    deadLetter?: DeadLetterRow
  }

  /**
   * Per-project persisted-usage cache; see QUOTA_USAGE_TTL_MS. Scoped to this
   * registration rather than module scope so two apps in one process (every
   * test file that builds a second app, and the shutdown path) cannot see
   * each other's figures.
   *
   * Only projects that actually have a quota ever get an entry: the `null`
   * short-circuit in `projectOverQuota` returns before this is touched, and
   * an unknown write key is answered 401 before `accept` runs at all — so
   * neither an unlimited project nor a key scanner can grow this map. Its
   * size is bounded by the number of real, quota-carrying projects sending
   * events.
   */
  const usage = new Map<number, { month: string; persisted: number; fetchedAt: number }>()
  /**
   * The quota each project carried when enforcement last read its usage.
   * Kept beside `usage` and written only by `persistedForQuota`, so an
   * entry here always has a counterpart there.
   */
  const quotaInForce = new Map<number, number>()
  // Single-flight per project: without this, the first N concurrent events
  // arriving on a cold or just-expired entry would each start their own
  // Postgres read — reinstating the per-event round trip precisely under the
  // load that makes it expensive.
  const usageInflight = new Map<number, Promise<number>>()
  /**
   * When each project's last usage read FAILED, and the reason failing open
   * is not enough on its own.
   *
   * Single-flight only coalesces requests that overlap a read's latency, and
   * the classic outage — ECONNREFUSED against a Postgres that is down —
   * fails in microseconds with nothing to overlap. Without a negative entry
   * the failure path caches nothing at all (`usage.set` never runs, and
   * `.finally` has already cleared the in-flight promise), so every
   * subsequent event starts its own doomed query: measured at 200 attempts
   * for 200 concurrent events, and 200 again for the next wave. The one
   * mechanism this cache exists to provide would invert to 1:1 exactly when
   * queries are most expensive, driven by a public browser-shipped write key
   * against a `max: 10` pool — a positive feedback loop during an outage.
   *
   * Honoured for the same TTL as a successful read. This is the bound
   * ProjectCache gets from its separate negative map and NEGATIVE_TTL_MS;
   * the shape differs (nothing here is attacker-keyed — an unknown write key
   * is answered 401 long before this code runs) but the obligation is the
   * same.
   *
   * The delete on the success path only keeps this map from holding an entry
   * per project forever; it is NOT load-bearing, and no test can catch its
   * removal. A stale marker ages past one TTL and never blocks a read again,
   * so leaving it merely wastes a map slot. Said plainly because the
   * alternative — "cleared by the next success", which is true — reads like
   * a guarantee something depends on.
   */
  const usageFailedAt = new Map<number, number>()

  async function persistedAcceptedCached(projectId: number): Promise<number> {
    const month = currentMonth()
    const now = Date.now()
    const entry = usage.get(projectId)
    // The fallback for every path that cannot produce a fresh figure: the
    // last known one if it belongs to this month, otherwise zero. Zero
    // leaves this process's own pending tally enforcing the quota on its
    // own, which is the correct floor for a project nothing is known about.
    const fallback = entry?.month === month ? entry.persisted : 0

    // The month test is not decoration: at a month boundary the persisted
    // total resets to zero for the new month, and a figure cached under the
    // old one would keep a project refused into a month it has spent nothing
    // of.
    if (entry && entry.month === month && now - entry.fetchedAt < quotaUsageTtlMs) {
      return entry.persisted
    }

    const failedAt = usageFailedAt.get(projectId)
    if (failedAt !== undefined && now - failedAt < quotaUsageTtlMs) return fallback

    let inflight = usageInflight.get(projectId)
    if (!inflight) {
      inflight = counters
        .persistedAccepted(projectId)
        .then((persisted) => {
          usage.set(projectId, { month, persisted, fetchedAt: Date.now() })
          usageFailedAt.delete(projectId)
          return persisted
        })
        .catch((err: unknown) => {
          usageFailedAt.set(projectId, Date.now())
          // Logged here rather than per awaiting request: one failed query
          // should produce one line, not one per event that was waiting on
          // it. A read that keeps failing still reports itself once per TTL,
          // which is what an operator needs — the quota is no longer being
          // enforced from persisted state at all, and only this line says so.
          app.log.error({ err, projectId }, 'quota usage read failed')
          throw err
        })
        .finally(() => {
          usageInflight.delete(projectId)
        })
      usageInflight.set(projectId, inflight)
    }

    try {
      return await inflight
    } catch {
      // Stale beats unavailable, and unknown beats refusing. A Postgres blip
      // must not turn into a project-wide refusal of events that would
      // otherwise have been well inside their quota; the pending tally keeps
      // counting this process's own accepted events against the limit in the
      // meantime, and the negative entry set above keeps the retry rate at
      // one query per project per TTL rather than one per event.
      return fallback
    }
  }

  /**
   * The quota decision's only asynchronous input, resolved on its own so the
   * decision itself can be synchronous. See `overQuotaNow` for why that
   * split is load-bearing rather than stylistic.
   *
   * Short-circuits BEFORE any usage read. `null` is unlimited and is what
   * every project carries after migration 011, so a usage read here would
   * hand a Postgres round trip per project per TTL to every deployment that
   * has never set a quota — in exchange for a decision `isOverQuota` makes
   * from `quota` alone. The `0` returned in that case is never compared
   * against anything.
   */
  async function persistedForQuota(project: Project): Promise<number> {
    if (project.monthlyEventQuota === null) return 0
    // Captured HERE, on the one path that already holds the project, because
    // /metrics must not do a lookup of its own -- ProjectCache.byId is async
    // and reads Postgres on a miss. A project that loses its quota simply
    // stops being recorded and ages out of `usage` with everything else.
    quotaInForce.set(project.id, project.monthlyEventQuota)
    return persistedAcceptedCached(project.id)
  }

  /**
   * SYNCHRONOUS, and it must stay that way. `counters.pendingAccepted` is
   * read here and `counters.record` is called by the caller a few statements
   * later; an `await` anywhere between the two lets every request that
   * resumes in the same microtask drain decide against the same stale
   * pending figure.
   *
   * That is not theoretical. When this read lived behind `await
   * projectOverQuota(...)`, every request joining one in-flight usage read
   * resumed together, all read `pending` before any of them had recorded,
   * and all were admitted. Measured over real sockets against a quota of 10:
   * a 200-request burst stored 10 events when the read was instant, 26 at
   * 5ms of read latency, and all 200 at 25ms — with `over_quota` at zero, so
   * nothing in `/metrics` or `ingest_counters` showed that the quota had
   * done nothing at all. The magnitude was set by the caller's chosen
   * concurrency and by the read latency, and pool queueing under a flood
   * *is* that latency, so the hole opened widest exactly when it mattered.
   */
  function overQuotaNow(project: Project, persisted: number): boolean {
    const quota = project.monthlyEventQuota
    if (quota === null) return false
    return isOverQuota(persisted, counters.pendingAccepted(project.id), quota)
  }

  async function accept(
    req: FastifyRequest,
    project: Project,
    raw: unknown,
  ): Promise<AcceptResult> {
    const projectId = project.id

    // PARSE BEFORE THE BOT CHECK, which is the reverse of the original order
    // and is forced: the signal that a server-side SDK is not a crawler
    // lives in `context.library`, and that cannot be read before the payload
    // is parsed (#29).
    //
    // The cost is real and was accepted deliberately: crawler traffic is now
    // Zod-parsed before being dropped, where it used to be refused on a
    // header comparison. The payload is a small object and the request has
    // already paid for HTTP handling and a project-cache lookup, so this is
    // judged affordable -- but it is the first thing to revisit if ingest
    // CPU ever becomes a problem.
    //
    // The bigger cost: a MALFORMED payload from a crawler now writes a row
    // to `events_dead_letter`, where before it cost one header comparison
    // and zero writes. Per REQUEST rather than per row is the wrong unit to
    // cost it in: `BatchPayload` allows up to 500 items and each malformed
    // one dead-letters on its own, so ONE `/v1/batch` request can write up
    // to 500 rows. Unauthenticated junk traffic can now put load on the
    // table whose signal value the rest of this file defends. Kept anyway,
    // for two reasons. The growth is bounded, not unbounded:
    // `events_dead_letter` carries a 30-day TTL (see
    // `received_at` in `002_events.sql`), so it self-cleans rather than
    // accumulating forever. And the obvious suppression -- skip the dead
    // letter when the UA looks like a bot -- cannot work here: a parse
    // failure means `context.library` was never read, so that check cannot
    // tell a crawler from the server-side SDK author whose malformed
    // request is exactly what this dead letter exists to help debug.
    const parsed = IngestPayload.safeParse(raw)
    if (!parsed.success) {
      counters.record(projectId, 'rejected')
      return {
        outcome: 'rejected',
        deadLetter: buildDeadLetterRow(projectId, 'validation_failed', parsed.error.message, raw),
      }
    }

    // A declared server-side SDK is never a bot, whatever its HTTP client
    // announces -- `python-requests`, `okhttp` and `curl/` are all in
    // BOT_TOKENS, so without this every server-side SDK is swallowed on its
    // first request.
    //
    // Keyed on server-side names specifically, NOT on "declares a library at
    // all": a crawler executing JS on an instrumented page sends exactly
    // what the browser SDK sends, so exempting the browser library would
    // defeat the filter outright.
    //
    // Not a security control, and not meant to be. The write key is public,
    // so a hostile client can already send `Mozilla/5.0` and be
    // indistinguishable from a visitor. This filter removes incidental
    // traffic -- crawlers, uptime monitors, link previews -- and none of
    // those declare a library.
    // WHICH user agent describes the visitor, which is not always the one on
    // the request. For a browser they are the same string by construction. For
    // a server-side SDK the transport header is its HTTP client's own name and
    // says nothing about anyone; the visitor's is in `context.user_agent`, if
    // the caller forwards it.
    //
    // Only consulted for a DECLARED server-side library. A browser payload
    // also carries `context.user_agent`, and preferring it there would let any
    // page choose its own device/os/browser and its own bot verdict -- which
    // is a change to what the filter means for the traffic it was built for.
    // A server-side caller is already exempt from the transport check, so
    // reading its forwarded value can only ever filter MORE, never less
    // (#152).
    const transportUa = req.headers['user-agent']
    const declaredServerSdk = isServerSideLibrary(parsed.data.context.library?.name)
    const visitorUa = declaredServerSdk
      ? (parsed.data.context.user_agent ?? transportUa)
      : transportUa

    // A declared server-side SDK is never judged on what its HTTP client
    // announces -- `python-requests`, `okhttp` and `curl/` are all in
    // BOT_TOKENS, so without that exemption every server-side SDK is swallowed
    // on its first request (#29).
    //
    // But it IS judged on the visitor agent it forwards. A backend honestly
    // passing `Googlebot/2.1` used to have that crawler stored as a person,
    // counted in every segment and funnel. That is the cooperative case, not
    // the forgery the design knowingly waives, and it is the one the filter
    // exists to catch.
    //
    // A declared SDK that forwards NOTHING stays exempt: `visitorUa` falls
    // back to the transport header, but the guard below only reaches `isBot`
    // for a declared SDK when it actually supplied a value. Nothing regresses
    // for an SDK that does not forward.
    //
    // Keyed on server-side names specifically, NOT on "declares a library at
    // all": a crawler executing JS on an instrumented page sends exactly what
    // the browser SDK sends, so exempting the browser library would defeat the
    // filter outright.
    //
    // Not a security control, and not meant to be. The write key is public, so
    // a hostile client can already send `Mozilla/5.0` and be indistinguishable
    // from a visitor. This removes incidental traffic -- crawlers, uptime
    // monitors, link previews -- and none of those declare a library.
    const botVerdict = declaredServerSdk
      ? parsed.data.context.user_agent != null && isBot(parsed.data.context.user_agent)
      : isBot(transportUa)
    if (botVerdict) {
      counters.record(projectId, 'bot')
      return { outcome: 'bot' }
    }

    const limit = checkLimits(parsed.data, cardinality, projectId)
    if (!limit.ok) {
      counters.record(projectId, 'throttled')
      return {
        outcome: 'rejected',
        deadLetter: buildDeadLetterRow(projectId, limit.reason, limit.detail, raw),
      }
    }

    // AFTER validation and the cardinality check, so a malformed or
    // throttled event is counted as `rejected`/`throttled` and never as
    // `over_quota` — the security property the whole design turns on is that
    // only *accepted* events move a project toward its limit (quota.ts), and
    // a check placed earlier would let a flood of nonsense exhaust a
    // project's quota while storing no events at all. BEFORE buffer.add and
    // before cardinality.observe, so a refused event occupies neither buffer
    // memory nor a slot in the project's tracked cardinality.
    //
    // The await is here, on its own, and the decision is below it — see
    // `overQuotaNow`.
    const persisted = await persistedForQuota(project)

    // ─────────────────────────────────────────────────────────────────────
    // ATOMIC BLOCK — NO `await` FROM HERE TO `record(projectId, 'accepted')`
    //
    // `overQuotaNow` reads this project's pending tally and the record at
    // the bottom updates it. Node runs each resumed continuation to
    // completion, so with no suspension point between them a burst of
    // concurrent requests is decided one at a time, each seeing the record
    // the one before it made. Introduce an `await` anywhere in this stretch
    // — a lookup, a log flush, an enrichment — and the whole burst decides
    // against the same figure again.
    //
    // Every call this block makes is synchronous today, and all of them are
    // load-bearing, so here is the complete list rather than a sample:
    // `IngestCounters.pendingAccepted` and `isOverQuota` (inside
    // `overQuotaNow`), `IngestCounters.record` (all three calls below, not
    // only the last), `toEventRow`, `GeoResolver.resolve`, `parseUserAgent`,
    // `IngestBuffer.add`, and `CardinalityTracker.observe`. Making any one of
    // them async reopens the defect. Two of those are realistic — a GeoIP
    // lookup behind `resolve`, or a buffer that awaits — and both feed
    // positions typed as non-promises, so the change would not typecheck
    // without adding a visible `await` here. `overQuotaNow` is declared
    // `function`, not `async`, so the decision half is compiler-enforced.
    // ─────────────────────────────────────────────────────────────────────
    if (overQuotaNow(project, persisted)) {
      counters.record(projectId, 'over_quota')
      // No dead letter: the event is well-formed and within every limit but
      // this one. events_dead_letter is the record of data that could not be
      // parsed, and filling it with valid events refused by policy would
      // bury the bad-data signal it exists to carry.
      return { outcome: 'over_quota' }
    }

    const row = toEventRow({
      projectId,
      payload: parsed.data,
      now: new Date(),
      trusted: false,
      geo: geo.resolve(req.ip),
      // The visitor's agent, not the transport's -- so a server-side SDK that
      // forwards it stops recording `unknown` for device, os and browser
      // (#152). Identical to the transport header for every browser payload.
      ua: parseUserAgent(visitorUa),
    })

    const outcome = buffer.add(row)
    if (outcome === 'overloaded') {
      counters.record(projectId, 'throttled')
      return { outcome: 'overloaded' }
    }

    cardinality.observe(projectId, row.event_name, [
      ...Object.keys(row.properties),
      ...Object.keys(row.properties_num),
    ])
    counters.record(projectId, 'accepted')
    // ───────────────────────── end of the atomic block ─────────────────────
    // Awaiting again is safe from here: this event's own record is already
    // in the pending tally, so the next request to be decided sees it.

    // identify carrying both ids ties a device to a person. Only identify
    // requires user_id, so this branch is unreachable for track/page, and
    // anonymous_id is the one optional field left to check. Binds at the
    // event's own (clamped) timestamp — row.timestamp, not `new Date()` —
    // because a late-delivered identify must bind at the instant it
    // happened, not the instant it arrived; identity resolution is
    // time-ranged and depends on this (see IdentityBindings.bind).
    if (parsed.data.type === 'identify' && parsed.data.anonymous_id) {
      try {
        await bindings.bind(
          projectId,
          parsed.data.anonymous_id,
          parsed.data.user_id,
          parseChDateTime(row.timestamp),
        )
      } catch (err) {
        // The event is already accepted into the buffer. A failing binding
        // write must not turn a good, already-accepted event into an error
        // for the customer's site — same rule 1 reasoning as
        // writeDeadLetters above. It must not be silent either, so this
        // follows the same onError-through-the-Fastify-logger convention.
        app.log.error({ err }, 'identity binding write failed')
      }
    }

    return { outcome: 'accepted' }
  }

  function single(type: 'track' | 'identify' | 'page') {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const project = await authenticate(req, reply)
      if (!project) return

      const body = { ...(req.body as Record<string, unknown>), type }
      const result = await accept(req, project, body)
      // Written BEFORE the outcome is examined, which is safe only while
      // every result carrying a dead letter has outcome 'rejected' --
      // 'over_quota' and 'overloaded' both return without one. A future
      // outcome that carries a dead letter would make a 429 or a 503 pay for
      // a ClickHouse write first, which is the opposite of what a refusal
      // under load should cost; move this below the outcome checks then.
      if (result.deadLetter) await writeDeadLetters(ch, [result.deadLetter], onDeadLetterError)

      if (result.outcome === 'overloaded') {
        return reply.code(503).header('retry-after', '5').send({ error: 'overloaded' })
      }
      if (result.outcome === 'over_quota') {
        // 429, and deliberately WITHOUT retry-after. 503 above means "the
        // buffer is full, come back shortly" and carries the header to say
        // when; a quota refusal holds until the month rolls over or an
        // operator raises the limit, so advertising a retry time would
        // invite exactly the retry storm this refusal exists to stop. It is
        // also the one ingest response that is not 202: unlike bad data,
        // this is a condition the caller's operator can act on, and silently
        // swallowing it would make a project's events vanish with the only
        // evidence buried in a counter.
        return reply.code(429).send({ error: 'quota_exceeded' })
      }
      // Bad data still returns 202: a tracking endpoint that errors breaks the
      // customer's site, and that loses trust permanently.
      return reply.code(202).send({ status: 'accepted' })
    }
  }

  // Each write-key route gets its OWN encapsulated plugin, registered with
  // its own exact `prefix`, rather than one shared plugin covering all four.
  //
  // That single-shared-plugin shape looks right and is NOT: @fastify/cors is
  // wrapped in fastify-plugin, and fastify-plugin's whole purpose is to
  // *skip* creating a new encapsulation context — the plugin's decorators
  // and hooks attach directly to whatever instance registered it. Fastify
  // hooks (onRequest etc.) do stay properly scoped to that instance's own
  // routes this way, confirmed by probing it directly. But @fastify/cors
  // also unconditionally registers a wildcard `OPTIONS *` route to answer
  // preflight (see its index.js), and Fastify's HTTP router (find-my-way) is
  // ONE shared router for the whole app — a method+path match, not an
  // encapsulation-scoped one. A bare `OPTIONS *` therefore becomes the
  // fallback for *any* path in the entire app that has no OPTIONS route of
  // its own, e.g. GET /v1/segments or POST /v1/alias — exactly the
  // server-key routes this task exists to keep CORS off of. Registering the
  // plugin once under a single parent context does not avoid this; it was
  // tried and it leaks (see cors.test.ts's "does NOT enable CORS on the
  // server-key routes" — that failure is what surfaced this).
  //
  // Registering with a `prefix` makes Fastify prepend that prefix to every
  // route the plugin declares, including @fastify/cors's own wildcard — so
  // each instance's wildcard becomes e.g. `OPTIONS /v1/track*` rather than
  // a bare `OPTIONS *`, and can no longer answer for /v1/segments or
  // /v1/alias. The trade-off: it also answers for any *other* path sharing
  // that prefix (e.g. a hypothetical /v1/trackXYZ) — harmless today since no
  // such route exists, but worth knowing if one ever gets added.
  function registerIngestRoute(
    path: string,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ): void {
    app.register(
      async (instance) => {
        await instance.register(cors, {
          // Empty allowedOrigins means any origin — see config.ts's
          // allowedOrigins docstring for why that is the right default and
          // why this is a product limit, not a security boundary.
          origin: allowedOrigins.length === 0 ? true : allowedOrigins,
          methods: ['POST'],
          // Explicit, not the default reflect-the-request-headers behaviour:
          // the SDK's actual request carries content-type and the write-key
          // header, and this list is what makes a dropped entry here break
          // the preflight rather than silently keep working via reflection.
          allowedHeaders: ['content-type', WRITE_KEY_HEADER],
          // retry-after is NOT one of the CORS-safelisted response headers a
          // browser exposes to script by default — without this, a browser's
          // `res.headers.get('retry-after')` on a real 503 is always `null`,
          // even though the header is on the wire. transport.ts reads exactly
          // that header to time its retry; without exposing it, the SDK falls
          // back to its own backoff instead of the server's advice, retrying
          // an already-saturated ingest far sooner than told (or, the other
          // direction, capped at the exponential ceiling when the server
          // asked for longer). This is the one line where the two halves —
          // this plugin and transport.ts's `res.headers.get('retry-after')`
          // — actually meet, and nothing else in the suite can see it: the
          // SDK's own retry-after tests use a fake fetchImpl whose
          // headers.get always works, browser CORS restrictions and all.
          exposedHeaders: ['retry-after'],
          // The spec default preflight cache (with no max-age sent) is 5
          // seconds in most browsers, and the SDK flushes every
          // FLUSH_INTERVAL_MS (transport.ts) — 5,000ms by default. Without
          // this, a steadily-tracking page pays a fresh OPTIONS before
          // essentially every POST, doubling request volume against the
          // busiest endpoint in the product for the life of every session.
          // 600s is comfortably longer than any realistic flush interval;
          // the allowlist itself only changes on a server restart, which
          // invalidates any browser's cached preflight along with it (a new
          // process, new listener).
          maxAge: 600,
        })
        // '' registers at exactly `path` (the plugin's prefix) rather than
        // `path + '/'` — see Fastify's own docs on prefixing.
        instance.post('', handler)
      },
      { prefix: path },
    )
  }

  registerIngestRoute('/v1/track', single('track'))
  registerIngestRoute('/v1/identify', single('identify'))
  registerIngestRoute('/v1/page', single('page'))

  registerIngestRoute('/v1/batch', async (req, reply) => {
    const project = await authenticate(req, reply)
    if (!project) return

    const parsed = BatchPayload.safeParse(req.body)
    if (!parsed.success) {
      counters.record(project.id, 'rejected')
      await writeDeadLetters(
        ch,
        [buildDeadLetterRow(project.id, 'validation_failed', parsed.error.message, req.body)],
        onDeadLetterError,
      )
      return reply.code(202).send({ accepted: 0, rejected: 1, throttled: 0, over_quota: 0, bot: 0 })
    }

    const batch = parsed.data.batch
    let accepted = 0
    let rejected = 0
    let overQuota = 0
    let bot = 0
    const deadLetters: DeadLetterRow[] = []

    for (let i = 0; i < batch.length; i++) {
      const result = await accept(req, project, batch[i])
      if (result.deadLetter) deadLetters.push(result.deadLetter)

      if (result.outcome === 'overloaded') {
        // Stop immediately rather than folding this into `rejected`: buffer
        // saturation is transient backpressure, not bad data, and the single
        // endpoint already answers the identical condition with 503. Folding
        // it into `rejected` here would tell the SDK to drop these events
        // forever instead of retrying them.
        //
        // Retrying the whole batch is safe because message_id becomes
        // event_id and every query deduplicates by event_id — NOT because the
        // storage engine collapses the replayed rows. `events` is a
        // ReplacingMergeTree, but it only collapses when the entire ORDER BY
        // tuple matches: (project_id, timestamp, anonymous_id, event_id). When
        // a client omits `timestamp`, row.ts fills it with server wall-clock
        // at receipt, so a retry seconds later has a different sort key and
        // persists as a second physical row forever. The counts stay correct;
        // the storage does not. A client that sends an explicit `timestamp`
        // and replays it unchanged does get engine-level collapsing — see the
        // API section of README.md, and the
        // `retried event with a server-assigned timestamp` test in
        // schema-clickhouse.test.ts, which pins this behaviour honestly.
        await writeDeadLetters(ch, deadLetters, onDeadLetterError)
        // accept() already recorded item i itself as 'throttled'; the
        // remaining batch.length - i - 1 items were never attempted at all
        // (the loop stops here) and so never went through accept() to be
        // counted. Without this, the counter — and the Postgres quota table
        // it flushes into — would undercount by up to 500x under exactly the
        // saturation condition an operator relies on this metric to catch.
        // When the overloaded item is the batch's last (i === batch.length -
        // 1), this is record(..., 0) — a harmless zero-delta call that folds
        // into IngestCounters' pending tally and no-ops through to Postgres.
        counters.record(project.id, 'throttled', batch.length - i - 1)
        const throttled = batch.length - i
        return reply
          .code(503)
          .header('retry-after', '5')
          .send({ accepted, rejected, throttled, over_quota: overQuota, bot })
      }

      if (result.outcome === 'accepted') accepted++
      // Counted apart from `rejected`, and the loop keeps going. Apart,
      // because `rejected` means bad data the sender should fix, while these
      // events were perfectly good and would be stored next month unchanged.
      // Keeps going, because /v1/batch's contract is a 202 carrying the tally
      // — unlike the `overloaded` branch above, which stops because the
      // server is saturated and the remaining items are worth retrying.
      else if (result.outcome === 'over_quota') overQuota++
      else if (result.outcome === 'bot') bot++
      else rejected++
    }

    await writeDeadLetters(ch, deadLetters, onDeadLetterError)
    // throttled, over_quota and bot are always present, even at 0: an SDK
    // parsing a stable shape shouldn't need to special-case a field's absence
    // versus its value.
    return reply.code(202).send({ accepted, rejected, throttled: 0, over_quota: overQuota, bot })
  })

  interface AliasBody {
    from_user_id?: unknown
    to_user_id?: unknown
  }

  // Not an ingest endpoint: aliasing performs the mutation directly rather
  // than accepting-then-processing an event, so — unlike /v1/track,
  // /v1/identify, /v1/page and /v1/batch — a malformed request here is a
  // genuine client error, answered with a real 4xx rather than a
  // universal 202.
  app.post('/v1/alias', async (req, reply) => {
    const project = await authenticateServer(req, reply)
    if (!project) return

    // req.body is undefined for a bodyless request (unlike the ingest
    // routes above, which always spread it into an object); guard before
    // indexing rather than letting that throw and fall through to the
    // generic /v1/* 503 handler for what is really a 400.
    const body = (req.body ?? {}) as AliasBody
    const fromUserId = body.from_user_id
    const toUserId = body.to_user_id
    if (
      typeof fromUserId !== 'string' ||
      fromUserId.length === 0 ||
      typeof toUserId !== 'string' ||
      toUserId.length === 0
    ) {
      return reply.code(400).send({ error: 'invalid_body' })
    }

    const result = await aliases.alias(project.id, fromUserId, toUserId)
    return reply.code(200).send({ status: result })
  })

  return {
    quotaSnapshot: () => {
      const month = currentMonth()
      const out: QuotaUsage[] = []
      for (const [projectId, quota] of quotaInForce) {
        const entry = usage.get(projectId)
        // A stale entry is dropped rather than reported. `usage` is keyed by
        // month, and reporting last month's persisted count against this
        // month's quota would be a number that looks like a ratio and is not
        // one -- worse than reporting nothing, because an operator would
        // alert on it.
        if (!entry || entry.month !== month) continue
        // Belt and braces on a value that reaches a DIVISION. Both the API
        // (project/routes.ts refuses 0) and `isOverQuota` (throws on it)
        // already guarantee a positive quota, so this cannot fire today --
        // but if it ever did, `used / 0` is `Infinity`, and JavaScript
        // serialises that as the literal `Infinity`, which is NOT valid
        // Prometheus exposition (it wants `+Inf`). One malformed line makes a
        // scraper reject the WHOLE body, so a bad quota would take every
        // other metric down with it. Skipping costs a series nobody can use.
        if (!(quota > 0)) continue
        out.push({
          projectId,
          // The SAME sum enforcement compares. Reporting only the persisted
          // figure would read low by up to a whole flush interval, which is
          // exactly the window in which a project crosses its limit -- so the
          // gauge would be most wrong at the moment it matters most.
          used: entry.persisted + counters.pendingAccepted(projectId),
          quota,
          readAt: entry.fetchedAt,
        })
      }
      return out
    },
  }
}
