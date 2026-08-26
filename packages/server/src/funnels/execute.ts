import type { CompiledQuery, FunnelResult, FunnelStep, LevelRow } from '@lyraflow/core'
import { summarise } from '@lyraflow/core'
import type { ClickHouseClient } from '@lyraflow/db'
import type { MemberRow } from '../segments/cache.js'
import { runCompiled } from '../segments/execute.js'

/**
 * ClickHouse returns every numeric as a string over JSONEachRow, so the
 * histogram arrives as text and is widened here rather than in `summarise`,
 * which stays a pure function over numbers and needs no database to test.
 *
 * `Record<string, string>` rather than a fixed shape because the projection
 * carries one `optional_<j>` column per optional step -- a count known from
 * the definition, not from the type.
 */
type HistogramRow = Record<string, string>

/**
 * Runs a compiled funnel and turns its histogram into per-step counts.
 *
 * The ClickHouse ceilings and the timeout mapping come from
 * `runCompiled` — the same wrapper the segment engine uses. A funnel is
 * reachable by the same authenticated caller and scans the same table, so a
 * second timeout policy here would be one more thing to keep in agreement.
 */
export async function runFunnel(opts: {
  client: ClickHouseClient
  compiled: CompiledQuery
  steps: FunnelStep[]
}): Promise<FunnelResult> {
  const optionalCount = opts.steps.filter((s) => s.optional === true).length
  const rows = await runCompiled<HistogramRow>(opts.client, opts.compiled)
  const levels: LevelRow[] = rows.map((r) => ({
    level: Number(r.level),
    people: Number(r.people),
    partial: Number(r.partial),
    optionalReached: Array.from({ length: optionalCount }, (_, j) => {
      const raw = r[`optional_${j}`]
      // THROWN, not defaulted to zero. A missing column means the compiler
      // and this runner disagree about how many optional steps the
      // definition has, and a silent zero would report every optional step
      // as reached by nobody -- a plausible number, which is the worst kind
      // of wrong one.
      if (raw === undefined) {
        throw new Error(
          `funnel histogram is missing optional_${j}; compiled query and definition disagree`,
        )
      }
      return Number(raw)
    }),
  }))
  return summarise(levels, opts.steps)
}

/** One person who reached a step and stopped there. */
export interface DropoffRow {
  person_id: string
  entered_at: string
}

/**
 * One page of the people who dropped at a step. Goes through the same
 * ceilings as every other compiled query — see `runCompiled`.
 */
export async function runDropoff(opts: {
  client: ClickHouseClient
  compiled: CompiledQuery
}): Promise<DropoffRow[]> {
  return runCompiled<DropoffRow>(opts.client, opts.compiled)
}

/**
 * One member-shaped row from the `select: 'members'` projection — the same
 * shape a segment members walk returns (see `MemberRow`), plus `entered_at`,
 * which only a funnel's per-person pass produces. Reusing `MemberRow` rather
 * than declaring a parallel type is what lets `MemberList` render this
 * unchanged.
 */
export interface PeopleRow extends MemberRow {
  entered_at: string
}

/**
 * One page of the people who reached, or stopped at, a funnel step —
 * traits and all. Goes through the same ceilings as every other compiled
 * query — see `runCompiled`. `person_count` for the SAME `peopleAt` is a
 * separate query (`select: 'count'`); this runner only ever sees rows, not
 * a count, because a `'members'`-shaped compile has no `person_count` column.
 */
export async function runPeople(opts: {
  client: ClickHouseClient
  compiled: CompiledQuery
}): Promise<PeopleRow[]> {
  return runCompiled<PeopleRow>(opts.client, opts.compiled)
}
