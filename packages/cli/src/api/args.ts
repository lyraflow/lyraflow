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
 * non-ISO forms like `"Aug 1 2026"` as real instants. Left unguarded, a
 * mistyped `--since 15` (meant as "15 minutes") would not fail; it would
 * silently resolve to some date in the past and return a plausible-looking
 * answer to a question nobody asked. Requiring the full shape below closes
 * that gap: everything that reaches `Date.parse` here already looks like an
 * instant, and `Date.parse` is used only to reject impossible calendar
 * values (`"2026-13-45T00:00:00Z"`) that the regex alone cannot catch.
 *
 * Accepts a bare date (`YYYY-MM-DD`, midnight UTC per the ISO 8601 / `Date`
 * spec) and a full timestamp with optional milliseconds and a required
 * `Z` or `±HH:MM` offset — i.e. exactly what `Date.prototype.toISOString()`
 * produces, which is what an agent-generated `--since` looks like.
 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2}))?$/

/**
 * `input` as a relative duration (offset before `now`) or an absolute ISO
 * instant — never a default. See the module docstring for why a silent
 * fallback is worse than throwing: a bad `--since` that quietly became
 * "15 minutes ago" would answer a question nobody asked, and look like
 * real data.
 */
export function resolveInstant(input: string, now: Date): Date {
  if (DURATION_RE.test(input)) {
    return new Date(now.getTime() - parseDuration(input))
  }
  if (ISO_INSTANT_RE.test(input)) {
    const ms = Date.parse(input)
    if (!Number.isNaN(ms)) return new Date(ms)
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
