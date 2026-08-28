import { AST_VERSION, Trait as TraitSchema } from '@lyraflow/core/segments/ast.js'
import type { Trait } from '@lyraflow/core/segments/ast.js'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { Button } from '../../components/ui/button.js'
import { MemberList } from '../segments/MemberList.js'
import { TraitForm } from '../segments/TraitForm.js'
import { readTraitQuery, traitSearchPath } from './params.js'

/** What a blank search opens on -- the same triple `ConditionRow`'s own
 * `defaultLeaf` gives a fresh `trait` condition in the segment builder, so a
 * reader who has used that screen finds this one starting in the same
 * place. */
const DEFAULT_TRAIT: Trait = { kind: 'trait', key: '', operator: '=', value: '' }

/**
 * The second way into a person, beside the id lookup beside it: an exact
 * trait predicate, run through the segment engine that already answers one.
 *
 * This is a ONE-NODE segment, not a member of the segment builder's tree --
 * `POST /v1/segments/preview` with `{ ast_version, filter: <this node> }`
 * answers it exactly as it would a saved segment's single condition, and
 * `MemberList` renders the page back precisely as `SegmentDetail` and
 * `StepPeople` already do. Nothing about paging, the three walk endings, or
 * the person link is reimplemented here.
 *
 * **The URL is the state**, the same way `id` is (`params.ts`'s own doc
 * comment) -- `query` below is read straight from the address bar rather
 * than held only in this component, so a trait search survives a reload and
 * is a link an operator can hand to someone else. `draft` is a separate,
 * uncommitted copy: this screen has its own submit, matching the id
 * lookup's `LookupForm`, so typing into the trait/operator/value controls
 * must not change what is on screen (or refetch anything) until Search is
 * pressed.
 *
 * `TraitForm` is reused whole, not rebuilt from `OperatorSelect` /
 * `TraitValueField` / `ClauseValueField` individually -- it already wires
 * those three together, already suggests trait names from `event_schema`
 * (cheap, fetched on mount) without touching the expensive
 * `/v1/schema/trait-values` scan until a value box is focused, and already
 * carries the numeric-vs-string coercion that made `seats = "12"` match
 * nobody where `seats = 12` matched twenty. Reaching for the smaller pieces
 * directly would have reproduced all of that by hand for no reason: this
 * form is not nested inside a group tree, but a trait leaf needs nothing
 * from that context to begin with (`ConditionRow` hands it nothing but
 * `node`/`onChange`/`client`/`projectId` either).
 */
export function TraitSearch(props: {
  client: ApiClient
  projectId: number
  onUnauthorized?: () => void
}) {
  const { client, projectId, onUnauthorized } = props
  const location = useLocation()
  const navigate = useNavigate()
  const query = readTraitQuery(location.search)

  const [draft, setDraft] = useState<Trait>(query ?? DEFAULT_TRAIT)

  // Keeps the draft in step with the URL, the same way `People`'s own
  // `draft` follows `id` -- both a fresh navigation here (Search below) and
  // a direct load of a trait-search link land the same controls the query
  // string names.
  //
  // Recomputed from `location.search` INSIDE the effect rather than
  // depending on `query` itself: `readTraitQuery` returns a fresh object
  // every call, so a dependency on `query` would re-run this effect (and
  // reset whatever was being typed) on every render, not only on a real URL
  // change.
  useEffect(() => {
    setDraft(readTraitQuery(location.search) ?? DEFAULT_TRAIT)
  }, [location.search])

  // The SAME schema the server enforces, not a hand-written "is this
  // filled in" check -- see `params.ts`'s `readTraitQuery` doc comment for
  // why a second notion of validity here would drift from `ast.ts`.
  const complete = TraitSchema.safeParse(draft).success

  function submit() {
    if (!complete) return
    navigate(traitSearchPath(draft))
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
          <legend className="p-0 font-medium text-sm">Find by trait</legend>
          <p className="text-muted-foreground text-xs">
            Match people on a trait set by <code className="font-mono">identify()</code> -- your own
            internal id, a plan, anything you recorded. This is one exact condition, the same kind a
            segment is built from, not a search across every trait at once.
          </p>
          <TraitForm
            id="people-trait-search"
            node={draft}
            onChange={setDraft}
            client={client}
            projectId={projectId}
            onUnauthorized={onUnauthorized}
          />
        </fieldset>
        <div>
          <Button type="submit" size="sm" disabled={!complete}>
            Search
          </Button>
        </div>
      </form>

      {/* Keyed on the submitted query, not the draft -- a new search
       * discards whatever page `MemberList` had loaded, including anything
       * in flight, the same reset `SegmentDetail` uses when its own run
       * changes (see that screen's own comment on its `MemberList` key). */}
      {query != null && (
        <MemberList
          key={traitSearchPath(query)}
          // The click already happened -- pressing Search IS the request,
          // the same reasoning `StepPeople`'s own `autoLoad` doc comment
          // gives for a step/mode selection already being one.
          autoLoad
          fetchPage={(cursor) =>
            client
              .previewSegment(
                projectId,
                { ast_version: AST_VERSION, filter: query },
                { include: ['members'], cursor },
              )
              .then((r) => ({
                members: r.members ?? [],
                next_cursor: r.next_cursor ?? null,
                window_exhausted: r.window_exhausted ?? false,
                person_count: r.person_count,
              }))
              .catch((err: unknown) => {
                // Same 401 routing every other call on this screen does --
                // `MemberList` has no reason to know about `ApiError` or
                // `onUnauthorized`, and still shows its own generic
                // error/Retry for anything that is not a session expiry.
                if (err instanceof ApiError && err.status === 401) onUnauthorized?.()
                throw err
              })
          }
        />
      )}
    </div>
  )
}
