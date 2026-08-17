import type { Window } from '@lyraflow/core/segments/ast.js'
import { Input } from '../../components/ui/input.js'
import { Label } from '../../components/ui/label.js'
import { localZone, toInstant, toPickerValue } from './datetime.js'

/**
 * The three window variants with the words an OPERATOR reads, in the order
 * `ast.ts` declares them. The labels are the operator's vocabulary, not the
 * AST's -- the same rule `ConditionRow`'s `LEAF_KINDS` follows. `kind` on the
 * left is the only thing that ever reaches a node, so every existing test
 * that selects an option by its VALUE keeps working unchanged.
 */
const WINDOW_KINDS = [
  { kind: 'last', label: 'in the last…' },
  { kind: 'absolute', label: 'between two dates' },
  { kind: 'ever', label: 'any time' },
] as const

/** Only the `last` variant has a `unit` -- `Window['unit']` does not
 * typecheck across the whole union, so this is pulled out via `Extract`
 * rather than widened to `string` and cast blindly. */
type LastUnit = Extract<Window, { kind: 'last' }>['unit']

/**
 * `ast.ts` declares `last.n` as `z.number().int().positive().max(3650)` --
 * inline there, not exported as a named constant (checked; there is
 * nothing to import). Mirrored here as a literal, with this comment naming
 * `ast.ts` as its source, the same way `ValueInput.ts` mirrors `scalar`
 * (also a local, unexported `const` there) rather than inventing a second
 * source of truth silently. If `ast.ts` ever exports this, import it
 * instead of keeping two literals in sync by hand.
 */
const MAX_WINDOW_N = 3650

/**
 * `Number.isSafeInteger`, not `Number.isInteger` -- the latter is true for
 * 1e20, which reaches the database as a bigint bind and returns a 503, an
 * input error wearing an outage's clothes. This is (at least) the sixth
 * home of that check in this repository.
 *
 * This used to check ONLY the lower bound (positive, safe
 * integer), which is exactly the same defect class the aggregate/property
 * rule in `BehaviourForm` exists to prevent for a different field -- a form
 * that lets the operator build a state the schema refuses, then reports
 * back the schema's OWN rejection, is a worse version of a check the
 * schema already has. `ast.ts`'s `.max(3650)` is the upper bound this was
 * missing.
 */
function isValidN(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0 && n <= MAX_WINDOW_N
}

/**
 * What the picker says about the zone it is showing -- one sentence naming
 * the zone, plus a second one only when the second one is NEWS.
 *
 * An unlabelled datetime is ambiguous, and the product's own voice is to
 * volunteer that kind of limit rather than let someone discover it from a
 * count that is hours off. So the zone comes from the runtime (`localZone`),
 * never from a guess, and it is NAMED rather than implied: "your local time"
 * does not tell an operator on a shared machine, a VPN or a travelling laptop
 * WHICH local.
 *
 * The second sentence used to be unconditional, and on any host whose zone is
 * UTC -- a container, CI, a server, or any machine with `TZ` unset -- the
 * result read "Times are in UTC, your browser's timezone. They are stored and
 * counted in UTC.": the same fact, stated twice, which reads like a bug in the
 * page rather than a note about it. It is dropped exactly when naming the zone
 * has already said the word, which is a question about the SENTENCE and is
 * therefore asked of the sentence -- not a list of zone names to keep in step
 * with the tz database, and not the runtime offset either, which would make
 * the note appear and disappear across a daylight-saving boundary in London.
 *
 * Takes the zone as an ARGUMENT rather than calling `localZone` itself, and
 * exported, so that both branches can be pinned against a literal zone name
 * instead of against whatever zone the test host happens to be in. A test that
 * could only ask about the runtime's own zone could never check the UTC branch
 * on a developer's laptop nor the non-UTC branch in CI -- which is exactly the
 * asymmetry that let the doubled sentence ship.
 */
export function zoneNote(zone: string): string {
  return /utc/i.test(zone)
    ? `Times are in ${zone}, your browser's timezone.`
    : `Times are in ${zone}, your browser's timezone. They are stored and counted in UTC.`
}

/**
 * `Window` is a three-variant discriminated union (`ast.ts`): `last` takes a
 * positive safe integer and a unit, `absolute` takes two datetimes, `ever`
 * takes nothing. This control switches between them with a single select,
 * and every switch REPLACES `value` wholesale with a fresh literal for the
 * new variant -- never spreads the old one -- which is what keeps a
 * variant's own fields from surviving a switch away from it. Spreading
 * `{...value, kind: next}` would leave `n`/`unit` on an `absolute` node, or
 * `from`/`to` on a `last` one: fields the AST's own discriminated union
 * would refuse to parse back, produced by this UI rather than a hand-built
 * request.
 *
 * `id` scopes every control's DOM id to the caller's own row, the same
 * convention `TraitForm`/`ContextForm`/`LifecycleForm` use -- `BehaviourForm`
 * renders one of these per behaviour condition.
 *
 * **The `absolute` variant stores UTC and displays local** (`datetime.ts`,
 * which owns both directions and explains why). This control used to write
 * the input's OWN value straight onto the node -- `2026-08-01T10:00`, local
 * wall-clock with no zone -- which `ast.ts`'s `z.string().datetime()` refuses,
 * so choosing an absolute range and filling in both bounds had never once
 * produced a saveable tree. Nothing caught it because every test in this
 * screen built a window object directly rather than driving this picker; the
 * round-trip test in this file's suite is the one that could not have.
 *
 * The consequence that had to be fixed with it: the builder's completeness
 * check reads the SAME schema, so it reported a window with both bounds
 * filled in as "not finished", which was the only place the row-level
 * messaging said something untrue.
 */
export function WindowPicker(props: {
  id: string
  value: Window
  onChange: (next: Window) => void
}) {
  const { id, value, onChange } = props
  const kindId = `${id}-window-kind`
  const amountId = `${id}-window-amount`

  function setKind(kind: Window['kind']) {
    if (kind === value.kind) return
    if (kind === 'last') onChange({ kind: 'last', n: 1, unit: 'days' })
    else if (kind === 'absolute') onChange({ kind: 'absolute', from: '', to: '' })
    else onChange({ kind: 'ever' })
  }

  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={kindId}>Window</Label>
      <select
        id={kindId}
        aria-label="Window"
        value={value.kind}
        onChange={(e) => setKind(e.target.value as Window['kind'])}
        className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
      >
        {WINDOW_KINDS.map(({ kind, label }) => (
          <option key={kind} value={kind}>
            {label}
          </option>
        ))}
      </select>

      {/* The cost of `ever`, said WHERE IT IS CHOSEN. `costWarnings` already
       * raises the same fact against the finished condition, and that warning
       * stays -- but a warning read after the fact explains a decision the
       * operator has already made, whereas the same sentence beside the
       * control informs the decision itself. Rendered inside this component,
       * not by the row, so it is present even where there is no row: the
       * window is the only place the choice is actually made.
       *
       * Worded so it shares NO phrase with `costWarnings`' own sentence. The
       * two are meant to be read in different places at different moments,
       * and a test asserting the warning landed on the right row must not be
       * able to match this instead -- three of them could, before this was
       * reworded, which is a coincidence the suite would have carried
       * silently. */}
      {value.kind === 'ever' && (
        <p className="text-xs text-muted-foreground">
          Any time places no bound at all on the search: this condition reads every event the
          project has ever recorded, and is the most expensive window to count.
        </p>
      )}

      {value.kind === 'last' && (
        <div className="flex items-center gap-2">
          <Input
            id={amountId}
            type="number"
            min={1}
            step={1}
            aria-label="Window amount"
            aria-invalid={!isValidN(value.n)}
            value={value.n}
            onChange={(e) =>
              onChange({ kind: 'last', n: Number(e.target.value), unit: value.unit })
            }
            className="w-24"
          />
          <select
            aria-label="Window unit"
            value={value.unit}
            onChange={(e) =>
              onChange({ kind: 'last', n: value.n, unit: e.target.value as LastUnit })
            }
            className="h-9 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-xs"
          >
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      )}
      {value.kind === 'last' && !isValidN(value.n) && (
        <p className="text-xs text-destructive">
          Enter a whole number of {value.unit}, greater than zero and no more than {MAX_WINDOW_N}.
        </p>
      )}

      {value.kind === 'absolute' && (
        <>
          {/* Two bounds side by side above `sm`, STACKED below it, and `min-w-0`
           * on both. Two `datetime-local` boxes have a min-content width of
           * roughly 420px between them and this row used not to wrap at all,
           * which made it the widest thing in a nested condition and therefore
           * the floor everything else was clipped against: at 390px, inside a
           * depth-three condition, the `to` bound was simply not on screen and
           * nothing said so.
           *
           * Stacking rather than wrapping, because a native date-and-time
           * control has a floor of its own that has nothing to do with CSS:
           * roughly 200px to render `07/01/2026, 12:00 AM` plus its calendar
           * button, and more below `sm`, where the primitives render at
           * `text-base`. Sharing a 256px line with the word `to` shaves the
           * AM/PM indicator off the end of the first box -- narrower than the
           * defect above, and the same kind. Full width each, one per line, is
           * the only arrangement that holds at every width. */}
          <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center">
            <Input
              type="datetime-local"
              aria-label="From"
              className="w-full min-w-0 sm:w-auto sm:grow sm:basis-40"
              value={toPickerValue(value.from)}
              onChange={(e) =>
                onChange({ kind: 'absolute', from: toInstant(e.target.value), to: value.to })
              }
            />
            <span className="shrink-0 text-sm text-muted-foreground">to</span>
            <Input
              type="datetime-local"
              aria-label="To"
              className="w-full min-w-0 sm:w-auto sm:grow sm:basis-40"
              value={toPickerValue(value.to)}
              onChange={(e) =>
                onChange({ kind: 'absolute', from: value.from, to: toInstant(e.target.value) })
              }
            />
          </div>
          <p className="text-xs text-muted-foreground">{zoneNote(localZone())}</p>
        </>
      )}
    </div>
  )
}
