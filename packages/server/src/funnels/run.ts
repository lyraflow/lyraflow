import {
  type CostWarning,
  type Cursor,
  type FunnelResult,
  type FunnelStep,
  Params,
  type SegmentQuery,
  compileFunnel,
  compileSegment,
} from '@lyraflow/core'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import { SegmentStore, StoredTreeError } from '../segments/store.js'
import { describeWindow } from './duration.js'
import { runFunnel } from './execute.js'

export interface FunnelRunDeps {
  ch: ClickHouseClient
  pg: Pool
  /** The configured ClickHouse database; the dictionaries live in it. */
  database: string
}

/**
 * `since`/`until` are per-run, never stored — the window belongs to the
 * funnel, the range to the question being asked this time. Moved from
 * `routes.ts`'s `DEFAULT_RANGE_MS`; `resolveRange` in that file still
 * defaults a bare `POST /v1/funnels/:id/run` to this span, and
 * `COMPILE_PROBE` still measures against it.
 */
export const FUNNEL_DEFAULT_RANGE_MS = 7 * 86_400_000

/** The funnel shape `compileFor` and `execute` need — the fields common to
 *  a stored funnel and an ad-hoc preview definition, nothing route-specific. */
export type FunnelRunFunnel = {
  steps: FunnelStep[]
  windowSeconds: number
  segmentId: number | null
}

/**
 * What a funnel is compiled FOR at one particular step — `/dropoff` and
 * `/people` pass this to restrict the compiled query to the population at
 * that step; `execute` (a plain run) omits it entirely. Named and exported
 * here — it used to be `compileFor`'s inline fifth-parameter type — so a
 * later stored-report runner can build one without re-deriving its shape.
 */
export type PeopleAt = {
  step: number
  mode: 'reached' | 'dropped' | 'skipped'
  select: 'ids' | 'members' | 'count'
  cursor?: Cursor
}

/**
 * `execute`'s return, minus `result` — exactly the object `/preview` and
 * `/:id/run` send as their response body (both strip `result` themselves,
 * `/preview` because it never had a stored funnel to cache against, `/:id/
 * run` after reading `result.entered`/`result.converted` for `recordRun`).
 */
export interface FunnelRunBody {
  entered: number
  converted: number
  conversion_rate: number
  steps: FunnelResult['steps']
  partial_window_entrants: number
  range: { since: string; until: string }
  as_of: string
  warnings: CostWarning[]
}

/**
 * The two operations `routes.ts` used to close over `segments`, `ch` and
 * `database` for. Lifted out so a shared dashboard can compile and run a
 * STORED funnel through exactly this code, with no HTTP request in the
 * loop — the route parses and maps errors to a status code, this runs.
 */
export interface FunnelRunner {
  compileFor(
    project: { id: number },
    funnel: FunnelRunFunnel,
    range: { since: Date; until: Date },
    now: Date,
    peopleAt?: PeopleAt,
  ): Promise<{ compiled: ReturnType<typeof compileFunnel>; extraWarnings: CostWarning[] }>
  execute(
    project: { id: number },
    funnel: FunnelRunFunnel,
    range: { since: Date; until: Date },
  ): Promise<FunnelRunBody & { result: FunnelResult }>
}

/**
 * The range as sent on the wire — ISO strings, echoed in every funnel
 * response so a defaulted window is never silently unstated. Not part of
 * `FunnelRunner`: it takes no deps, and `/dropoff` and `/people` in
 * `routes.ts` format their own response ranges through it directly, the
 * same shape `execute` below returns for `/preview` and `/:id/run`.
 */
export function rangeWire(range: { since: Date; until: Date }): { since: string; until: string } {
  return { since: range.since.toISOString(), until: range.until.toISOString() }
}

/**
 * Builds the funnel runner over one set of deps — `ch`, `pg` and
 * `database`, the same three `registerFunnelRoutes` closed `compileFor`
 * and `execute` over before this move. Constructs its own `SegmentStore`
 * from `pg`; `registerFunnelRoutes` keeps a separate one for the routes
 * that still use it directly (`resolveRange` and the CRUD handlers do not
 * touch segments at all, but the store itself is cheap to construct twice
 * and sharing one across a route-scope object and this runner would be the
 * kind of implicit coupling this move is meant to remove).
 */
export function makeFunnelRunner(deps: FunnelRunDeps): FunnelRunner {
  const { ch, pg, database } = deps
  const segments = new SegmentStore(pg)

  /**
   * Compiles a funnel, resolving a segment restriction if it has one.
   *
   * ONE `Params` is threaded through both compilations. Names are positional,
   * so compiling the segment separately and merging its map afterwards would
   * silently overwrite the funnel's own `p0`.
   *
   * A `segment_id` naming a segment that no longer exists is not an error: the
   * funnel runs over everyone and says so. Deleting a segment must not break
   * every report built on it, but it does change what those reports mean, and
   * a silent widening of the population is the worst way to learn that.
   */
  async function compileFor(
    project: { id: number },
    funnel: FunnelRunFunnel,
    range: { since: Date; until: Date },
    now: Date,
    peopleAt?: PeopleAt,
  ): Promise<{ compiled: ReturnType<typeof compileFunnel>; extraWarnings: CostWarning[] }> {
    const params = new Params()
    const extraWarnings: CostWarning[] = []
    let segmentPersonSql: string | undefined

    if (funnel.segmentId !== null) {
      let segment = null
      try {
        segment = await segments.get(project.id, funnel.segmentId)
      } catch (err) {
        // A segment whose stored tree no longer parses cannot restrict
        // anything. Same treatment as a deleted one: run wide, and say why.
        if (!(err instanceof StoredTreeError)) throw err
      }
      if (segment) {
        segmentPersonSql = compileSegment({
          query: { ast_version: segment.astVersion, filter: segment.filter } as SegmentQuery,
          projectId: project.id,
          database,
          now,
          select: 'persons',
          params,
        }).sql
      } else {
        extraWarnings.push({
          path: 'segment_id',
          reason: `segment ${funnel.segmentId} no longer exists or cannot be read, so this funnel ran over everyone rather than the population it names`,
        })
      }
    }

    const compiled = compileFunnel({
      definition: {
        steps: funnel.steps,
        window_seconds: funnel.windowSeconds,
        segment_id: funnel.segmentId,
      },
      projectId: project.id,
      database,
      range,
      now,
      params,
      segmentPersonSql,
      peopleAt,
    })
    return { compiled, extraWarnings }
  }

  /**
   * The single derivation both run paths use.
   *
   * #21 was that the saved-segment run response omitted warnings the ad-hoc
   * preview returns. Having two entry points is fine; computing the same
   * thing twice is what drifts, so `/preview` and `/:id/run` both end here
   * and neither assembles a response of its own. `/v1/segments/preview` and
   * `/v1/segments/:id/preview` now follow the same shape via `runTree` in
   * segments/routes.ts.
   */
  async function execute(
    project: { id: number },
    funnel: FunnelRunFunnel,
    range: { since: Date; until: Date },
  ): Promise<FunnelRunBody & { result: FunnelResult }> {
    const now = new Date()
    const { compiled, extraWarnings } = await compileFor(project, funnel, range, now)
    const result = await runFunnel({ client: ch, compiled, steps: funnel.steps })
    const warnings = [...compiled.warnings, ...extraWarnings]
    if (result.partial_window_entrants > 0) {
      warnings.push({
        path: 'range',
        reason: `${result.partial_window_entrants} of the people who entered did so too recently to have had the full ${describeWindow(funnel.windowSeconds)} window, and can still convert`,
      })
    }
    return {
      entered: result.entered,
      converted: result.converted,
      conversion_rate: result.conversion_rate,
      steps: result.steps,
      partial_window_entrants: result.partial_window_entrants,
      range: rangeWire(range),
      as_of: now.toISOString(),
      warnings,
      result,
    }
  }

  return { compileFor, execute }
}
