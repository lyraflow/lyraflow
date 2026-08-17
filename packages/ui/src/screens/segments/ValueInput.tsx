import { useEffect, useId } from 'react'
import { Input } from '../../components/ui/input.js'

/**
 * Mirrors the `scalar` union `packages/core/src/segments/ast.ts` builds
 * every condition's `value` from -- not imported, because `scalar` is a
 * local `const`, not exported. If a scalar type is ever added there, this
 * must be updated to match; nothing here re-derives it automatically.
 */
type Scalar = string | number | boolean | null
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
 * `suggest` attaches a `<datalist>` to the input(s) and reports every
 * interaction with them. This component deliberately owns NO fetching: what
 * a value's suggestions cost, and when they may be asked for, depends
 * entirely on which kind of condition is being edited -- a trait's values
 * come from a partition scan that must not run on render, a context field's
 * would come from somewhere else entirely. So the caller keeps the list and
 * decides when to fill it; this component only renders it and says when the
 * operator touched a box. Every caller that passes nothing is unchanged.
 */
export function ValueInput(props: {
  operator: string
  value: ConditionValue
  onChange: (value: ConditionValue) => void
  type?: 'text' | 'datetime-local'
  label?: string
  suggest?: {
    /** Rendered as the datalist's options. May be empty -- the datalist is
     * rendered regardless, so that offering suggestions does not change the
     * input's accessible role halfway through an edit. */
    options: string[]
    /** Called on focus and on every keystroke, with the text of the box the
     * operator is in -- which is the box's own text, not the whole value:
     * under `between` there are two, and a lookup seeded with the wrong
     * one would prefix-filter against a bound nobody is editing. */
    onInteract: (text: string) => void
  }
}) {
  const { operator, value, onChange, type = 'text', label = 'Value', suggest } = props
  const isBetween = operator === 'between'
  const isTuple = Array.isArray(value)
  const id = useId()
  const listId = `${id}-values`
  // Undefined, not the id, when there is nothing to suggest: `list` pointing
  // at a datalist is what gives the input its combobox role, and an input
  // that has no suggestions at all should not claim to be one.
  const list = suggest ? listId : undefined

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

  // One list, shared by both boxes under `between`, and rendered from the
  // same state. Both bounds are values of the SAME field, so the vocabulary
  // an operator needs to fill the lower bound is exactly the one they need
  // for the upper; suggesting on the first box and leaving the second bare
  // would read as a bug rather than a policy. It stays a suggestion either
  // way -- a bound that is not itself a recorded value (`between "a" and
  // "m"`) is typed straight in, as before.
  const datalist = suggest ? (
    <datalist id={listId}>
      {suggest.options.map((v) => (
        <option key={v} value={v}>
          {v}
        </option>
      ))}
    </datalist>
  ) : null

  if (isBetween) {
    const [first, second] = isTuple ? (value as [Scalar, Scalar]) : [value as Scalar, '' as Scalar]
    return (
      <div className="flex items-center gap-2">
        <Input
          type={type}
          list={list}
          autoComplete={list ? 'off' : undefined}
          aria-label={`${label} 1`}
          value={toText(first)}
          onFocus={() => suggest?.onInteract(toText(first))}
          onChange={(e) => {
            suggest?.onInteract(e.target.value)
            onChange([e.target.value, second])
          }}
        />
        <span className="text-sm text-muted-foreground">and</span>
        <Input
          type={type}
          list={list}
          autoComplete={list ? 'off' : undefined}
          aria-label={`${label} 2`}
          value={toText(second)}
          onFocus={() => suggest?.onInteract(toText(second))}
          onChange={(e) => {
            suggest?.onInteract(e.target.value)
            onChange([first, e.target.value])
          }}
        />
        {datalist}
      </div>
    )
  }

  return (
    <>
      <Input
        type={type}
        list={list}
        autoComplete={list ? 'off' : undefined}
        aria-label={label}
        value={isTuple ? '' : toText(value as Scalar)}
        onFocus={(e) => suggest?.onInteract(e.target.value)}
        onChange={(e) => {
          suggest?.onInteract(e.target.value)
          onChange(e.target.value)
        }}
      />
      {datalist}
    </>
  )
}
