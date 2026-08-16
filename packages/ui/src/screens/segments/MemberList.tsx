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

/**
 * The people a segment matches, paged behind an explicit "Show people"
 * click -- never fetched just because the count was. `fetchPage` is the
 * ONLY thing this component knows about where members come from: it takes
 * the cursor to resume from (`undefined` for the first page) and returns
 * one page. That keeps this component ignorant of `ApiClient`,
 * `previewSegment` vs `previewSavedSegment`, and the project/segment id --
 * `SegmentDetail` closes over all of that when it builds the callback.
 *
 * **The one thing this component exists to get right:** a walk ends for two
 * different reasons, and `next_cursor: null` is true of both, so the ending
 * is read from `window_exhausted` instead. `false` means the population
 * itself is exhausted -- that IS everyone who matches. `true` means the
 * walk's own page budget ran out with more people left to see -- a
 * DIFFERENT fact, and this is a preview of a population, not an export of
 * it. Rendering these two endings with the same words lets an operator
 * conclude their segment is smaller than it actually is; this project has
 * shipped exactly that conflation once already (a count of zero rendering
 * identically to "never ran"). Neither ending ever shows a `Load more`
 * button -- `next_cursor` is null either way -- so the two are told apart
 * entirely by which sentence renders, which is why each carries its own
 * `data-testid="member-list-end"` rather than sharing one with a variable
 * class.
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
  const [ending, setEnding] = useState<'exhausted' | 'window' | null>(null)
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

  const load = useCallback(
    (nextCursor: string | undefined, replace: boolean) => {
      const requestId = ++requestIdRef.current
      lastAttemptRef.current = { cursor: nextCursor, replace }
      setLoading(true)
      setError(null)
      fetchPage(nextCursor)
        .then((page) => {
          if (requestId !== requestIdRef.current) return
          setMembers((prev) => (replace ? page.members : [...prev, ...page.members]))
          setCursor(page.next_cursor ?? undefined)
          setEnding(
            page.next_cursor == null ? (page.window_exhausted ? 'window' : 'exhausted') : null,
          )
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

      {error == null && ending === 'exhausted' && (
        <p data-testid="member-list-end" className="text-sm text-muted-foreground">
          That is everyone who matches.
        </p>
      )}

      {/* A different fact from the one above: the population is NOT known to
       * be exhausted, this walk's own page budget is. Never "that is
       * everyone" -- there is more, this preview just cannot reach it. */}
      {error == null && ending === 'window' && (
        <p data-testid="member-list-end" className="text-sm text-muted-foreground">
          More people match than this preview can show.
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
