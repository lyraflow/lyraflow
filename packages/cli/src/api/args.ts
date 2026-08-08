/**
 * Argument, duration and instant parsing for the CLI.
 *
 * This is the layer that decides what a user meant by `--since 15m` or
 * `--since 2026-08-01T00:00:00Z` — and refuses to guess when it cannot tell.
 * Nothing here talks to the network; `ApiError` (client.ts) and `UsageError`
 * (this file) are deliberately separate classes because they map to
 * different exit codes downstream: a usage error means the command was
 * never sent (exit 2), an `ApiError` means it was sent and rejected or
 * failed (exit 1).
 */

import { parseArgs } from 'node:util'

/**
 * Raised for anything wrong with what the user typed — a malformed
 * `--since`, an unrecognised flag, an ambiguous option value. Never raised
 * for anything that happened on the wire; see the module docstring.
 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

const DURATION_RE = /^(\d+)(m|h|d)$/

function unitMs(unit: string): number {
  switch (unit) {
    case 'm':
      return 60_000
    case 'h':
      return 60 * 60_000
    case 'd':
      return 24 * 60 * 60_000
    default:
      // Unreachable: `unit` only ever comes from DURATION_RE's own capture
      // group, which can only be 'm', 'h' or 'd'.
      throw new UsageError(`not a duration unit: "${unit}"`)
  }
}

/**
 * `^(\d+)(m|h|d)$` only — no weeks, no fractional amounts, no whitespace.
 * A looser grammar (`1.5h`, `2w`, a trailing space) would need to decide
 * what to do with values this CLI cannot round-trip cleanly; rejecting them
 * is cheaper than guessing, and cheap to loosen later if a real caller
 * needs it.
 *
 * Deliberately no cap on digit count. A cap here would only produce a
 * friendlier message for one specific way to go out of range; the actual
 * guarantee — that an absurd amount never reaches a caller as anything
 * other than `UsageError` — is enforced once, downstream in
 * `resolveInstant`, by validating the resulting `Date` rather than the
 * input digits. See `assertValidInstant`.
 */
export function parseDuration(input: string): number {
  const match = DURATION_RE.exec(input)
  if (!match) {
    throw new UsageError(`not a duration: "${input}" (expected e.g. "15m", "24h", "7d")`)
  }
  const [, amount, unit] = match
  return Number(amount) * unitMs(unit as string)
}

/**
 * Deliberately narrower than `Date.parse`, which is far looser than "ISO
 * 8601" — V8 accepts bare years (`"2026"`), month-only strings and
 * non-ISO forms like `"Aug 1 2026"` as real instants, and SILENTLY ROLLS
 * OVER a near-miss calendar value into a different real date instead of
 * rejecting it: `"2026-02-30"` becomes `2026-03-02T00:00:00.000Z`,
 * `"2025-02-29"` (2025 is not a leap year) becomes `2025-03-01T00:00:00.000Z`.
 * Left unguarded, either failure mode returns a plausible-looking wrong
 * answer instead of an error — exactly the thing this module exists to
 * prevent.
 *
 * Two checks close both gaps, and neither is sufficient alone: this regex
 * requires the ISO shape before `Date.parse` ever runs (closes the
 * bare-year / non-ISO-string gap), and `isRealCalendarDate` (below)
 * round-trips the typed digits through `Date.UTC` and rejects anything
 * that does not come back unchanged (closes the near-miss-rollover gap —
 * a shape match alone does not catch "the 30th of February").
 *
 * Accepts a bare date (`YYYY-MM-DD`, midnight UTC per the ISO 8601 / `Date`
 * spec) and a full timestamp with optional milliseconds and a required
 * `Z` or `±HH:MM` offset — i.e. exactly what `Date.prototype.toISOString()`
 * produces, which is what an agent-generated `--since` looks like.
 */
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/

/**
 * Confirms `year`-`month`-`day` `hour`:`minute`:`second` is a real point on
 * the calendar, not just a string that satisfies `ISO_INSTANT_RE`'s digit
 * shape. `Date.UTC` (like `Date.parse`) does not reject an out-of-range
 * component — it rolls it forward into the next one, silently turning a
 * typo into a DIFFERENT real date. Reconstructing the date from the typed
 * components and checking every one survives the round trip is what
 * actually catches that.
 *
 * Deliberately checks the components as literal digits, ignoring whatever
 * offset the input carried (`Z` or `±HH:MM`) — an offset legitimately
 * shifts the final UTC instant onto a different calendar day
 * (`"2026-08-01T01:00:00+05:30"` is `2026-07-31T19:30:00.000Z`), and that
 * is correct, not a typo. This function only answers "are these digits a
 * real calendar date/time", independent of what timezone they're in.
 */
function isRealCalendarDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  const d = new Date(ms)
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day &&
    d.getUTCHours() === hour &&
    d.getUTCMinutes() === minute &&
    d.getUTCSeconds() === second
  )
}

/**
 * Both branches of `resolveInstant` funnel their result through here, so
 * the function's guarantee — return a valid `Date` or throw `UsageError`,
 * never an Invalid Date — holds by construction rather than per-branch.
 *
 * Without this, a shape-valid but absurd duration (`DURATION_RE` has no
 * cap on digit count — see `parseDuration`'s docstring) such as
 * `"999999999d"` computes an offset outside `Date`'s representable range
 * (±8,640,000,000,000,000 ms from the epoch). `new Date(...)` on an
 * out-of-range value does not throw — it silently returns an Invalid Date
 * whose `.getTime()` is `NaN` — so the `RangeError` only surfaces later, in
 * whichever caller first calls `.toISOString()` on it, which in this CLI
 * is every caller (building a query parameter means exactly that). That
 * would break the exit-code contract described in the module docstring: a
 * usage error must exit 2, never crash the process with an unhandled
 * `RangeError`.
 */
function assertValidInstant(date: Date, input: string): Date {
  if (Number.isNaN(date.getTime())) {
    throw new UsageError(
      `"${input}" resolves to an instant outside the range JavaScript's Date can represent`,
    )
  }
  return date
}

/**
 * `input` as a relative duration (offset before `now`) or an absolute ISO
 * instant — never a default. See the module docstring for why a silent
 * fallback is worse than throwing: a bad `--since` that quietly became
 * "15 minutes ago" would answer a question nobody asked, and look like
 * real data.
 */
export function resolveInstant(input: string, now: Date): Date {
  if (DURATION_RE.test(input)) {
    return assertValidInstant(new Date(now.getTime() - parseDuration(input)), input)
  }

  const isoMatch = ISO_INSTANT_RE.exec(input)
  if (isoMatch) {
    const [, year, month, day, hour, minute, second] = isoMatch
    const isReal = isRealCalendarDate(
      Number(year),
      Number(month),
      Number(day),
      Number(hour ?? '0'),
      Number(minute ?? '0'),
      Number(second ?? '0'),
    )
    if (isReal) {
      const ms = Date.parse(input)
      if (!Number.isNaN(ms)) return assertValidInstant(new Date(ms), input)
    }
  }

  throw new UsageError(
    `not a valid instant: "${input}" (expected a duration like "15m", "24h", "7d", or an ISO 8601 instant like "2026-08-01T00:00:00.000Z")`,
  )
}

/**
 * What a command declares about its own flags. Long names only, no short
 * aliases — this CLI's argv is machine-generated as often as typed, and
 * keeping the surface small keeps `parseCommandArgs` a thin wrapper over
 * `node:util`'s `parseArgs` rather than a small argument-parsing framework.
 *
 * A flag passed more than once (`--since 15m --since 1h`) keeps only the
 * last value — `parseArgs`'s own default, and standard CLI convention. If a
 * later command needs to tell "given twice" apart from "given once", that
 * is new surface on `ArgSpec` (e.g. a `multiple: true` per-flag option),
 * not something already here to discover.
 */
export interface ArgSpec {
  /** Flags that take a string value, e.g. `--since 15m`. */
  strings?: readonly string[]
  /** Flags that are on/off switches, e.g. `--follow`, `--json`. */
  booleans?: readonly string[]
}

/**
 * The result of parsing one command's argv. `flags` holds only the flags
 * that were actually present — a boolean not passed is an absent key, not
 * a `false` default, so a caller can tell "not set" from "explicitly off"
 * if it ever needs to. `positionals` is everything else, in argv order:
 * subcommand words (`get`, `delete`) and their ids, exactly as typed.
 */
export interface ParsedArgs {
  flags: Record<string, string | boolean>
  positionals: string[]
}

/**
 * Wraps `node:util`'s `parseArgs` (Node 22 built-in, no dependency — see
 * packages/cli/package.json). `parseArgs` already runs in `strict` mode,
 * which rejects an unrecognised flag and an ambiguous option value on its
 * own; this only narrows that rejection to `UsageError`; so every caller
 * catches one error type regardless of what, specifically, was wrong with
 * the input.
 */
export function parseCommandArgs(argv: string[], spec: ArgSpec): ParsedArgs {
  const options: Record<string, { type: 'string' | 'boolean' }> = {}
  for (const name of spec.strings ?? []) options[name] = { type: 'string' }
  for (const name of spec.booleans ?? []) options[name] = { type: 'boolean' }

  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({ args: argv, options, strict: true, allowPositionals: true })
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : 'invalid arguments')
  }

  return {
    flags: parsed.values as Record<string, string | boolean>,
    positionals: parsed.positionals,
  }
}
