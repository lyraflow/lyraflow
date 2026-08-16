import { useEffect } from 'react'
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
 */
export function ValueInput(props: {
  operator: string
  value: ConditionValue
  onChange: (value: ConditionValue) => void
  type?: 'text' | 'datetime-local'
  label?: string
}) {
  const { operator, value, onChange, type = 'text', label = 'Value' } = props
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
      <div className="flex items-center gap-2">
        <Input
          type={type}
          aria-label={`${label} 1`}
          value={toText(first)}
          onChange={(e) => onChange([e.target.value, second])}
        />
        <span className="text-sm text-muted-foreground">and</span>
        <Input
          type={type}
          aria-label={`${label} 2`}
          value={toText(second)}
          onChange={(e) => onChange([first, e.target.value])}
        />
      </div>
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
