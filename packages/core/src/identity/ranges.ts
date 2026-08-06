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
  boundAt: Bound
  from: Bound
  to: Bound
}

export interface BindingWrite {
  op: 'insert' | 'close'
  binding: Binding
  previous?: Binding
}

const rangeKey = (b: Pick<Binding, 'personId' | 'from' | 'to'>): string =>
  `${b.personId}|${b.from}|${b.to}`

/**
 * Decides what to write when `identify()` binds a device to a person at an instant.
 *
 * The set of bind events — not the previously stored ranges — is the source of
 * truth. Every call re-derives the *whole* tiling from scratch from the union of
 * `existing`'s own bind events and `incoming`, so the result depends only on
 * which events have been seen, never on the order they arrived in. That is what
 * makes a late, out-of-order identify converge to the same answer as an
 * on-time one — mobile retries and a queue draining after a reconnect cannot
 * hand one person's history to another.
 *
 * Ranges are half-open, [from, to), and always tile the timeline without gaps,
 * overlaps, or zero-width slivers. The earliest known event owns [-Infinity, ...),
 * which is the whole journey feature: signing up retroactively attaches every
 * earlier anonymous event, no matter when the identify that proves it arrives.
 *
 * `close` retires `previous` and asserts that `binding` is now the correct
 * binding for the territory `previous` used to own; `insert` adds a binding with
 * no predecessor. Applying the returned writes — delete `previous` if present,
 * then upsert `binding` — reconstructs the derived tiling exactly, even when
 * several old bindings collapse into one (multiple `close` writes may then point
 * at the same `binding`; the upsert is idempotent, so that is harmless).
 */
export function planBindingWrites(existing: Binding[], incoming: BindEvent): BindingWrite[] {
  // The exact same (person, instant) has already been recorded — duplicate
  // delivery of one identify() call.
  if (existing.some((b) => b.personId === incoming.personId && b.boundAt === incoming.boundAt)) {
    return []
  }

  // One event per existing binding, plus the incoming one. When two events land
  // on the same instant, the incoming one wins — this is what stops a boundary
  // collision from ever producing a zero-width range.
  const byBoundAt = new Map<Bound, BindEvent>()
  for (const b of existing) byBoundAt.set(b.boundAt, { personId: b.personId, boundAt: b.boundAt })
  byBoundAt.set(incoming.boundAt, incoming)

  const sorted = [...byBoundAt.values()].sort((a, b) => a.boundAt - b.boundAt)

  // Consecutive same-person events collapse to the earliest of the run — two
  // ranges owned by the same person can never sit adjacent to each other.
  const collapsed: BindEvent[] = []
  for (const e of sorted) {
    const last = collapsed[collapsed.length - 1]
    if (last && last.personId === e.personId) continue
    collapsed.push(e)
  }

  // Tile: the earliest event opens at -Infinity, the latest is open-ended, and
  // every event in between owns up to whichever event comes next.
  const derived: Binding[] = collapsed.map((event, i) => {
    const next = collapsed[i + 1]
    return {
      personId: event.personId,
      boundAt: event.boundAt,
      from: i === 0 ? Number.NEGATIVE_INFINITY : event.boundAt,
      to: next ? next.boundAt : Number.POSITIVE_INFINITY,
    }
  })

  const existingKeys = new Set(existing.map(rangeKey))
  const derivedKeys = new Set(derived.map(rangeKey))

  const writes: BindingWrite[] = []
  const targeted = new Set<string>()

  for (const old of existing) {
    if (derivedKeys.has(rangeKey(old))) continue // unchanged, no write needed

    const covering = derived.find((d) => d.from <= old.from && old.from < d.to)
    // `derived` always fully tiles (-Infinity, Infinity), so a covering entry
    // for `old.from` always exists.
    if (!covering) continue
    writes.push({ op: 'close', binding: covering, previous: old })
    targeted.add(rangeKey(covering))
  }

  for (const d of derived) {
    const k = rangeKey(d)
    if (existingKeys.has(k) || targeted.has(k)) continue
    writes.push({ op: 'insert', binding: d })
    targeted.add(k)
  }

  return writes
}
