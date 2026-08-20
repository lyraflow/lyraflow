import { CONTEXT_FIELDS } from '@lyraflow/core/segments/ast.js'
import { MEMBER_PAGE_SIZE } from '@lyraflow/core/segments/limits.js'
import { Fragment, useCallback, useRef, useState } from 'react'
import type { MemberRow } from '../../api/types.js'
import type { DetailField } from '../../components/DetailList.js'
import { DetailPanel, DetailSection, ExpandToggle, FieldList } from '../../components/DetailList.js'
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
 * a caller always has all of these once it decides to ask for members at all.
 *
 * `person_count` comes from THE SAME RESPONSE as the members it accompanies,
 * and that is the whole reason it is here rather than passed down from
 * `SegmentDetail`. The count on that screen can be a cache hit up to the
 * server's TTL old -- its own comment says so -- and comparing a stale count
 * against a page length is exactly how "that is everyone" gets printed over a
 * truncated preview. The response's count and its members share an `as_of`,
 * and the cursor pins the whole walk to that instant, so this comparison is
 * between two facts about one moment (#120). */
export interface MemberPage {
  members: MemberRow[]
  next_cursor: string | null
  window_exhausted: boolean
  person_count: number
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
 * Which ending a just-received page represents.
 *
 * `MEMBER_PAGE_SIZE` is now imported from the compiler that enforces it,
 * rather than inferred from the widest page this walk happened to serve.
 * The inference was correct and was a workaround: the constant lived in
 * `packages/core/src/segments/compile.ts` with no subpath export, and
 * duplicating the number here risked a UI copy drifting LARGER than the
 * server's real page size -- which would read a full page as short and call
 * a truncated preview "everyone". Measuring could only fail conservatively,
 * so it was the right trade against a constant that was unreachable. It is
 * reachable now (#120), so the real number is used and the inference is gone
 * along with the ref that carried it across pages.
 *
 * `totalShown` is the length of the whole walk, not of this page -- the
 * comparison against the population is about everything rendered so far.
 */
function endingFor(page: MemberPage, totalShown: number): Ending | null {
  if (page.next_cursor != null) return null
  if (!page.window_exhausted) return 'exhausted'
  if (page.members.length < MEMBER_PAGE_SIZE) return 'window-short'
  // The budget ran out on a full page. That used to be the end of what could
  // be said. The response's own count settles it: if the walk has shown the
  // whole population, the ambiguity is not ambiguous at all.
  //
  // `>=` rather than `===` deliberately. Equality is the case that matters,
  // but a count SMALLER than what was rendered can only mean the two
  // disagree, and in that direction everyone matching has still been shown --
  // whereas a strict equality check would fall through to the hedge and
  // under-claim. Over-claiming is the direction this file refuses; this is
  // the other one.
  return totalShown >= page.person_count ? 'window-short' : 'window-full'
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
/**
 * The four context fields recorded ONLY as first-touch.
 *
 * `memberProjection` asks for every context field at `latest` scope, and for
 * these four that returns the first-touch value anyway -- referrer and the
 * UTM trio are stored once, at acquisition, because for an acquisition
 * attribute the original value is the one that means anything (README,
 * *One caveat on `context`*). Labelling them "latest" alongside `os` and
 * `city`, which really are current, would be the panel asserting a freshness
 * the column does not have.
 */
const FIRST_TOUCH_ONLY: readonly string[] = ['referrer', 'utm_source', 'utm_medium', 'utm_campaign']

/** `utm_campaign` -> `UTM campaign`, `device_type` -> `Device type`. */
function labelFor(field: string): string {
  const words = field.replace(/_/g, ' ')
  const cased = field.startsWith('utm_')
    ? `UTM ${words.slice(4)}`
    : words.charAt(0).toUpperCase() + words.slice(1)
  return FIRST_TOUCH_ONLY.includes(field) ? `${cased} (first touch)` : cased
}

/**
 * The context a member row carries, in the order `CONTEXT_FIELDS` declares --
 * driven off core's own list rather than a copy, so a field added there
 * appears here rather than being silently dropped by a screen that never
 * heard about it.
 *
 * A row's context values are typed `string | number | Record<...>` only
 * because `MemberRow`'s index signature has to cover its named members; every
 * context column is a `String` in ClickHouse, so anything else here is a
 * response that has changed shape, and `String()` on it would print
 * "[object Object]" as though it were a value.
 */
function contextFields(member: MemberRow): DetailField[] {
  return CONTEXT_FIELDS.filter((f) => typeof member[f] === 'string').map((f) => ({
    label: labelFor(f),
    value: member[f] as string,
  }))
}

/**
 * The person's traits, both maps merged back into the one bag `identify()`
 * was called with.
 *
 * Same reasoning as the event feed's own properties panel: the string/number
 * split is a storage detail of `person_traits`, not something the person who
 * wrote `{ plan: "pro", seats: 12 }` should reassemble, and a key is only
 * ever in one of the two. Sorted by key, because the maps arrive in whatever
 * order ClickHouse built them and an open row must not reshuffle between two
 * pages of the same walk.
 */
function traitFields(member: MemberRow): DetailField[] {
  const strings = Object.entries(member.traits ?? {}).map(([label, value]) => ({ label, value }))
  const numbers = Object.entries(member.traits_num ?? {}).map(([label, value]) => ({
    label,
    // String(), not toLocaleString(): these are the values a caller sent, and
    // a trait that happens to be an id or a year must not read back as
    // "2,026" in a panel whose job is to show what was received.
    value: String(value),
  }))
  return [...strings, ...numbers].sort((a, b) => a.label.localeCompare(b.label))
}

/**
 * Everything a member row knows about one person.
 *
 * Empty attributes are dropped and COUNTED, exactly as the event feed's panel
 * does it: ten context fields of which a browser-only visitor carries five
 * would bury the five, and saying nothing would imply the list was complete.
 * "Not shown" and "not recorded" are different facts.
 *
 * Traits get the same treatment one level up: the row carries at most
 * `TRAITS_PER_MEMBER_MAX` of them and `trait_total` says how many the person
 * really has, so a capped list says so rather than reading as all of them.
 */
function PersonDetail(props: { member: MemberRow; id: string }) {
  const { member, id } = props
  const context = contextFields(member)
  const present = context.filter((f) => f.value !== '')
  const emptyCount = context.length - present.length
  const traits = traitFields(member)
  const heldBack = Math.max(0, (member.trait_total ?? traits.length) - traits.length)

  return (
    <DetailPanel id={id}>
      <DetailSection title="Attributes">
        <FieldList fields={present} />
        {emptyCount > 0 && (
          <p className="mt-2 text-muted-foreground text-xs">
            {emptyCount} more {emptyCount === 1 ? 'attribute has' : 'attributes have'} no value
            recorded for this person and {emptyCount === 1 ? 'is' : 'are'} not listed.
          </p>
        )}
      </DetailSection>
      <DetailSection title="Traits">
        {traits.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No traits recorded for this person. They appear here once your app calls identify().
          </p>
        ) : (
          <FieldList fields={traits} />
        )}
        {heldBack > 0 && (
          <p className="mt-2 text-muted-foreground text-xs">
            {heldBack} more {heldBack === 1 ? 'trait is' : 'traits are'} recorded for this person
            and not shown here.
          </p>
        )}
      </DetailSection>
    </DetailPanel>
  )
}

export function MemberList(props: { fetchPage: (cursor?: string) => Promise<MemberPage> }) {
  const { fetchPage } = props

  const [shown, setShown] = useState(false)
  const [members, setMembers] = useState<MemberRow[]>([])
  // Keyed by `person_id`, never by row index: `Load more` appends a page and
  // a retry can replace the whole list, so an index would move the open
  // panel onto a different person -- traits that are not the ones the reader
  // clicked, with nothing on screen to say so. An id no longer in the list
  // simply matches nothing, which collapses the panel.
  const [expandedId, setExpandedId] = useState<string | null>(null)
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

  const load = useCallback(
    (nextCursor: string | undefined, replace: boolean) => {
      const requestId = ++requestIdRef.current
      lastAttemptRef.current = { cursor: nextCursor, replace }
      setLoading(true)
      setError(null)
      fetchPage(nextCursor)
        .then((page) => {
          if (requestId !== requestIdRef.current) return
          // The ending is decided against the length of the WHOLE walk, so
          // it is computed here from the same value the state update uses
          // rather than read back from `members` (which this closure would
          // see at its stale value).
          setMembers((prev) => {
            const next = replace ? page.members : [...prev, ...page.members]
            setEnding(endingFor(page, next.length))
            return next
          })
          setCursor(page.next_cursor ?? undefined)
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
              <TableHead className="w-8">
                <span className="sr-only">Details</span>
              </TableHead>
              <TableHead>Person</TableHead>
              <TableHead>First seen</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((m) => {
              const open = expandedId === m.person_id
              const detailId = `person-detail-${m.person_id}`
              const toggle = () => setExpandedId(open ? null : m.person_id)
              return (
                <Fragment key={m.person_id}>
                  <TableRow className="cursor-pointer" onClick={toggle}>
                    <TableCell className="pr-0">
                      <ExpandToggle
                        open={open}
                        describes={m.person_id}
                        controls={detailId}
                        onToggle={toggle}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-muted-foreground">{m.person_id}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(m.first_seen)}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(m.last_seen)}
                    </TableCell>
                  </TableRow>
                  {open && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={4} className="whitespace-normal bg-muted p-0">
                        <PersonDetail member={m} id={detailId} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
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
