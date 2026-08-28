/**
 * A calendar date, in the format every screen that names a boundary instant
 * (a segment member's first/last seen, a person's own first/last seen, a
 * timeline walk's own span) uses to say it.
 *
 * Third caller as of Task 7 (`Timeline.tsx`'s end-of-walk copy) -- it lived
 * as byte-identical copies in `segments/MemberList.tsx` and
 * `people/IdentityHeader.tsx` until then, flagged by a previous review and
 * deliberately left alone until a genuine third use turned up rather than
 * consolidated pre-emptively.
 *
 * Only the calendar date matters here, unlike the event feed's own
 * `formatEventTime` (`feed/format.ts`), which also carries a same-day time --
 * a timeline ROW wants that (which is why `AcceptedTable` still calls it
 * directly), but a SPAN across a whole walk, or a person's first/last seen,
 * does not.
 *
 * `undefined` (never sent by the server, but not worth a crash) falls
 * through `new Date(undefined)` to `Invalid Date`, caught by the same
 * `isNaN` guard as a genuinely malformed string.
 */
export function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
