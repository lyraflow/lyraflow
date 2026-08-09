/**
 * Behaviour shared by every read command (`events`, `stats`, and whatever
 * Task 8 adds) that is NOT worth re-deriving per file — extracted after it
 * was copied, verbatim, into two files and then had to be fixed in both.
 *
 * THIS MODULE IS THE ONE PLACE A "COMMAND FAILED" MESSAGE MAY BE BUILT.
 * That is not a style preference: every other structural guarantee on this
 * branch that survived review lives in exactly one place —
 * `describeUnknown` (output.ts) is the one place `String()` is called on
 * an untrusted value, `notSuppressedExpr` (segments) is the one
 * suppression derivation every read path shares, `Params` is the one SQL
 * binding path. An invariant enforced by "whoever writes the next message
 * remembers to" is not an invariant; `positionalsUsageMessage` alone was
 * fixed twice in two review rounds (round 2 echoed the positional's own
 * value, round 3 echoed the argv token next to it) because there were two
 * near-identical copies to fix and a third file would have shipped a third
 * copy of the same mistake. Task 8's command group gets this for free
 * instead of writing its own.
 */

import { type ParsedArgs, UsageError, hasRawFlag } from '../args.js'
import { ApiError } from '../client.js'
import type { CommandContext } from '../context.js'
import { type Mode, emitError, resolveMode } from '../output.js'

/**
 * EPIPE means the reader (e.g. `head`, `less`) closed the pipe before this
 * command was done writing — a normal end for a streaming command, not a
 * failure. Every write in a command's main loop goes through a catch that
 * checks this, so a closed pipe always resolves to a clean exit 0 instead
 * of an unhandled-exception stack trace and exit 1 (which under this
 * CLI's contract means "the request failed" — it did not).
 *
 * THIS ONLY CATCHES A SYNCHRONOUSLY-THROWING WRITER. `process.stdout`'s
 * real failure mode when piped to something that exits early (`| head`) is
 * NOT a synchronous throw — it is an asynchronous `'error'` event on the
 * underlying socket, arriving after `write()` has already returned, which
 * no `try`/`catch` here can ever observe. That is handled separately, at
 * the stream level, in index.ts's `process.stdout.on('error', ...)` — see
 * that file's comment for why it has to live there instead of here. This
 * guard stays anyway: it is real protection against exactly what it claims
 * (a writer that throws), which is worth keeping regardless of what else a
 * real broken pipe does.
 */
export function isEpipe(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EPIPE'
}

/**
 * Writes a `UsageError` to `ctx.writeErr` (swallowing only a write-side
 * `EPIPE` — see `isEpipe`) and returns the exit code every usage error
 * maps to. The one function allowed to pair "a `UsageError` was thrown"
 * with "exit 2" — every command's `catch` blocks for a failed parse or a
 * failed validation call this instead of repeating the try/emit/catch
 * shape themselves.
 */
export function reportUsageError(
  err: UsageError,
  mode: Mode,
  ctx: Pick<CommandContext, 'writeErr'>,
): number {
  try {
    emitError(err, mode, ctx.writeErr)
  } catch (writeErr) {
    if (!isEpipe(writeErr)) throw writeErr
  }
  return 2
}

/**
 * The shape every command's `parseCommandArgs` catch block needs: the
 * parse failed entirely, so there is no `ParsedArgs` to read a `Mode`
 * from — but a `--json` that DID appear in argv should still win over
 * `ctx.isTty` when rendering the error about to be printed. See
 * `hasRawFlag`'s own docstring for why a raw pre-scan is the only thing
 * that can still see it.
 */
export function reportParseFailure(
  err: UsageError,
  argv: string[],
  ctx: Pick<CommandContext, 'writeErr' | 'isTty'>,
): number {
  const mode = resolveMode(
    { json: hasRawFlag(argv, 'json'), human: hasRawFlag(argv, 'human') },
    ctx.isTty,
  )
  return reportUsageError(err, mode, ctx)
}

/**
 * The ONLY place in this CLI that may construct the "unexpected
 * positional argument(s)" message — and its parameter list is the actual
 * enforcement mechanism, not just documentation: there is no `string[]`
 * of raw argv here, and no positional's own value, so nothing this
 * function is handed CAN leak one. `context` is the canonical flag NAME
 * (never `--name`, never anything with `=value` attached, never a raw
 * argv string) that preceded the first unexpected positional in argv's
 * own token stream — `undefined` when nothing did. `ordinal` is a 1-based
 * count of that positional among this command's own arguments (never an
 * index into raw `argv`, and never claims to count the command word
 * itself, which this module never sees).
 *
 * Fixed twice before this became the only way to build the message at
 * all: round 2 interpolated the positional's own value
 * (`positionals.join(' ')`); round 3 interpolated the argv token
 * immediately before it, which for `--flag=value` syntax IS the value.
 * Both mistakes required touching a raw argv string; this signature makes
 * that impossible rather than merely inadvisable.
 */
export function positionalsUsageMessage(
  count: number,
  context: string | undefined,
  ordinal: number,
): string {
  const plural = count === 1 ? '' : 's'
  const location = context !== undefined ? `after --${context}` : `as argument ${ordinal}`
  return `${count} unexpected positional argument${plural} ${location}`
}

/**
 * Checks `parsed.positionals` and, if any exist, reports the usage error
 * and returns `2` — otherwise returns `undefined`, so a caller can do
 * `const code = checkNoPositionals(...); if (code !== undefined) return code`.
 * Wraps `positionalsUsageMessage` so no command file ever needs to reach
 * into `parsed.positionalContext`/`positionalIndexes` itself.
 */
export function checkNoPositionals(
  parsed: Pick<ParsedArgs, 'positionals' | 'positionalContext' | 'positionalIndexes'>,
  mode: Mode,
  ctx: Pick<CommandContext, 'writeErr'>,
): number | undefined {
  if (parsed.positionals.length === 0) return undefined
  const ordinal = (parsed.positionalIndexes[0] ?? 0) + 1
  const message = positionalsUsageMessage(
    parsed.positionals.length,
    parsed.positionalContext[0],
    ordinal,
  )
  return reportUsageError(new UsageError(message), mode, ctx)
}

/**
 * Checks that every flag actually PRESENT in `flags` (`Object.keys`, i.e.
 * flags the caller genuinely passed, not every flag a command's
 * `ArgSpec` merely declares) belongs to `allowed` for the SPECIFIC
 * subcommand about to run.
 *
 * A command group with multiple subcommands (`persons`, `segments`,
 * `schema`) necessarily gives `parseCommandArgs` the UNION of every
 * subcommand's own flags, so one parse call can accept any of them before
 * the subcommand word itself is even known. Without a check like this
 * afterwards, a flag that belongs to a SIBLING subcommand — `schema events
 * --event X` (`--event` is `properties`-only), `segments list --members`
 * (`--members` is `run`-only), `persons get --yes` (`--yes` is
 * `delete`-only) — parses successfully and then silently vanishes: an
 * agent that typo'd the subcommand, or copied a flag from the wrong one,
 * gets no signal that anything was ignored. Found in Task 8's review as
 * the flag-shaped mirror of the unexpected-positional gap
 * `checkNoPositionals` already closes.
 *
 * Naming the stray flag BY NAME in the message is safe here, unlike a
 * positional's value: `parseCommandArgs` (strict mode) already rejected
 * anything not in the command group's own recognised option set, so every
 * key in `flags` can only ever be one of THIS command's own declared flag
 * names — never arbitrary, untrusted argv content.
 */
export function checkStrayFlags(
  flags: Record<string, string | boolean>,
  allowed: ReadonlySet<string>,
  mode: Mode,
  ctx: Pick<CommandContext, 'writeErr'>,
): number | undefined {
  const stray = Object.keys(flags).filter((name) => !allowed.has(name))
  if (stray.length === 0) return undefined
  const plural = stray.length === 1 ? '' : 's'
  const message = `unexpected flag${plural} for this subcommand: ${stray.map((s) => `--${s}`).join(', ')}`
  return reportUsageError(new UsageError(message), mode, ctx)
}

/**
 * Throws a `UsageError` when `since` is after `until` — never silently
 * printing nothing and exiting 0, which is what an inverted window did
 * before this existed. Takes both as optional since `stats`' `since` can
 * be genuinely unset (see stats.ts's `defaultSince`); `events`' `since`
 * is always resolved by the time it calls this, so passing a `Date`
 * there is just as valid.
 */
export function assertWindowNotInverted(since: Date | undefined, until: Date | undefined): void {
  if (since && until && since.getTime() > until.getTime()) {
    throw new UsageError(
      `--since (${since.toISOString()}) is after --until (${until.toISOString()})`,
    )
  }
}

/**
 * The outer catch shared by every command's main request loop:
 *
 * - `instanceof ApiError` MUST be checked before `isEpipe`: `ApiError`'s
 *   own `code` field is sourced verbatim from the server's response body
 *   (client.ts), so a non-2xx response the server happened to answer with
 *   `{"error":"EPIPE"}` would otherwise duck-type as a closed pipe and
 *   turn a real, reportable failure into a silent exit 0. Checking the
 *   class first means only a genuine thrown value (never an `ApiError`)
 *   can ever reach the `isEpipe` check below.
 * - An `ApiError` is reported (exit 1), or exit 0 if reporting it hits a
 *   real write-side EPIPE.
 * - Anything else that duck-types as EPIPE is a clean stop (exit 0).
 * - Anything else at all rethrows — a bug should crash loudly, not be
 *   absorbed by this function.
 */
export function reportCommandFailure(
  err: unknown,
  mode: Mode,
  ctx: Pick<CommandContext, 'writeErr'>,
): number {
  if (err instanceof ApiError) {
    try {
      emitError(err, mode, ctx.writeErr)
    } catch (writeErr) {
      if (isEpipe(writeErr)) return 0
      throw writeErr
    }
    return 1
  }
  if (isEpipe(err)) return 0
  throw err
}
