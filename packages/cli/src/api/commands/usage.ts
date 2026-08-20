/**
 * `lyraflow usage` — how much of a project's monthly quota it has consumed.
 *
 * Before this, the only way to see that figure was querying Postgres by hand,
 * and the only signal that a quota was nearly spent was clients being refused
 * (#42). The quota still has no warning threshold (#43); this is the read, not
 * the alarm.
 *
 * Reads `GET /v1/project/usage` rather than the database directly, which is
 * why it needs no Postgres credentials: that endpoint already assembles the
 * counters and the configured quota, and is what the settings screen shows, so
 * the CLI and the UI cannot disagree about a number.
 */

import { UsageError, parseCommandArgs } from '../args.js'
import type { CommandContext } from '../context.js'
import { type Mode, emitObject, resolveMode } from '../output.js'
import {
  UNIVERSAL_FLAGS,
  checkNoPositionals,
  checkStrayFlags,
  reportCommandFailure,
  reportParseFailure,
} from './command-support.js'

/** `GET /v1/project/usage`'s response shape (project/routes.ts). */
interface UsageRecord {
  month: string
  events_accepted: number
  events_rejected: number
  events_throttled: number
  events_bot: number
  monthly_event_quota: number | null
}

const USAGE_USAGE = 'usage: lyraflow usage [--json|--human]'
const USAGE_ALLOWED = new Set([...UNIVERSAL_FLAGS])

/**
 * The human view only. `--json` emits the server's record VERBATIM and adds
 * nothing: `--json` is the stable interface, and a percentage the CLI computed
 * would be a field no server ever sent, which an agent could come to depend on
 * and which would then have to be maintained as though it were part of the API.
 */
function humanLines(u: UsageRecord): string[] {
  const quota = u.monthly_event_quota
  const pct =
    quota != null && quota > 0 ? `${((u.events_accepted / quota) * 100).toFixed(1)}%` : '—'
  return [
    `month:      ${u.month}`,
    `accepted:   ${u.events_accepted.toLocaleString('en-US')}`,
    `quota:      ${quota == null ? 'unlimited' : quota.toLocaleString('en-US')}`,
    `consumed:   ${pct}`,
    `rejected:   ${u.events_rejected.toLocaleString('en-US')}`,
    `throttled:  ${u.events_throttled.toLocaleString('en-US')}`,
    `bot:        ${u.events_bot.toLocaleString('en-US')}`,
    // Said rather than left to be assumed: the enforcement decision adds this
    // process's unflushed in-memory tally to the persisted figure, and the
    // counters flush every 10 seconds. A number that silently lags is worse
    // than one labelled as lagging.
    '',
    'Counters are persisted every ~10s, so this can lag ingest slightly.',
  ]
}

export async function runUsage(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  let positionals: string[]
  let positionalIndexes: number[]
  let positionalContext: (string | undefined)[]
  try {
    ;({ flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(argv, {
      strings: ['host', 'server-key'],
      booleans: ['json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, argv, ctx)
  }

  const mode: Mode = resolveMode(flags, ctx.isTty)

  const positionalsCode = checkNoPositionals(
    { positionals, positionalContext, positionalIndexes },
    mode,
    ctx,
  )
  if (positionalsCode !== undefined) return positionalsCode

  const strayFlagsCode = checkStrayFlags(flags, USAGE_ALLOWED, mode, ctx)
  if (strayFlagsCode !== undefined) return strayFlagsCode

  try {
    const usage = await ctx.client.get<UsageRecord>('/v1/project/usage')
    if (mode === 'json') {
      emitObject(usage, mode, ctx.write)
    } else {
      for (const line of humanLines(usage)) ctx.write(`${line}\n`)
    }
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}
