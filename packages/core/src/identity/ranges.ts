export type Bound = number

export interface Binding {
  personId: string
  from: Bound
  to: Bound
}

export interface BindingWrite {
  // 'replace' is part of the write vocabulary for future callers (e.g. merging
  // two person records); this task's algebra only ever emits 'insert' / 'close'.
  op: 'insert' | 'close' | 'replace'
  binding: Binding
  previous?: Binding
}

/**
 * Decides what to write when `identify()` binds a device to a person at an instant.
 *
 * Ranges are half-open, [from, to), and always tile the timeline without gaps or
 * overlaps. The first binding opens at -infinity, which is the whole journey
 * feature: signing up retroactively attaches every earlier anonymous event.
 *
 * A late-arriving identify is placed into the range that already covers its
 * instant — splitting it — rather than appended, so arrival order cannot change
 * the result.
 */
export function planBindingWrites(
  existing: Binding[],
  incoming: { personId: string; at: Bound },
): BindingWrite[] {
  if (existing.length === 0) {
    return [
      {
        op: 'insert',
        binding: {
          personId: incoming.personId,
          from: Number.NEGATIVE_INFINITY,
          to: Number.POSITIVE_INFINITY,
        },
      },
    ]
  }

  const covering = existing.find((b) => b.from <= incoming.at && incoming.at < b.to)
  if (!covering) return []

  // Already the right person for that instant — the overwhelmingly common case,
  // because apps call identify() on every page load.
  if (covering.personId === incoming.personId) return []

  return [
    {
      op: 'close',
      binding: { personId: covering.personId, from: covering.from, to: incoming.at },
      previous: covering,
    },
    {
      op: 'insert',
      binding: { personId: incoming.personId, from: incoming.at, to: covering.to },
    },
  ]
}
