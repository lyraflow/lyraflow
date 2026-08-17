/**
 * `lyraflow seed-demo <project>` — fills a project with reproducible demo data.
 *
 * Shaped like `set-admin-password` rather than like the read commands: it takes
 * database handles, not an HTTP client, because the data it writes cannot be
 * created through the public ingest API at all (see `rows.ts` for the clamp
 * that makes that true, and why loosening it is not on the table).
 *
 * Argument parsing, validation and generation all happen BEFORE anything
 * connects. `connect` is a callback rather than a pair of handles for exactly
 * that reason: a usage error must cost nothing — no socket, no pool, no
 * ClickHouse client left to close — and a test can prove it by passing a
 * `connect` that throws if it is ever called.
 */

import { slugify } from '@lyraflow/core'
import type { ClickHouseClient, Pool } from '@lyraflow/db'
import { UsageError, hasRawFlag, parseCommandArgs, resolveInstant } from '../api/args.js'
import {
  isEpipe,
  positionalsUsageMessage,
  reportParseFailure,
  reportUsageError,
} from '../api/commands/command-support.js'
import type { CommandContext } from '../api/context.js'
import { emitError, emitObject, resolveMode } from '../api/output.js'
import { type DemoSummary, generateDemoData, summarise } from './generate.js'
import { type InsertResult, insertDemoData } from './insert.js'
import { MAX_SEED } from './random.js'

export const DEFAULT_SEED = 1
export const DEFAULT_PERSONS = 400
export const DEFAULT_EVENTS = 5_000
export const DEFAULT_DAYS = 90

/**
 * Ceilings on the three counts. Not tuning: they exist so a mistyped
 * `--events 50000000` fails in a millisecond instead of writing for an hour
 * into a database the operator may not have meant to point at. `--days` shares
 * its ceiling with a segment window's own `n` cap (`Window` in @lyraflow/core),
 * so a seeded range can always be asked about.
 */
export const MAX_PERSONS = 200_000
export const MAX_EVENTS = 2_000_000
export const MAX_DAYS = 3_650

/** One line, because `emitError`'s human renderer collapses newlines — the
 * paragraphs live in `SEED_HELP`, reached with `--help`. */
export const SEED_USAGE =
  'usage: lyraflow seed-demo <project> [--persons N] [--events N] [--days N] [--seed N] ' +
  '[--anchor <instant>] [--json|--human]  (see --help)'

export const SEED_HELP = `${SEED_USAGE}

Fills one project with synthetic persons, traits and events so the segments,
funnels and feed screens have something to show. All values are obviously
fake: ids are prefixed "demo-", names are "Demo Person 0042", and URLs use
the reserved .invalid domain.

  <project>          the project's name or slug, as passed to create-project
  --persons N        distinct persons to create (default ${DEFAULT_PERSONS}, max ${MAX_PERSONS})
  --events N         total events to create (default ${DEFAULT_EVENTS}, max ${MAX_EVENTS})
  --days N           how far back the history reaches (default ${DEFAULT_DAYS}, max ${MAX_DAYS})
  --seed N           PRNG seed, 0..${MAX_SEED} (default ${DEFAULT_SEED})
  --anchor INSTANT   what "now" means for the generated history: an ISO 8601
                     instant, or a duration before the real now like "36h".
                     Defaults to the moment you run the command.
  --json / --human   how to print the summary

IT WRITES TO THE DATABASES DIRECTLY, not through the ingest API. It has to:
every client timestamp sent to /v1/batch is clamped to within 24 hours of
arrival, deliberately, because an unclamped device clock corrupts every
time-windowed segment. Backdated events posted over HTTP would therefore all
land inside a single day, leaving "last 7 days", "last 30 days" and "ever"
indistinguishable. So this command needs LYRAFLOW_POSTGRES_URL and the
LYRAFLOW_CLICKHOUSE_* variables, exactly like migrate and create-project, and
it needs the migrations to have been applied.

IT ONLY EVER INSERTS. There is no reset, no wipe and no --force: it cannot
delete anything, including its own earlier output. Two consequences worth
knowing before you run it twice:

  * Running it again ADDS another cohort. Person and event counts go up; they
    are not replaced.
  * Re-running at the SAME seed re-mints the same event ids at new instants,
    so duplicates are findable rather than silent:
      SELECT event_id FROM events GROUP BY event_id HAVING count() > 1
    A different --seed produces a disjoint population instead, with its own
    ids, which is usually what you want for a second helping.

Determinism: at a fixed --seed every person, trait, property value and the
whole sequence of events is identical run to run, and the events' offsets
from the anchor are identical too. The anchor itself defaults to the current
clock, so absolute timestamps differ between runs; pass --anchor to pin it and
two runs become byte-for-byte identical.
`

const FLAGS = {
  strings: ['persons', 'events', 'days', 'seed', 'anchor'],
  booleans: ['json', 'human', 'help'],
} as const

/** Everything the command needs from the databases, opened lazily. */
export interface SeedConnection {
  pg: Pool
  ch: ClickHouseClient
  /** The configured ClickHouse database, i.e. `LYRAFLOW_CLICKHOUSE_DB`. */
  database: string
  close: () => Promise<void>
}

export type SeedContext = Pick<CommandContext, 'write' | 'writeErr' | 'isTty' | 'now'>

/**
 * Reads one integer flag. NEVER ECHOES THE VALUE — the rule `resolveInstant`
 * documents at length in args.ts, for the same reason: a flag value is whatever
 * the caller typed or an agent templated, and CLI output lands in shell history
 * and agent transcripts. Naming the flag and stating the range is the whole
 * diagnostic; repeating the value adds nothing the caller does not have.
 */
function intFlag(
  raw: string | boolean | undefined,
  flag: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback
  if (typeof raw !== 'string') throw new UsageError(`--${flag} takes a whole number`)
  // Number() rather than parseInt(): parseInt('40 pages') is 40, and a value
  // that was only partly a number is a mistake worth reporting, not rounding.
  const value = Number(raw.trim())
  if (raw.trim() === '' || !Number.isInteger(value) || value < min || value > max) {
    throw new UsageError(`--${flag} must be a whole number between ${min} and ${max}`)
  }
  return value
}

export interface SeedArgs {
  project: string
  persons: number
  events: number
  days: number
  seed: number
  anchor: Date
}

/**
 * Pure: turns argv into settled options or throws `UsageError`. Separate from
 * `runSeedDemo` so the whole validation surface is testable without a database,
 * a fake writer, or a spy on the generator.
 */
export function parseSeedArgs(args: string[], now: Date): SeedArgs {
  const { flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(args, FLAGS)

  const [project] = positionals
  if (project === undefined) throw new UsageError(SEED_USAGE)

  // Anything past the project name is unexpected. The message comes from the
  // one primitive allowed to build it, which names a POSITION and never a
  // value — a mistyped flag value landing here could be a server key.
  if (positionals.length > 1) {
    throw new UsageError(
      positionalsUsageMessage(
        positionals.length - 1,
        positionalContext[1],
        (positionalIndexes[1] ?? 1) + 1,
      ),
    )
  }

  const slug = slugify(project)
  if (slug === '') throw new UsageError('the project argument must contain a letter or a digit')

  const anchorRaw = flags.anchor
  if (anchorRaw !== undefined && typeof anchorRaw !== 'string') {
    throw new UsageError('--anchor takes an instant')
  }

  return {
    project: slug,
    persons: intFlag(flags.persons, 'persons', DEFAULT_PERSONS, 1, MAX_PERSONS),
    events: intFlag(flags.events, 'events', DEFAULT_EVENTS, 1, MAX_EVENTS),
    days: intFlag(flags.days, 'days', DEFAULT_DAYS, 1, MAX_DAYS),
    seed: intFlag(flags.seed, 'seed', DEFAULT_SEED, 0, MAX_SEED),
    anchor: anchorRaw === undefined ? now : resolveInstant(anchorRaw, now, '--anchor'),
  }
}

interface ProjectRow {
  id: string
  name: string
}

/** Not `createProject`'s inverse by accident: the same `slugify` is applied to
 * the argument, so a project can be named either way round. */
async function findProject(pg: Pool, slug: string): Promise<ProjectRow | null> {
  const result = await pg.query<ProjectRow>('SELECT id, name FROM projects WHERE slug = $1', [slug])
  return result.rows[0] ?? null
}

export class ProjectNotFoundError extends Error {
  readonly code = 'project_not_found'
  constructor() {
    // Deliberately does not echo the slug, for the same reason no other
    // message in this file echoes a flag value.
    super(
      'No project with that name or slug. Create one first with `lyraflow create-project <name>`.',
    )
    this.name = 'ProjectNotFoundError'
  }
}

function line(ctx: SeedContext, s: string): void {
  try {
    ctx.write(`${s}\n`)
  } catch (err) {
    if (!isEpipe(err)) throw err
  }
}

function renderHuman(
  ctx: SeedContext,
  project: ProjectRow,
  args: SeedArgs,
  summary: DemoSummary,
  inserted: InsertResult,
): void {
  const funnel = summary.funnel.map((s) => `${s.event} ${s.persons}`).join(' -> ')
  line(ctx, `Seeded demo data into project "${project.name}" (id ${project.id}).`)
  line(ctx, `  seed             ${args.seed}`)
  line(ctx, `  window           ${args.days} days`)
  line(ctx, `  oldest event     ${summary.earliest.toISOString()}`)
  line(ctx, `  newest event     ${summary.latest.toISOString()}`)
  line(
    ctx,
    `  persons          ${summary.persons} (${summary.identifiedPersons} identified, ${summary.anonymousPersons} anonymous-only)`,
  )
  line(ctx, `  events           ${summary.events} in ${inserted.batches} batch(es)`)
  line(
    ctx,
    `  events by window last 7d ${summary.windows.last7}, last 30d ${summary.windows.last30}, ever ${summary.windows.ever}`,
  )
  line(ctx, `  identity binds   ${inserted.bindingsWritten} written`)
  line(ctx, `  funnel           ${funnel}`)
  for (const { event, count } of summary.byEvent) {
    line(ctx, `    ${event.padEnd(18)} ${count}`)
  }
  if (!inserted.dictionaryReloaded) {
    line(
      ctx,
      '  note             the identity dictionary could not be reloaded (it is created when the server boots); person counts resolve once it is loaded.',
    )
  }
  line(
    ctx,
    '  This command only inserts. Nothing was deleted, and running it again adds more data rather than replacing it.',
  )
}

/**
 * Exit codes follow the rest of this CLI: 2 for a usage error (nothing was
 * sent), 1 for a failure after the command was understood, 0 on success.
 */
export async function runSeedDemo(
  args: string[],
  ctx: SeedContext,
  connect: () => SeedConnection,
): Promise<number> {
  if (hasRawFlag(args, 'help')) {
    line(ctx, SEED_HELP.trimEnd())
    return 0
  }

  const mode = resolveMode(
    { json: hasRawFlag(args, 'json'), human: hasRawFlag(args, 'human') },
    ctx.isTty,
  )

  let parsed: SeedArgs
  try {
    parsed = parseSeedArgs(args, ctx.now())
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, args, ctx)
  }

  // Generated before connecting, so a `--events`/`--persons` combination the
  // generator refuses costs nothing either.
  let data: ReturnType<typeof generateDemoData>
  try {
    data = generateDemoData({
      seed: parsed.seed,
      persons: parsed.persons,
      events: parsed.events,
      days: parsed.days,
      anchor: parsed.anchor,
    })
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportUsageError(err, mode, ctx)
  }

  const conn = connect()
  try {
    const project = await findProject(conn.pg, parsed.project)
    if (project === null) throw new ProjectNotFoundError()

    const inserted = await insertDemoData(data, {
      ch: conn.ch,
      pg: conn.pg,
      database: conn.database,
      projectId: Number(project.id),
    })
    const summary = summarise(data)

    if (mode === 'json') {
      emitObject(
        {
          command: 'seed-demo',
          project: { id: Number(project.id), name: project.name, slug: parsed.project },
          seed: parsed.seed,
          days: parsed.days,
          anchor: parsed.anchor.toISOString(),
          earliest: summary.earliest.toISOString(),
          latest: summary.latest.toISOString(),
          persons: summary.persons,
          identified_persons: summary.identifiedPersons,
          anonymous_persons: summary.anonymousPersons,
          events: summary.events,
          batches: inserted.batches,
          identity_bindings_written: inserted.bindingsWritten,
          identity_dictionary_reloaded: inserted.dictionaryReloaded,
          events_last_7_days: summary.windows.last7,
          events_last_30_days: summary.windows.last30,
          events_by_name: summary.byEvent,
          funnel: summary.funnel,
          additive_only: true,
        },
        mode,
        ctx.write,
      )
    } else {
      renderHuman(ctx, project, parsed, summary, inserted)
    }
    return 0
  } catch (err) {
    if (!(err instanceof ProjectNotFoundError)) throw err
    emitError(err, mode, ctx.writeErr)
    return 1
  } finally {
    await conn.close()
  }
}
