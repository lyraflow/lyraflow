import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { LyraEvent, Person } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { DetailSection } from '../components/DetailList.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { DeleteButton } from './people/DeleteButton.js'
import { ExportButton } from './people/ExportButton.js'
import { IdentityHeader } from './people/IdentityHeader.js'
import { Timeline } from './people/Timeline.js'
import { personPath, readPersonId } from './people/params.js'
import { AttributesSection, TraitsSection } from './shared/PersonFields.js'

/**
 * What the screen currently knows, independent of whether an id is even in
 * the URL -- `id === null` (no lookup attempted yet) is handled by the
 * caller before this ever matters, so every member here assumes a fetch was
 * or is being made.
 */
type Status =
  | { kind: 'loading' }
  | { kind: 'not-found' }
  | { kind: 'fragmented' }
  | { kind: 'error' }
  | { kind: 'loaded'; person: Person }

/**
 * What the context panel is entitled to say, which is not the same question
 * as "do we have an event".
 *
 * Three states, because there are three facts and the panel's copy asserts
 * a different one in each:
 *
 * - `pending` -- the timeline has not reported back. Either it is still in
 *   flight, or it failed (`Timeline` deliberately does not call
 *   `onNewestEvent` on a failure, so a failure stays here). The panel says
 *   the timeline has not loaded, which is a statement about THIS SCREEN and
 *   is true in both cases.
 * - `empty` -- the timeline loaded and returned zero events. The panel says
 *   there was nothing to read context from, which is a statement about the
 *   DATA and is only sayable because the query actually ran.
 * - `event` -- the newest event, which is the latest context by definition.
 *
 * `empty` used to be folded into `pending`, and the panel told the operator
 * the timeline "has not loaded" for a timeline that had loaded fine. That
 * was wrong on its own terms, and it was also the DEFAULT rendering for
 * every lapsed person while the timeline's first page was mis-anchored
 * (see `Timeline`'s docstring) -- a false progress claim sitting on top of
 * a real, separate defect, which is the shape that makes a bug take two
 * sessions instead of one.
 */
type Context = { kind: 'pending' } | { kind: 'empty' } | { kind: 'event'; event: LyraEvent }

/**
 * The lookup box, shared by the empty state and by a 404 -- a failed lookup
 * returns HERE rather than to a dead end, with `draft` still holding what
 * was typed so it can be corrected rather than retyped (the same rule
 * `ProjectsSection` applies to its own confirm field).
 */
function LookupForm(props: {
  draft: string
  onChange: (value: string) => void
  onSubmit: () => void
  error?: ReactNode
}) {
  return (
    <form
      className="flex max-w-xl flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        props.onSubmit()
      }}
    >
      <div className="flex flex-col gap-2">
        {/* NOT "anonymous id". `resolvePersonScope`'s device fallback
          * reaches an anonymous id only through `identity_bindings`, and
          * only `identify()` ever writes a row there -- so an anonymous id
          * belonging to a visitor who has never been identified resolves to
          * nobody and this screen 404s on it, even though the feed is
          * showing their events. Measured: two `track` calls under
          * `visitor-anon-1` with no `identify()`, and `GET
          * /v1/persons/visitor-anon-1` answers `404 person_not_found`. A
          * label promising it works is a promise the server does not keep,
          * and on a young install where almost nothing has been identified
          * it is wrong more often than it is right. `#18` is the open
          * limitation; this label stops advertising past it. */}
        <Label htmlFor="people-lookup">
          User id, or the anonymous or device id of someone already identified
        </Label>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            id="people-lookup"
            className="max-w-64"
            value={props.draft}
            onChange={(e) => props.onChange(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={props.draft.trim() === ''}>
            Look up
          </Button>
        </div>
      </div>
      {props.error != null && (
        <p role="alert" className="text-destructive text-sm">
          {props.error}
        </p>
      )}
    </form>
  )
}

/**
 * The chrome every non-loaded branch shares -- the page heading, plus
 * whatever that branch has to say beneath it.
 *
 * Pulled out rather than repeated five times (one per `Status` member plus
 * the no-id state) because three more tasks mount into this file -- the
 * timeline, the export button, the delete button -- and the moment any of
 * them adds shared chrome (a toolbar for the two buttons is the obvious
 * case), that change would otherwise have to be applied by hand in five
 * places, with "four of five" the likely outcome. Cheapest to fix at five
 * branches; only gets worse after.
 */
function Screen(props: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="font-semibold text-lg">People</h1>
      {props.children}
    </div>
  )
}

/**
 * A person profile -- one stitched identity, its traits, and (from Task 7)
 * the events it did.
 *
 * The id lives in the URL as `?id=`, read/written through
 * `people/params.ts` rather than a route param -- see that module's own
 * doc comment for why a path segment does not survive a hard refresh for a
 * caller-supplied id.
 *
 * A 404 here is not "no such person" -- `person.ts`'s own docstring names
 * three indistinguishable causes (never sent, erased by a deletion request,
 * or aged out under retention) and the copy below says all three, because
 * telling them apart is exactly what an operator checking an erasure needs
 * and "no such person" would answer wrong for two of the three causes.
 */
export function People(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const location = useLocation()
  const navigate = useNavigate()
  const id = readPersonId(location.search)

  const [draft, setDraft] = useState(id ?? '')
  const [status, setStatus] = useState<Status>({ kind: 'loading' })
  // Fed by the timeline's own first page -- `pending` until that second
  // fetch reports back, which is why `AttributesSection` below is gated on
  // it rather than always rendered against `{}`. The two panels come from
  // two different requests and fail independently; this is what lets the
  // context panel say why it has nothing instead of silently asserting an
  // empty one. See `Context` above for why "nothing yet" and "nothing
  // there" are two states and not one.
  const [context, setContext] = useState<Context>({ kind: 'pending' })
  // `useCallback`, and it is not decoration: this is in `Timeline`'s fetch
  // effect's dependency array (that component's own doc comment on the prop
  // says so), so an inline arrow would be a new function every render and
  // the first page would re-fetch forever. Empty deps -- `setContext` is a
  // `useState` dispatch and is itself stable, so this closure never needs
  // rebuilding.
  const onNewestEvent = useCallback((event: LyraEvent | null) => {
    setContext(event == null ? { kind: 'empty' } : { kind: 'event', event })
  }, [])
  // Bumped by `DeleteButton.onDeleted` to force the person-read effect
  // below to run again against the SAME id -- the erasure itself does not
  // change the URL, so `id` alone never changes and the effect would
  // otherwise never re-fire. Re-running it is what turns a completed
  // deletion into the 404 branch Task 6 built: the correct, self-verifying
  // end, because it proves the erasure by failing to find the person
  // rather than by trusting the poll's own "completed" status.
  const [reloadToken, setReloadToken] = useState(0)

  // Keeps the lookup box in step with the URL -- both for a fresh navigation
  // (submitting the form below) and for a direct load of `/people?id=…`
  // (a pasted link, or a hard refresh on a 404): either way, whatever the
  // URL names is also what the box should show if the lookup fails.
  useEffect(() => {
    setDraft(id ?? '')
  }, [id])

  // `reloadToken` is deliberately unused inside the effect body below -- it
  // exists only to force this effect to re-run against the SAME id after a
  // deletion completes, since neither `client` nor `id` themselves change
  // (see the doc comment on `reloadToken` above). Removing it from the
  // dependency array is exactly the bug it exists to prevent: a completed
  // deletion would stop re-reading, and the profile would keep showing the
  // erased person's data.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (id === null || activeId == null) return
    let cancelled = false
    setStatus({ kind: 'loading' })
    // A stale newest event from whoever was looked up before must not
    // survive into this lookup's context panel while its own timeline is
    // still loading -- and it must go back to `pending`, not to `empty`:
    // nothing has been asked about this person yet.
    setContext({ kind: 'pending' })
    client
      .person(activeId, id)
      .then((person) => {
        if (!cancelled) setStatus({ kind: 'loaded', person })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        if (err instanceof ApiError && err.status === 404) {
          setStatus({ kind: 'not-found' })
          return
        }
        if (
          err instanceof ApiError &&
          err.status === 400 &&
          err.code === 'person_history_too_fragmented'
        ) {
          setStatus({ kind: 'fragmented' })
          return
        }
        setStatus({ kind: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, id, onUnauthorized, reloadToken])

  function submit() {
    const trimmed = draft.trim()
    if (trimmed === '') return
    navigate(personPath(trimmed))
  }

  if (id === null) {
    return (
      <Screen>
        <LookupForm draft={draft} onChange={setDraft} onSubmit={submit} />
      </Screen>
    )
  }

  if (status.kind === 'fragmented') {
    return (
      <Screen>
        {/* The 400 copy, verbatim. Past `MAX_PERSON_RANGE_CLAUSES` (200)
         * device windows, this route refuses to assemble the profile in one
         * query -- a real answer, not a bug, and one this screen names
         * rather than rendering as a broken page. `lyraflow persons get`
         * still reads them, in chunks.
         *
         * `role="alert"` matches the 404 and generic-error branches below --
         * all three are "we cannot show you this person, and here is why",
         * and a screen-reader user should not get an assertive announcement
         * for two of the three and silence for this one. */}
        <p role="alert">
          <strong>This person&apos;s history spans more than 200 device windows</strong>, which is
          more than this screen can assemble in one query. They are still readable through the API —{' '}
          <code className="font-mono">lyraflow persons get {id}</code> — which walks their history
          in chunks.
        </p>
      </Screen>
    )
  }

  if (status.kind === 'not-found') {
    return (
      <Screen>
        <LookupForm
          draft={draft}
          onChange={setDraft}
          onSubmit={submit}
          error={
            <span data-testid="person-not-found">
              {/* The 404 copy, verbatim -- the sentence this screen exists
               * to get right. A 404 here means one of FOUR things and the
               * API cannot tell them apart, so this says all four rather
               * than picking one and being wrong for the other three.
               *
               * Three of them come from `person.ts`'s own docstring (never
               * sent, erased, aged out). The fourth is not in that
               * docstring and was found by probing: a visitor who has never
               * been identified. `resolvedPersonExpr` falls back to
               * `anonymous_id` for an unbound event, so their events carry
               * that id and the feed both shows them and LINKS HERE with
               * it -- but `resolvePersonScope` reaches a device only
               * through `identity_bindings`, which only `identify()` ever
               * writes, so the read resolves to nobody. Measured: two
               * `track` calls under `visitor-anon-1`, both visible in the
               * feed, and `GET /v1/persons/visitor-anon-1` answering `404
               * person_not_found`.
               *
               * It goes FIRST, not last, because on a fresh install almost
               * nothing has been identified and this is what most feed rows
               * lead to. An operator who has just clicked a person out of
               * the feed and been told "no event was ever recorded under
               * this id" has been contradicted by the screen they came
               * from, which is how a correct message still destroys trust
               * in the tool. Tracked as `#18`; naming it here is the honest
               * half of not fixing it in this change. */}
              <strong>
                Nothing to show for <code className="font-mono">{id}</code>.
              </strong>{' '}
              That means one of four things and the API cannot tell them apart. Most often, on a
              project where little has been identified yet: this id belongs to a visitor who has
              never been identified, so their events exist and are visible in the feed, but nothing
              has ever tied that id to a person and there is no profile to assemble. Otherwise: no
              event was ever recorded under this id in this project; everything recorded was erased
              by a deletion request; or every event aged out under this project&apos;s retention
              window. If you expected someone here, check the id and the project.
            </span>
          }
        />
      </Screen>
    )
  }

  if (status.kind === 'error') {
    return (
      <Screen>
        <p role="alert" className="text-destructive text-sm">
          Could not load this person. Reload to try again.
        </p>
      </Screen>
    )
  }

  if (status.kind === 'loading') {
    return <Screen>{null}</Screen>
  }

  const { person } = status
  return (
    <div className="flex flex-col gap-6">
      <IdentityHeader person={person} />
      {/* Guarded the same way the timeline below is -- both actions need a
       * project to call against, and `activeId` is `null` only in the
       * sliver of a render between mount and the project context settling.
       * The two privacy actions sit side by side: export reads, delete
       * erases, and an operator reaching for one is often about to reach
       * for the other.
       *
       * A `key` derived from `person.person_id` on BOTH, prefixed per
       * button since `key` is scoped to this list of children and two
       * sibling elements sharing the bare id as their key is itself a
       * React warning, regardless of the two being different component
       * types.
       *
       * `<Routes>` never remounts `People` on an id change -- the id lives
       * in the query string (`people/params.ts`'s own docstring explains
       * why) -- so navigating from A's profile to B's (e.g. a person link
       * out of `MemberList`/`AcceptedTable`) hands `ExportButton` and
       * `DeleteButton` the SAME fiber under a new `personId`, unless
       * something forces a remount. Something already does, today: the
       * `status.kind === 'loading'` branch above returns `<Screen>{null}
       * </Screen>`, a different root element type from this branch's raw
       * `<div>`, and the id-keyed effect sets that status SYNCHRONOUSLY
       * before its fetch -- so every id change already unmounts this whole
       * subtree for one render, then remounts it fresh once the new
       * person loads. Verified directly (not just reasoned about): a probe
       * effect logging mount/unmount inside `DeleteButton` shows
       * MOUNT-A / UNMOUNT-A / MOUNT-B on an A-to-B navigation with NO key
       * present at all, and `People.test.tsx`'s own mid-flow navigation
       * tests pass keyless against the code as it stands today.
       *
       * The key is still kept, as an INDEPENDENT second guard -- the same
       * "defence in depth, deliberately unpinned" shape `Router.tsx`
       * already documents for `FunnelBuilder`/`SegmentBuilder`'s identical
       * reconciliation gap (see that file's own comment). Proven
       * independent by the same probe with the loading reset temporarily
       * removed: keyless, the navigation tests fail -- `DeleteButton`'s
       * `confirming`/`typed`/`deletionId`/`error` (and `ExportButton`'s own
       * `exporting`/`error`) genuinely do survive into B's profile,
       * misreporting which person a destructive/exporting action is
       * mid-flow for, though never acting on the wrong one (both buttons
       * close over `personId` at call time). Keyed, the same modified
       * build passes clean. The two mechanisms are why this survives a
       * later change to EITHER: an optimisation that skips the loading
       * flash for a fast re-fetch, or a future button that forgets to key
       * itself the way `Timeline` already resets its own state instead
       * (its effect's dependency array is `[client, projectId, personId,
       * lastSeen]`, and it is the one component on this screen that needs
       * no key at all). */}
      {activeId != null && (
        <div className="flex flex-wrap items-start gap-2">
          <ExportButton
            key={`export-${person.person_id}`}
            client={client}
            projectId={activeId}
            personId={person.person_id}
            eventCount={person.events}
            onUnauthorized={onUnauthorized}
          />
          <DeleteButton
            key={`delete-${person.person_id}`}
            client={client}
            projectId={activeId}
            personId={person.person_id}
            // Bumping `reloadToken` re-runs the person-read effect against
            // the same id -- see that state's own doc comment for why a
            // re-fetch, rather than trusting `onDeleted` to mean "gone", is
            // the correct end here.
            onDeleted={() => setReloadToken((t) => t + 1)}
            onUnauthorized={onUnauthorized}
          />
        </div>
      )}
      {/*
       * Context comes off the timeline's newest event, not the person read
       * -- `AttributesSection` renders it once that second fetch lands.
       * Rendering it against `{}` in the meantime (or if the timeline never
       * loads at all) would assert this person has no device, browser or
       * country recorded, which is a claim about DATA, and this screen has
       * never actually looked: the timeline fetch either hasn't finished or
       * has failed independently of the person read above, which rendered
       * fine either way.
       */}
      {context.kind === 'event' ? (
        // `LyraEvent` has no index signature of its own (unlike `MemberRow`,
        // which was given one for exactly this reason -- see
        // `PersonFields.tsx`'s own doc comment), so this cast is what
        // `AttributesSection`'s callers all need when their source is a
        // plain, fully-typed interface rather than a row shape built with
        // an index signature already in mind.
        <AttributesSection source={context.event as unknown as Record<string, unknown>} />
      ) : (
        <DetailSection title="Attributes">
          {/* Two sentences, not one, and which one renders is the whole
            * point of `Context` having three members. "has not loaded" is a
            * claim about this screen's own progress; "nothing to read it
            * from" is a claim about the person's data. Saying the first
            * when the second is true tells an operator to wait for
            * something that already happened. */}
          <p className="text-muted-foreground text-sm">
            {context.kind === 'empty'
              ? 'No context to show — this person’s timeline came back with no events, so there is nothing to read a device, browser or location from.'
              : 'No context to show yet — this person’s timeline has not loaded.'}
          </p>
        </DetailSection>
      )}
      <TraitsSection
        traits={person.traits}
        traits_num={person.traits_num}
        trait_total={person.trait_total}
        withheld={person.traits_withheld}
      />
      {activeId != null && (
        <Timeline
          client={client}
          projectId={activeId}
          personId={person.person_id}
          // BOTH bounds, from this same profile read. `lastSeen` alone is
          // not an anchor -- `GET /v1/events` keeps its 24h `since` default
          // under a bare `until`, so the pair is what makes the first page
          // the person's history rather than the empty intersection of
          // their history and the last day. See `Timeline`'s own docstring.
          firstSeen={person.first_seen}
          lastSeen={person.last_seen}
          onNewestEvent={onNewestEvent}
        />
      )}
    </div>
  )
}
