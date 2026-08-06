export type Bound = number

/**
 * A raw signal from `identify()`: this device belongs to `personId` as of `boundAt`.
 */
export interface BindEvent {
  personId: string
  boundAt: Bound
}

export interface Binding {
  personId: string
  from: Bound
  to: Bound
}

/**
 * Pure reference implementation of the tiling `identity_bindings_dict_src`
 * (see `003_identity.sql`) derives with a SQL window function. It exists so
 * the derivation's semantics can be property-tested exhaustively without a
 * database — the same reasoning that made the query compiler testable.
 *
 * The set of bind events is the source of truth; ranges are never stored or
 * patched, only derived fresh from the whole set every time. That makes the
 * result depend on *which* events have been seen, never on the order they
 * arrived in or were passed here — a set has no order, so there is nothing
 * for arrival order to disturb. A late, out-of-order identify therefore
 * converges to the same tiling as an on-time one, no matter how many other
 * identifies (for the same person or a different one) came in between.
 *
 * Ranges are half-open, [from, to), and always tile the timeline without
 * gaps, overlaps, or zero-width slivers. The earliest known event owns
 * [-Infinity, ...) — retroactive attachment, the whole journey feature:
 * signing up attaches every earlier anonymous event, no matter when the
 * identify that proves it arrives.
 *
 * Two different people at the identical instant is a genuine tie with no
 * correct answer; it resolves to the lexicographically smaller `personId`,
 * mirroring the write path's `ON CONFLICT ... DO UPDATE SET person_id =
 * LEAST(...)`. Arbitrary, but identical regardless of which of the two
 * events is seen first.
 *
 * Adjacent events for the same person are deliberately never collapsed: both
 * resolve to that person either way, so collapsing would be bookkeeping with
 * no observable effect on the derived range — and it was exactly this kind
 * of "patch the prior result" bookkeeping that made an earlier version of
 * this derivation lossy and order-dependent.
 */
export function deriveTiling(events: BindEvent[]): Binding[] {
  // Resolve same-instant ties before sorting: two events at the identical
  // boundAt collapse to one, keeping the lexicographically smaller personId.
  const byBoundAt = new Map<Bound, string>()
  for (const e of events) {
    const current = byBoundAt.get(e.boundAt)
    if (current === undefined || e.personId < current) {
      byBoundAt.set(e.boundAt, e.personId)
    }
  }

  const sorted = [...byBoundAt.entries()]
    .map(([boundAt, personId]) => ({ personId, boundAt }))
    .sort((a, b) => a.boundAt - b.boundAt)

  return sorted.map((event, i) => {
    const next = sorted[i + 1]
    return {
      personId: event.personId,
      from: i === 0 ? Number.NEGATIVE_INFINITY : event.boundAt,
      to: next ? next.boundAt : Number.POSITIVE_INFINITY,
    }
  })
}
