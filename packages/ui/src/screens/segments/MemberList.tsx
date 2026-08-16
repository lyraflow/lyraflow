import { useCallback, useRef, useState } from 'react'
import type { MemberRow } from '../../api/types.js'
import { Button } from '../../components/ui/button.js'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js'

/** One page of the walk, decoupled from `SegmentPreview`'s optional fields --
 * a caller always has all three once it decides to ask for members at all. */
export interface MemberPage {
  members: MemberRow[]
  next_cursor: string | null
  window_exhausted: boolean
}

/** `first_seen`/`last_seen` are ISO instants; only the calendar date matters
 * here, unlike the event feed's own `formatEventTime` which also carries a
 * same-day time. `undefined` (never sent by the server, but not worth a
 * crash) falls through `new Date(undefined)` to `Invalid Date`, caught by
 * the same `isNaN` guard as a genuinely malformed string. */
function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/** How this walk ended -- `null` while it has not. See `MemberList`'s own
 * doc comment for what each one means and why there are three. */
type Ending = 'exhausted' | 'window-short' | 'window-full'

/**
 * Which ending a just-received page represents, given the widest page this
 * walk has seen (including this one).
 *
 * "Short" is measured against the widest page rather than against a copy of
 * the server's own `MEMBER_PAGE_SIZE`, and that is deliberate. The server
 * offers a cursor only for a page it filled completely, so every page before
 * the last one in a walk is exactly one server page wide -- the widest page
 * seen IS the server's page size, discovered from the walk instead of
 * duplicated here. Duplicating it would be a constant that can silently
 * drift, and it can drift in the dangerous direction: a UI constant LARGER
 * than the server's real page size would read a full page as short and call
 * a truncated preview "everyone", which is the exact lie this function
 * exists to prevent. Measuring cannot fail that way -- a walk whose only
 * page is short and flagged (which the real server cannot produce, since the
 * flag needs the whole page budget spent) is classified `window-full`, whose
 * copy claims nothing either way.
 */
function endingFor(page: MemberPage, widestPage: number): Ending | null {
  if (page.next_cursor != null) return null
  if (!page.window_exhausted) return 'exhausted'
  return page.members.length < widestPage ? 'window-short' : 'window-full'
}

/**
 * The people a segment matches, paged behind an explicit "Show people"
 * click -- never fetched just because the count was. `fetchPage` is the
 * ONLY thing this component knows about where members come from: it takes
 * the cursor to resume from (`undefined` for the first page) and returns
 * one page. That keeps this component ignorant of `ApiClient`,
 * `previewSegment` vs `previewSavedSegment`, and the project/segment id --
 * `SegmentDetail` closes over all of that when it builds the callback.
 *
 * **The one thing this component exists to get right:** a walk ends for more
 * than one reason, `next_cursor: null` is true of all of them, and none of
 * the endings may be described with words that are true of another. Getting
 * this wrong in either direction is the same defect: telling an operator
 * their segment is smaller than it is (a truncated preview described as
 * "everyone"), or bigger (a fully-shown population described as truncated).
 * This project has shipped the first form once already, as a count of zero
 * rendering identically to "never ran".
 *
 * `window_exhausted` alone cannot tell them apart, and reading it as "there
 * are more people" is wrong: the server raises that flag once the walk has
 * spent its own page budget, *independently of whether the last page it
 * served was full*. A population of 937 therefore ends on a short tenth page
 * carrying `window_exhausted: true`, and everyone who matches has in fact
 * been shown. So the page's OWN SIZE is what settles it -- see `endingFor`
 * -- and there are three endings, not two:
 *
 * - `exhausted` -- the population ran out before the budget did. Everyone.
 * - `window-short` -- the budget ran out, but on a short page, so the
 *   population had already run out too. Also everyone, and it says so.
 * - `window-full` -- the budget ran out on a full page. This is the only
 *   genuinely ambiguous ending: the population may be exactly this size or
 *   much larger, and nothing in the response distinguishes those. The copy
 *   therefore states what was shown and asserts neither.
 *
 * No ending ever shows a `Load more` button -- `next_cursor` is null for all
 * three -- so they are told apart entirely by what renders. Each carries the
 * shared `data-testid="member-list-end"` (one query finds whichever ending
 * happened) plus its own `data-end`, so a test can name the ending it means
 * rather than pattern-matching prose, and collapsing two endings into one
 * cannot pass unnoticed.
 *
 * **Request identity:** callers switching segments are expected to remount
 * this component by keying it on the segment/query identity (the same
 * `key={activeId}`-style reset `Settings.tsx` uses for `LimitsSection`,
 * rather than `SegmentDetail`/`SegmentBuilder`'s own two-ref split) --
 * `SegmentDetail` does this. That discards this component's whole state,
 * including whatever page was in flight, the instant the thing being
 * fetched changes identity, which is simpler than plumbing a second
 * answer-id ref through a child that has no other reason to know its
 * caller navigated. Within ONE mounted instance, though, a member page
 * response is still a response: `requestIdRef` guards against a slower,
 * older fetch (e.g. a retry issued after a still-pending request) applying
 * itself after a newer one already landed. The `Load more` button is
 * disabled while a fetch is in flight, which closes off the obvious way to
 * fire two at once, but the guard costs nothing and does not depend on that
 * disabled state staying correct forever.
 */
export function MemberList(props: { fetchPage: (cursor?: string) => Promise<MemberPage> }) {
  const { fetchPage } = props

  const [shown, setShown] = useState(false)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [ending, setEnding] = useState<Ending | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const requestIdRef = useRef(0)
  // What the NEXT retry should ask for -- set before every attempt so a
  // failed first page and a failed later page each retry the request that
  // actually failed, not always the first one.
  const lastAttemptRef = useRef<{ cursor: string | undefined; replace: boolean }>({
    cursor: undefined,
    replace: true,
  })
  // The widest page this walk has served, which is how `endingFor` knows a
  // short page when it sees one. Reset whenever a page REPLACES the
  // accumulated list rather than appending to it -- that is a walk starting
  // over, and carrying a previous walk's widest page into it would measure
  // against a page this walk never saw. Defensive today rather than load
  // bearing: the only `replace` after a successful page is a retry of the
  // first page, where there is nothing yet to carry. It keeps the invariant
  // ("this is the widest page of THIS walk") true by construction instead of
  // by that remaining the case.
  const widestPageRef = useRef(0)

  const load = useCallback(
    (nextCursor: string | undefined, replace: boolean) => {
      const requestId = ++requestIdRef.current
      lastAttemptRef.current = { cursor: nextCursor, replace }
      setLoading(true)
      setError(null)
      fetchPage(nextCursor)
        .then((page) => {
          if (requestId !== requestIdRef.current) return
          const widest = replace
            ? page.members.length
            : Math.max(widestPageRef.current, page.members.length)
          widestPageRef.current = widest
          setMembers((prev) => (replace ? page.members : [...prev, ...page.members]))
          setCursor(page.next_cursor ?? undefined)
          setEnding(endingFor(page, widest))
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return
          setError('Could not load these people. Try again.')
        })
        .finally(() => {
          if (requestId !== requestIdRef.current) return
          setLoading(false)
        })
    },
    [fetchPage],
  )

  const handleShow = useCallback(() => {
    setShown(true)
    load(undefined, true)
  }, [load])

  const handleLoadMore = useCallback(() => {
    load(cursor, false)
  }, [load, cursor])

  const handleRetry = useCallback(() => {
    const { cursor: retryCursor, replace } = lastAttemptRef.current
    load(retryCursor, replace)
  }, [load])

  if (!shown) {
    return (
      <Button type="button" size="sm" variant="outline" onClick={handleShow}>
        Show people
      </Button>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {members.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Person</TableHead>
              <TableHead>First seen</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => (
              <TableRow key={m.person_id}>
                <TableCell className="font-mono text-muted-foreground">{m.person_id}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(m.first_seen)}</TableCell>
                <TableCell className="text-muted-foreground">{formatDate(m.last_seen)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {error != null && (
        <div className="flex items-center gap-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={handleRetry}>
            Retry
          </Button>
        </div>
      )}

      {/* Two endings, one true sentence. `exhausted` ran the population out
       * before the budget; `window-short` ran the budget out on a page the
       * server could not fill, which means the population had run out too.
       * They are distinct facts about the WALK and identical facts about the
       * PEOPLE, so they share the words and are told apart by `data-end` --
       * an operator is owed the second, not the first. */}
      {error == null && (ending === 'exhausted' || ending === 'window-short') && (
        <p
          data-testid="member-list-end"
          data-end={ending}
          className="text-sm text-muted-foreground"
        >
          That is everyone who matches.
        </p>
      )}

      {/* The one ambiguous ending: the budget ran out on a page the server
       * filled, so the population is either exactly this size or larger and
       * nothing here can tell. Says what was shown and asserts neither --
       * NOT "more people match" (which was printed for every fully-shown
       * population between one full page and the window ceiling) and not
       * "that is everyone" either. Making this exact needs the segment's own
       * `person_count`, which this component is deliberately not given. */}
      {error == null && ending === 'window-full' && (
        <p
          data-testid="member-list-end"
          data-end="window-full"
          className="text-sm text-muted-foreground"
        >
          Showing the {members.length} people this preview reaches. There may be more.
        </p>
      )}

      {error == null && ending == null && cursor != null && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={handleLoadMore}
          disabled={loading}
        >
          Load more
        </Button>
      )}

      {loading && members.length === 0 && <p className="text-sm text-muted-foreground">Loading…</p>}
    </div>
  )
}
