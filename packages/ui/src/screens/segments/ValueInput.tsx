import { useEffect } from 'react'
import { Combobox } from '../../components/Combobox.js'
import { Input } from '../../components/ui/input.js'

/**
 * Mirrors the `scalar` union `packages/core/src/segments/ast.ts` builds
 * every condition's `value` from -- not imported, because `scalar` is a
 * local `const`, not exported. If a scalar type is ever added there, this
 * must be updated to match; nothing here re-derives it automatically.
 */
export type Scalar = string | number | boolean | null
export type ConditionValue = Scalar | [Scalar, Scalar]

function toText(v: Scalar): string {
  return v == null ? '' : String(v)
}

/**
 * The shared value control every condition form renders through --
 * `TraitForm`, `ContextForm`, `LifecycleForm` here, and
 * `BehaviourForm`. One text-like input for every operator except
 * `between`, which gets two.
 *
 * This is `valueFor`'s refine (ast.ts) enforced on the way IN, not just
 * reported on the way back from the server: "`between` requires exactly
 * two values; other operators require one" is a rule the AST already
 * knows, so a form that let an operator produce the mismatch and then
 * showed the server's field error would be a worse version of a check
 * that already exists. There is no operator/value combination reachable
 * through this component that the AST would refuse.
 *
 * Self-healing, not just self-rendering: an effect watches `[operator,
 * value]` on every render and calls `onChange` with a reshaped value
 * whenever the two disagree --
 *   - `between` paired with a non-tuple `value` expands it to a two-slot
 *     tuple (the existing value kept as the first slot, an empty second);
 *   - anything else paired with a tuple `value` collapses it to just the
 *     first element.
 * That is what lets a form's own operator-select handler change `operator`
 * alone and leave `value` untouched: switching AWAY from `between` would
 * otherwise strand the second value in the tree -- exactly the shape
 * `valueFor`'s refine rejects, just produced by this UI instead of a
 * hand-built request.
 *
 * `suggest` turns the box (or both boxes) into a `Combobox` -- a real
 * listbox that opens on focus -- and reports every interaction with them.
 * This component deliberately owns NO fetching: what a value's suggestions
 * cost, and when they may be asked for, depends entirely on which kind of
 * condition is being edited -- a trait's values come from a partition scan
 * that must not run on render, a context field's would come from somewhere
 * else entirely. So the caller keeps the list and decides when to fill it;
 * this component only renders it and says when the operator touched a box.
 * Every caller that passes nothing gets a plain `Input`, with the `textbox`
 * role it has always had: a box that offers no choices must not describe
 * itself as one that does.
 */
export function ValueInput(props: {
  operator: string
  value: ConditionValue
  onChange: (value: ConditionValue) => void
  type?: 'text' | 'datetime-local'
  label?: string
  suggest?: {
    /** Rendered as the popup's options. May be empty -- the field stays a
     * combobox regardless, so that offering suggestions does not change the
     * input's accessible role halfway through an edit. */
    options: string[]
    /** Called on focus and on every keystroke, with the text of the box the
     * operator is in -- which is the box's own text, not the whole value:
     * under `between` there are two, and a lookup seeded with the wrong
     * one would prefix-filter against a bound nobody is editing. */
    onInteract: (text: string) => void
    /** True until a lookup has answered. Stops the popup asserting "nothing
     * recorded" while the first request is still outstanding. */
    loading?: boolean
    /** What an empty answer means, in the caller's words. */
    emptyMessage?: string
    /** Said instead, when the lookup itself failed. */
    errorMessage?: string
  }
}) {
  const { operator, value, onChange, type = 'text', label = 'Value', suggest } = props
  const isBetween = operator === 'between'
  const isTuple = Array.isArray(value)

  // `onChange` intentionally excluded from the dependency array below:
  // including it would re-run this effect whenever a caller passes a fresh
  // inline function (every render, in practice), even though only
  // `isBetween`/`isTuple`/`value` describe the mismatch this effect exists
  // to fix.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (isBetween && !isTuple) {
      onChange([value as Scalar, ''])
    } else if (!isBetween && isTuple) {
      onChange((value as [Scalar, Scalar])[0])
    }
  }, [isBetween, isTuple, value])

  if (isBetween) {
    const [first, second] = isTuple ? (value as [Scalar, Scalar]) : [value as Scalar, '' as Scalar]
    return (
      // `flex-wrap`, and `grow basis-24 min-w-0` on each box. Two inputs and
      // the word between them have a min-content width of ~380px, and this row
      // used not to wrap at all -- which made it the widest thing inside a
      // nested condition and therefore the floor everything else was clipped
      // against. At 390px, inside a depth-three condition, the second bound
      // was off the edge of a box that did not scroll and said nothing.
      //
      // The basis is small (6rem) and `grow` does the rest, on purpose. A large
      // basis makes the pair wrap between the two boxes at narrow widths, which
      // looked worse than the clipping did: the second bound and the word `and`
      // dropped to a line of their own and interleaved with the operator select
      // beside them. Small basis plus grow keeps both bounds on one line
      // wherever they fit at all, and still splits the space evenly when there
      // is plenty.
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* One list, offered under BOTH bounds, from the same state. Both
         * bounds are values of the SAME field, so the vocabulary an operator
         * needs to fill the lower bound is exactly the one they need for the
         * upper; suggesting under the first box and leaving the second bare
         * would read as a bug rather than a policy. Each box gets its own
         * popup, because only the focused one is ever open. It stays a
         * suggestion either way -- a bound that is not itself a recorded
         * value (`between "a" and "m"`) is typed straight in, as before. */}
        {suggest ? (
          <Combobox
            type={type}
            className="grow basis-24"
            label={`${label} 1`}
            value={toText(first)}
            options={suggest.options}
            loading={suggest.loading}
            emptyMessage={suggest.emptyMessage}
            errorMessage={suggest.errorMessage}
            onInteract={suggest.onInteract}
            onChange={(next) => onChange([next, second])}
          />
        ) : (
          <Input
            type={type}
            className="min-w-0 grow basis-24"
            aria-label={`${label} 1`}
            value={toText(first)}
            onChange={(e) => onChange([e.target.value, second])}
          />
        )}
        <span className="shrink-0 text-sm text-muted-foreground">and</span>
        {suggest ? (
          <Combobox
            type={type}
            className="grow basis-24"
            label={`${label} 2`}
            value={toText(second)}
            options={suggest.options}
            loading={suggest.loading}
            emptyMessage={suggest.emptyMessage}
            errorMessage={suggest.errorMessage}
            onInteract={suggest.onInteract}
            onChange={(next) => onChange([first, next])}
          />
        ) : (
          <Input
            type={type}
            className="min-w-0 grow basis-24"
            aria-label={`${label} 2`}
            value={toText(second)}
            onChange={(e) => onChange([first, e.target.value])}
          />
        )}
      </div>
    )
  }

  if (suggest) {
    return (
      <Combobox
        type={type}
        className="w-full"
        label={label}
        value={isTuple ? '' : toText(value as Scalar)}
        options={suggest.options}
        loading={suggest.loading}
        emptyMessage={suggest.emptyMessage}
        errorMessage={suggest.errorMessage}
        onInteract={suggest.onInteract}
        onChange={onChange}
      />
    )
  }

  return (
    <Input
      type={type}
      aria-label={label}
      value={isTuple ? '' : toText(value as Scalar)}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}
