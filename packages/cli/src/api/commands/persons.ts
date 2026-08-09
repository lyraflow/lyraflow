/**
 * `lyraflow persons` — a single person's profile, their full-history export,
 * and their erasure. Three subcommands (`get`, `export`, `delete`), each
 * taking exactly one positional: the person id, resolved server-side the
 * same way GET /v1/persons/:id itself resolves it (aliases, device windows —
 * see person.ts's own docstring).
 *
 * `delete` is IRREVERSIBLE. Its exit codes are the whole safety design, not
 * an afterthought:
 *   - a declined confirmation prompt returns 1 — the operation the caller
 *     asked for did not happen, which is a different fact from "it
 *     succeeded" (0);
 *   - running without `--yes` when STDIN is not a terminal returns 2 and
 *     never calls the API at all — an agent's stdin is essentially never a
 *     TTY, so requiring an explicit flag there is what stops an accidental
 *     invocation from erasing someone, while `--yes` still lets a caller do
 *     it deliberately. Gated on stdin, not stdout: a review round found a
 *     pty-allocated harness (tmux, `script`, most agent runners) commonly
 *     reports stdout AS a terminal too, which made an earlier, stdout-keyed
 *     version of this check wrongly skip `--yes` under exactly the
 *     environment most agents actually run in;
 *   - nothing here EVER waits on a prompt nobody can answer, no matter HOW
 *     the input stops answering — closed cleanly, destroyed, errored, or
 *     simply silent forever — see `runDelete` and index.ts's `createPrompt`
 *     for how each of those is closed, including the bounded-timeout
 *     backstop for the last one, which `stdinIsTty` alone cannot rule out.
 *
 * NEITHER the confirmation prompt NOR any message this file constructs ever
 * interpolates the raw id positional the caller typed — the id is the
 * command's own explicit parameter, not a stray value in the wrong slot,
 * but the CLI still cannot tell "a real person id" apart from "a secret
 * pasted into the wrong place" by looking at the string alone, and the
 * safer default is the same one command-support.ts's usage messages already
 * follow: never echo raw user input into CLI-authored output. What DOES
 * appear in output is the server's own response body (`person_id`, etc.) —
 * that is the documented JSON contract, sourced from the API's answer, not
 * from argv.
 */

import { UsageError, parseCommandArgs } from '../args.js'
import type { CommandContext } from '../context.js'
import { type Mode, emitError, emitObject, resolveMode } from '../output.js'
import {
  checkNoPositionals,
  checkStrayFlags,
  isEpipe,
  reportCommandFailure,
  reportParseFailure,
  reportUsageError,
} from './command-support.js'

/** GET /v1/persons/:id's full response shape (person.ts). */
interface PersonRecord {
  person_id: string
  ids: string[]
  first_seen: string
  last_seen: string
  events: number
}

/** DELETE /v1/persons/:id's 202 response shape (privacy/routes.ts). */
interface DeletionRequestRecord {
  request_id: number
  person_id: string
  suppressed_at: string
}

const SUBCOMMANDS = ['get', 'export', 'delete'] as const
type Subcommand = (typeof SUBCOMMANDS)[number]

function isSubcommand(value: string): value is Subcommand {
  return (SUBCOMMANDS as readonly string[]).includes(value)
}

const USAGE = 'usage: lyraflow persons <get|export|delete> <id> [--yes] [--json|--human]'

/** Flags every subcommand accepts, regardless of which one runs. */
const UNIVERSAL_FLAGS = new Set(['host', 'server-key', 'json', 'human'])

/**
 * `--yes` is `delete`-only. Without a per-subcommand check, `persons get
 * --yes` parses fine (the whole group's `ArgSpec` has to accept `--yes`
 * SOMEWHERE) and then silently does nothing — see `checkStrayFlags`'s own
 * docstring.
 */
const ALLOWED_FLAGS: Record<Subcommand, ReadonlySet<string>> = {
  get: UNIVERSAL_FLAGS,
  export: UNIVERSAL_FLAGS,
  delete: new Set([...UNIVERSAL_FLAGS, 'yes']),
}

/**
 * `{"type":"end","events":N}` — the export's own terminating line
 * (export.ts). Parsed defensively (a malformed or truncated final chunk is
 * exactly the case this check exists to catch) rather than matched as a
 * literal string prefix, so a legitimate line that merely starts the same
 * way cannot be mistaken for the real terminator.
 */
function isEndLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown
    return (
      typeof parsed === 'object' && parsed !== null && (parsed as { type?: unknown }).type === 'end'
    )
  } catch {
    return false
  }
}

/**
 * GET /v1/persons/:id — the full record, rendered as one object (`json`:
 * one line; `human`: `key: value` pairs), matching `--version`'s own use of
 * `emitObject` for a single record. No `Column` set: there is exactly one
 * record, never a list, so a table has nothing to add.
 */
async function runGet(id: string, mode: Mode, ctx: CommandContext): Promise<number> {
  try {
    const person = await ctx.client.get<PersonRecord>(`/v1/persons/${encodeURIComponent(id)}`)
    emitObject(person, mode, ctx.write)
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}

/**
 * GET /v1/persons/:id/export — passed through UNCHANGED, terminator
 * included: the NDJSON wire format is already the documented contract
 * (export.ts), and re-wrapping it (a JSON array, re-parsing then
 * re-serialising each line) would give the same data two different shapes
 * depending on which door it came out of. `ctx.client.getLines` strips each
 * line's own trailing `\n` (and a stray `\r`) to find line boundaries; this
 * puts back exactly one `\n` per line, in the same order, with no other
 * transformation — a caller piping this straight to a file gets byte-for-
 * byte what the server sent, modulo CRLF normalisation the client itself
 * already documents as deliberate (client.ts's `stripTrailingCR`).
 *
 * `--json`/`--human` do not change this output at all — there is no second
 * rendering of an NDJSON export, human or otherwise; the format IS NDJSON.
 * They still apply to whatever error this function itself reports.
 *
 * The stream can end without ever producing the `{"type":"end",...}` line —
 * export.ts's own docstring names this exactly: a mid-stream ClickHouse
 * failure ends the response early, on purpose, as the wire format's own
 * signal that the caller has an incomplete export and must discard it. This
 * command still writes every line it received (an agent piping to a file
 * should see what actually arrived) but reports the omission on stderr and
 * exits 1 rather than 0 — exit 0 must mean "this export is complete and
 * trustworthy," which a stream with no terminator is not.
 */
async function runExport(id: string, mode: Mode, ctx: CommandContext): Promise<number> {
  // The guarantee is "the LAST line received was the terminator" — not
  // "a terminator-shaped line appeared somewhere in the stream". Keyed on
  // every line, not `||=`'d once true, so a real (if server-side
  // unreachable today) `end` line followed by more content still reports
  // the honest answer: the export did not end cleanly.
  let sawEnd = false
  try {
    for await (const line of ctx.client.getLines(`/v1/persons/${encodeURIComponent(id)}/export`)) {
      sawEnd = isEndLine(line)
      try {
        ctx.write(`${line}\n`)
      } catch (writeErr) {
        if (isEpipe(writeErr)) return 0
        throw writeErr
      }
    }
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }

  if (!sawEnd) {
    try {
      // Deliberately NOT `emitError` — its generic fallback for a plain
      // `Error` always renders `code: 'error'`, indistinguishable on the
      // wire from any other unexpected failure this CLI reports. This
      // condition is specific and recoverable-by-knowing (the data
      // received is real, just incomplete), so it gets its own `code`
      // rather than blending into the generic shape.
      emitObject(
        {
          error:
            'the export stream ended without its terminating end line; the data received is incomplete and must not be trusted',
          code: 'export_incomplete',
        },
        mode,
        ctx.writeErr,
      )
    } catch (writeErr) {
      if (!isEpipe(writeErr)) throw writeErr
    }
    return 1
  }
  return 0
}

/**
 * DELETE /v1/persons/:id. See the module docstring for the exit-code
 * design; this is the enforcement of it.
 *
 * `yes` short-circuits BOTH the terminal check and the prompt, regardless
 * of `ctx.stdinIsTty` — deliberately, so the same flag that lets a human
 * skip the prompt at a real terminal is also what lets an agent (whose
 * stdin is essentially never a TTY) delete at all. Without this, `--yes`
 * at a terminal would still stop and wait on a prompt nobody necessarily
 * wants answered interactively just because a TTY happens to be attached
 * (e.g. a human running this inside a script from an interactive shell).
 *
 * Gated on `ctx.stdinIsTty`, NOT `ctx.isTty` (stdout) — "can anyone answer
 * a prompt" is a property of the INPUT, not the output; see
 * `context.ts`'s own docstring on the two fields for why conflating them
 * is exactly what let a pty-allocated agent harness (tmux, `script`, most
 * agent runners — where stdout commonly reports as a TTY) skip `--yes`
 * and then hang forever on a prompt nobody was going to answer. `stdinIsTty`
 * alone does not fully close that hang (a pty commonly reports stdin as a
 * TTY too) — `createPrompt` (index.ts) closes the rest of it with a bounded
 * timeout backstop.
 */
async function runDelete(
  id: string,
  flags: Record<string, string | boolean>,
  mode: Mode,
  ctx: CommandContext,
): Promise<number> {
  const yes = flags.yes === true

  if (!yes) {
    if (!ctx.stdinIsTty) {
      return reportUsageError(
        new UsageError(
          'refusing to delete without --yes when stdin is not a terminal (nothing to prompt)',
        ),
        mode,
        ctx,
      )
    }

    let confirmed: boolean
    try {
      // Deliberately no id in the question — see the module docstring.
      confirmed = await ctx.prompt(
        'This permanently erases this person and their event history. Continue?',
      )
    } catch (err) {
      // A REJECTED prompt is the confirmation mechanism itself failing —
      // not an answer, and not something that should escape as an
      // unhandled rejection (no defined exit code, a raw stack trace
      // instead of this CLI's usual error shape). Same "fails safe, never
      // deletes" rule a declined prompt gets, mapped to the same exit code.
      if (isEpipe(err)) return 0
      try {
        emitError(
          new Error('the confirmation prompt failed; the person was not deleted'),
          mode,
          ctx.writeErr,
        )
      } catch (writeErr) {
        if (!isEpipe(writeErr)) throw writeErr
      }
      return 1
    }

    // `!== true`, not `!confirmed`: `prompt`'s contract returns a
    // `boolean`, but nothing at runtime enforces that a caller-injected
    // implementation (this is the one place in the product where the
    // caller supplies the function) actually returns one — a strict
    // comparison is the one branch on the whole product where costing
    // nothing buys "a truthy non-`true` value can never delete".
    if (confirmed !== true) {
      try {
        emitError(new Error('deletion declined; the person was not deleted'), mode, ctx.writeErr)
      } catch (writeErr) {
        if (!isEpipe(writeErr)) throw writeErr
      }
      // The operation the caller asked for did not happen — 1, not 0.
      return 1
    }
  }

  try {
    const result = await ctx.client.delete<DeletionRequestRecord>(
      `/v1/persons/${encodeURIComponent(id)}`,
    )
    emitObject(result, mode, ctx.write)
    return 0
  } catch (err) {
    return reportCommandFailure(err, mode, ctx)
  }
}

/**
 * `lyraflow persons <get|export|delete> <id> [--yes] [--json|--human]`
 *
 * Returns the process exit code: 0 success, 1 the request reached the API
 * and failed (or, for `delete` specifically, was declined at the prompt), 2
 * usage error (nothing was ever sent).
 */
export async function runPersons(argv: string[], ctx: CommandContext): Promise<number> {
  let flags: Record<string, string | boolean>
  let positionals: string[]
  let positionalIndexes: number[]
  let positionalContext: (string | undefined)[]
  try {
    ;({ flags, positionals, positionalIndexes, positionalContext } = parseCommandArgs(argv, {
      strings: ['host', 'server-key'],
      booleans: ['yes', 'json', 'human'],
    }))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    return reportParseFailure(err, argv, ctx)
  }

  const mode = resolveMode(flags, ctx.isTty)

  const [subcommand, id] = positionals

  if (subcommand === undefined) {
    return reportUsageError(new UsageError(USAGE), mode, ctx)
  }
  if (!isSubcommand(subcommand)) {
    // Deliberately does NOT interpolate `subcommand` itself: reaching this
    // branch means the first positional did not match the fixed
    // {get,export,delete} set, and this is exactly the "forgot the verb"
    // shape that could put anything — including a secret — in this slot
    // (e.g. `lyraflow persons $LYRAFLOW_SERVER_KEY`). Same rule
    // command-support.ts's positional messages follow, for the same
    // reason.
    return reportUsageError(new UsageError(`unknown persons subcommand (${USAGE})`), mode, ctx)
  }
  if (id === undefined) {
    return reportUsageError(
      new UsageError(`persons ${subcommand} requires an id (${USAGE})`),
      mode,
      ctx,
    )
  }
  // Anything past the id is unexpected — reuses command-support's own
  // "one place this message is built" primitive rather than a fourth copy
  // of the same logic, offset to the two positionals (subcommand, id) this
  // command itself already consumed.
  const positionalsCode = checkNoPositionals(
    {
      positionals: positionals.slice(2),
      positionalContext: positionalContext.slice(2),
      positionalIndexes: positionalIndexes.slice(2),
    },
    mode,
    ctx,
  )
  if (positionalsCode !== undefined) return positionalsCode

  const strayFlagsCode = checkStrayFlags(flags, ALLOWED_FLAGS[subcommand], mode, ctx)
  if (strayFlagsCode !== undefined) return strayFlagsCode

  switch (subcommand) {
    case 'get':
      return runGet(id, mode, ctx)
    case 'export':
      return runExport(id, mode, ctx)
    case 'delete':
      return runDelete(id, flags, mode, ctx)
  }
}
