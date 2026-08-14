/**
 * `lyraflow funnels` — list, run, preview and drill into saved funnels.
 *
 * Until there is a web UI this is how anyone reads a funnel, so it is part of
 * the feature rather than a convenience over it. The shape follows
 * `segments` in catalog.ts: `--json` keeps stdout a pure record stream and the
 * summary goes to stderr, because a caveat that corrupts a JSON pipeline is
 * worse than no caveat and a caveat only present in the JSON is one a human
 * reading the table never sees.
 */

import { readFile } from 'node:fs/promises'
import { UsageError, parseCommandArgs, resolveInstant } from '../args.js'
import type { CommandContext } from '../context.js'
import { type Column, type Mode, emitObject, emitRecords, resolveMode } from '../output.js'
import {
  UNIVERSAL_FLAGS,
  assertWindowNotInverted,
  checkNoPositionals,
  checkStrayFlags,
  reportCommandFailure,
  reportParseFailure,
  reportUsageError,
} from './command-support.js'

interface FunnelRecord {
  id: number
  name: string
  window_seconds: number
  segment_id: number | null
  stale: boolean
  last_entered: number | null
  last_converted: number | null
  last_evaluated_at: string | null
  steps: { event: string }[] | null
}

interface StepRecord {
  index: number
  event: string
  people: number
  from_previous: number
  from_start: number
}

interface RunResponse {
  entered: number
  converted: number
  conversion_rate: number
  steps: StepRecord[]
  partial_window_entrants: number
  range: { since: string; until: string }
  as_of: string
  warnings: { path: string; reason: string }[]
}

interface DropoffResponse {
  step: number
  people: { person_id: string; entered_at: string }[]
  next_cursor: string | null
  window_exhausted: boolean
  range: { since: string; until: string }
  as_of: string
}

const FUNNELS_USAGE =
  'usage: lyraflow funnels <list|run <name>|preview --file <path>|dropoff <name> --step N> ' +
  '[--since <t>] [--until <t>] [--json|--human]'

const pct = (n: number) => `${(n * 100).toFixed(1)}%`

const FUNNELS_COLUMNS: Column[] = [
  { header: 'ID', get: (f: FunnelRecord) => String(f.id) },
  { header: 'NAME', get: (f: FunnelRecord) => f.name },
  {
    header: 'STEPS',
    // A stale row carries no steps; saying so beats printing `0`, which reads
    // as a funnel with none rather than as one that could not be parsed.
    get: (f: FunnelRecord) => (f.steps === null ? 'stale' : String(f.steps.length)),
  },
  { header: 'WINDOW', get: (f: FunnelRecord) => `${f.window_seconds}s` },
  {
    header: 'SEGMENT',
    get: (f: FunnelRecord) => (f.segment_id === null ? '-' : String(f.segment_id)),
  },
  {
    // Always rendered WITH its timestamp: the stored count is a cache, not a
    // fact, and a bare number would read as current.
    header: 'LAST RUN',
    get: (f: FunnelRecord) =>
      f.last_evaluated_at === null
        ? 'never'
        : `${f.last_converted}/${f.last_entered} at ${f.last_evaluated_at}`,
  },
] as Column[]

const STEP_COLUMNS: Column[] = [
  { header: 'STEP', get: (s: StepRecord) => String(s.index) },
  { header: 'EVENT', get: (s: StepRecord) => s.event },
  { header: 'PEOPLE', get: (s: StepRecord) => String(s.people) },
  { header: 'FROM PREV', get: (s: StepRecord) => pct(s.from_previous) },
  { header: 'FROM START', get: (s: StepRecord) => pct(s.from_start) },
] as Column[]

const DROPOFF_COLUMNS: Column[] = [
  { header: 'PERSON', get: (r: { person_id: string }) => r.person_id },
  { header: 'ENTERED', get: (r: { entered_at: string }) => r.entered_at },
] as Column[]

/**
 * Resolves `--since`/`--until` into the absolute instants the API takes.
 *
 * Omitted entirely, both are left out of the request so the SERVER applies its
 * documented default (the last seven days) — resolving a default here as well
 * would put two defaults in the product, and the one that drifted would be
 * invisible.
 */
function resolveWindow(
  flags: Record<string, string | boolean>,
  now: Date,
): { since?: string; until?: string } {
  const since =
    typeof flags.since === 'string' ? resolveInstant(flags.since, now, '--since') : undefined
  const until =
    typeof flags.until === 'string' ? resolveInstant(flags.until, now, '--until') : undefined
  assertWindowNotInverted(since, until)
  return {
    ...(since ? { since: since.toISOString() } : {}),
    ...(until ? { until: until.toISOString() } : {}),
  }
}

/** Warnings go to stderr in both modes. See this module's docstring. */
function emitWarnings(warnings: { path: string; reason: string }[], ctx: CommandContext): void {
  for (const w of warnings) ctx.writeErr(`warning: ${w.path}: ${w.reason}\n`)
}

async function runList(mode: Mode, ctx: CommandContext): Promise<number> {
  try {
    const res = await ctx.client.get<{ funnels: FunnelRecord[] }>('/v1/funnels')
    emitRecords(res.funnels, mode, FUNNELS_COLUMNS, ctx.write)
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}

/**
 * Resolves a funnel NAME to its id. `UNIQUE (project_id, name)` makes that
 * unambiguous, and an operator running a weekly report should not have to
 * remember that signup is funnel 3.
 */
async function idForName(name: string, ctx: CommandContext): Promise<number> {
  const res = await ctx.client.get<{ funnels: FunnelRecord[] }>('/v1/funnels')
  const found = res.funnels.find((f) => f.name === name)
  // Never echoes the name back — same rule the other commands follow for a
  // value that could hold anything.
  if (!found) throw new UsageError('no funnel with that name in this project')
  return found.id
}

function emitRun(body: RunResponse, mode: Mode, ctx: CommandContext): void {
  emitRecords(body.steps, mode, STEP_COLUMNS, ctx.write)
  const { steps: _steps, warnings, ...summary } = body
  emitObject(summary, mode, ctx.writeErr)
  emitWarnings(warnings, ctx)
}

async function runRun(
  name: string,
  flags: Record<string, string | boolean>,
  mode: Mode,
  ctx: CommandContext,
): Promise<number> {
  try {
    const id = await idForName(name, ctx)
    const body = await ctx.client.post<RunResponse>(
      `/v1/funnels/${id}/run`,
      resolveWindow(flags, ctx.now()),
    )
    emitRun(body, mode, ctx)
    return 0
  } catch (err) {
    if (err instanceof UsageError) return reportUsageError(err, mode, ctx)
    return reportCommandFailure(err, mode, ctx)
  }
}

async function runPreview(
  flags: Record<string, string | boolean>,
  mode: Mode,
  ctx: CommandContext,
): Promise<number> {
  const file = typeof flags.file === 'string' ? flags.file : undefined
  if (file === undefined) {
    return reportUsageError(new UsageError(`preview requires --file (${FUNNELS_USAGE})`), mode, ctx)
  }
  let definition: unknown
  try {
    definition = JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    // The path came from the caller, so naming it is useful rather than a
    // leak — they typed it.
    return reportUsageError(
      new UsageError(`could not read a funnel definition from ${file}: ${(err as Error).message}`),
      mode,
      ctx,
    )
  }
  try {
    const body = await ctx.client.post<RunResponse>('/v1/funnels/preview', {
      ...(definition as object),
      ...resolveWindow(flags, ctx.now()),
    })
    emitRun(body, mode, ctx)
    return 0
  } catch (err) {
    if (err instanceof UsageError) return reportUsageError(err, mode, ctx)
    return reportCommandFailure(err, mode, ctx)
  }
}

async function runDropoff(
  name: string,
  flags: Record<string, string | boolean>,
  mode: Mode,
  ctx: CommandContext,
): Promise<number> {
  const raw = typeof flags.step === 'string' ? flags.step : undefined
  if (raw === undefined) {
    return reportUsageError(new UsageError(`dropoff requires --step (${FUNNELS_USAGE})`), mode, ctx)
  }
  // 1-indexed, matching the STEP column of a run. Rejected here rather than
  // sent, because a 0-indexed caller would otherwise read step 2's drop-offs
  // as step 1's and never see an error.
  if (!/^[1-9]\d*$/.test(raw)) {
    return reportUsageError(
      new UsageError('--step must be a positive whole number; steps are numbered from 1'),
      mode,
      ctx,
    )
  }
  try {
    const id = await idForName(name, ctx)
    const body = await ctx.client.post<DropoffResponse>(`/v1/funnels/${id}/dropoff`, {
      step: Number(raw),
      ...(typeof flags.cursor === 'string' ? { cursor: flags.cursor } : {}),
      ...resolveWindow(flags, ctx.now()),
    })
    const { people, ...summary } = body
    emitRecords(people, mode, DROPOFF_COLUMNS, ctx.write)
    emitObject(summary, mode, ctx.writeErr)
    return 0
  } catch (err) {
    if (err instanceof UsageError) return reportUsageError(err, mode, ctx)
    return reportCommandFailure(err, mode, ctx)
  }
}

const RUN_ALLOWED = new Set([...UNIVERSAL_FLAGS, 'since', 'until'])
const PREVIEW_ALLOWED = new Set([...RUN_ALLOWED, 'file'])
const DROPOFF_ALLOWED = new Set([...RUN_ALLOWED, 'step', 'cursor'])

export async function runFunnels(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  let positionals: string[]
  let positionalIndexes: number[]
  let positionalContext: (string | undefined)[]
  try {
    ;({ flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(argv, {
      strings: ['host', 'server-key', 'since', 'until', 'step', 'cursor', 'file'],
      booleans: ['json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, argv, ctx)
  }

  const mode = resolveMode(flags, ctx.isTty)
  const [subcommand, name] = positionals

  if (subcommand === undefined) {
    return reportUsageError(new UsageError(FUNNELS_USAGE), mode, ctx)
  }

  const noExtraPositionals = (from: number) =>
    checkNoPositionals(
      {
        positionals: positionals.slice(from),
        positionalContext: positionalContext.slice(from),
        positionalIndexes: positionalIndexes.slice(from),
      },
      mode,
      ctx,
    )

  if (subcommand === 'list') {
    const positionalsCode = noExtraPositionals(1)
    if (positionalsCode !== undefined) return positionalsCode
    const strayCode = checkStrayFlags(flags, UNIVERSAL_FLAGS, mode, ctx)
    if (strayCode !== undefined) return strayCode
    return runList(mode, ctx)
  }

  if (subcommand === 'preview') {
    const positionalsCode = noExtraPositionals(1)
    if (positionalsCode !== undefined) return positionalsCode
    const strayCode = checkStrayFlags(flags, PREVIEW_ALLOWED, mode, ctx)
    if (strayCode !== undefined) return strayCode
    return runPreview(flags, mode, ctx)
  }

  if (subcommand === 'run' || subcommand === 'dropoff') {
    if (name === undefined) {
      return reportUsageError(
        new UsageError(`funnels ${subcommand} requires a name (${FUNNELS_USAGE})`),
        mode,
        ctx,
      )
    }
    const positionalsCode = noExtraPositionals(2)
    if (positionalsCode !== undefined) return positionalsCode
    const strayCode = checkStrayFlags(
      flags,
      subcommand === 'run' ? RUN_ALLOWED : DROPOFF_ALLOWED,
      mode,
      ctx,
    )
    if (strayCode !== undefined) return strayCode
    return subcommand === 'run'
      ? runRun(name, flags, mode, ctx)
      : runDropoff(name, flags, mode, ctx)
  }

  // Same "never echo the unrecognised word" rule as the other command groups —
  // this slot could hold anything.
  return reportUsageError(
    new UsageError(`unknown funnels subcommand (${FUNNELS_USAGE})`),
    mode,
    ctx,
  )
}
