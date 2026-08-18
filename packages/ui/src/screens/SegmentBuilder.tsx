import type { FilterNode, Group } from '@lyraflow/core/segments/ast.js'
import { AST_VERSION } from '@lyraflow/core/segments/ast.js'
import { costWarnings } from '@lyraflow/core/segments/validate.js'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { SegmentPreview } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, segmentPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { formatRelative } from './funnels/format.js'
import { TreeEditor, normaliseRoot } from './segments/TreeEditor.js'
import { completeness } from './segments/warnings.js'

/** A brand-new segment's starting tree: a legal, empty root group. The same
 * shape `removeAt` leaves behind when an operator empties an existing
 * segment down to nothing (see `tree.ts`'s own doc comment on `removeAt`)
 * -- one empty state below, whether the tree started empty or was emptied
 * by editing, not two. */
const EMPTY_ROOT: Group = { kind: 'group', op: 'and', children: [] }

/**
 * Pinned, never shortened to suit a test (an earlier plan shipped a 300ms
 * poll for exactly that reason, on a different screen, and it was reverted
 * -- see `Feed.tsx`'s own `DEFAULT_POLL_INTERVAL_MS`). Injectable via the
 * `debounceMs` prop below; every test drives the DEFAULT, via fake timers,
 * never a shorter one of its own.
 */
export const DEBOUNCE_MS = 600

/**
 * Creates a new segment or edits an existing one -- `useParams().id`
 * decides which, the same split `FunnelBuilder` uses.
 *
 * Wires this to `TreeEditor` and to create/tree-update, and splits the save
 * a rename requires. `PATCH /v1/segments/:id` decides
 * whether to touch the filter tree by whether the request body carries one
 * AT ALL, not by comparing old against new -- so a rename that ships the
 * whole definition resets the segment's cached count snapshot, silently,
 * with a `200` back. `renameSegment` (name only, cannot carry a tree) and
 * `updateSegmentTree` (tree only, cannot carry a name) exist as two
 * separate `ApiClient` methods for exactly this reason (their own doc
 * comments in `api/client.ts`) -- one method with an optional tree would
 * let a caller send it by accident.
 *
 * `originalName`/`originalRoot` below are this screen's belief about what
 * the SERVER holds -- seeded by the load effect and advanced by
 * `handleSave` for whichever of its two requests actually commits, since
 * after a partial failure the fetched values describe a state that no
 * longer exists. A belief about one segment under one project, so that
 * advance happens only while this screen still describes the segment the
 * request was issued for (`guardedByFormGeneration`). That is the reference `handleSave` compares the CURRENT
 * `name`/`root` against to decide what actually changed. Content equality
 * (`JSON.stringify`), not the `dirty` flag already tracked: `dirty`
 * answers "has TreeEditor's onChange ever fired", which a negate-twice
 * round trip (back to the original shape) still leaves true, and sending a
 * tree that already matches the server's own copy would trip the exact
 * snapshot-reset this split exists to avoid. Only the fields that changed
 * are ever sent -- a save with neither changed issues no request at all
 * and simply navigates, which is the only way "click Save having changed
 * nothing" can be trusted not to cost the segment its count.
 *
 * Saving still does not reach the server merely from opening a segment --
 * only from an explicit Save.
 *
 * Threads `client`/`projectId`/`onUnauthorized` down into
 * `TreeEditor` -- unused directly by this component, needed only so a
 * `behavior` leaf's `BehaviourForm`, at whatever depth, can reach the
 * schema-autocomplete endpoints. Gated on `activeId != null` the same way
 * `canSave` already is: there is no project to scope those requests to
 * otherwise. The three server-side tree caps (`MAX_TREE_NODES`,
 * `MAX_TREE_DEPTH`, `MAX_BEHAVIOR_NODES`) are also enforced from here down
 * -- computed inside `GroupCard` from the SAME `root` this component owns,
 * so "Add condition"/"Add group" disable before a save could ever reach the
 * server's own `validateTree` rejection.
 *
 * Live counts -- the interaction that justifies this screen being a
 * stateful client rather than a form post. `costWarnings` is a PURE
 * function of `root`, no round trip -- computed fresh on every render and
 * never fetched. A cheap tree (no warnings) previews itself automatically,
 * `debounceMs` after the operator stops editing; a tree carrying a warning never does,
 * and waits for an explicit click on "Run" instead, which works
 * regardless of warnings. Neither path previews a tree the server cannot
 * parse -- see `runPreview`'s own `draft.complete` guard. Two things keep this
 * from doing the wrong thing:
 *
 * - `dirty` -- false until the FIRST real edit (`handleRootChange`, wired
 *   to `TreeEditor`'s `onChange`), separately from the effect that SEEDS
 *   `root` from a fetched segment in edit mode. Without it, merely opening
 *   an existing (cheap) segment for editing would itself fire a preview --
 *   exactly the "does not reach the server merely from opening a segment"
 *   promise above, broken for Preview instead of Save. The existing cap
 *   fixtures below (`SegmentBuilder.test.tsx`'s "the three server-side tree
 *   caps") are what pins this: each renders a fetched, cheap, already-valid
 *   tree and asserts `previewSegment` is never called merely from that
 *   load.
 * - the two-ref request/answer split, same shape and same reason as
 *   `FunnelDetail`'s own `requestIdRef`/`answerIdRef` (that file's own doc
 *   comment has the full case analysis; a single counter there once left
 *   Run stuck disabled after an abandoned request). `answerIdRef` moves on
 *   EVERY root change, even one that fires no request of its own (a keypress
 *   that only resets the debounce timer, or a change to a costly tree that
 *   never previews) -- that is what discards an in-flight response for a
 *   tree the operator has already moved on from, the moment it lands, even
 *   before the NEW tree's own request (if any) has been issued.
 *   `requestIdRef` moves only when `runPreview` actually calls
 *   `previewSegment`, and gates `previewing`: only the most recently ISSUED
 *   call's `.finally` may clear it, so an older call settling late cannot
 *   re-enable Run (or clear the spinner) while a newer one is still open.
 */
export function SegmentBuilder(props: {
  client: ApiClient
  onUnauthorized?: () => void
  debounceMs?: number
}) {
  const { client, onUnauthorized, debounceMs = DEBOUNCE_MS } = props
  const { activeId } = useProject()
  const navigate = useNavigate()
  const params = useParams<{ id: string }>()
  const rawEditId = params.id == null ? null : Number(params.id)
  const editId = rawEditId != null && Number.isSafeInteger(rawEditId) ? rawEditId : null
  const isEditing = editId != null

  const [name, setName] = useState('')
  // Always ALREADY NORMALISED (`normaliseRoot`, `TreeEditor.tsx`), hence
  // `Group` rather than `FilterNode`. Every write to it below goes through
  // `normaliseRoot`, so the tree `costWarnings` is computed from and the
  // tree `TreeEditor` renders are one object with one set of paths. A
  // `FilterNode` here would let a bare-leaf root back in, and the editor
  // would silently render it one level deeper than the warning paths
  // address -- which is exactly how every warning on such a segment went
  // missing.
  const [root, setRoot] = useState<Group>(EMPTY_ROOT)
  // The name/tree the SERVER is believed to hold. Seeded by the
  // load effect below -- see this component's own doc comment for why
  // `handleSave` compares against THESE rather than the `dirty` flag --
  // and advanced by `handleSave` for whichever of its two requests
  // actually commits, because after a partial save the fetched values no
  // longer describe the server. `originalRoot` stays `null` in create mode
  // (there is no prior tree to compare against; a create always sends the
  // whole thing) and while a fetched segment is stale (editing is disabled
  // entirely, so nothing ever reads it).
  const [originalName, setOriginalName] = useState('')
  const [originalRoot, setOriginalRoot] = useState<Group | null>(null)
  // A stale segment's stored tree no longer parses (`Segment`'s own doc
  // comment in `api/types.ts`) -- handing it to TreeEditor as though it
  // were a legal FilterNode risks a crash on data that isn't one. Mirrors
  // how `Segments.tsx`'s `filterSummary` treats staleness as an expected,
  // named state rather than something to render and hope.
  const [stale, setStale] = useState(false)

  // The identity this screen's state describes: the project it is scoped
  // to and the segment addressed by the URL. A plain `loading` boolean
  // cannot express the invariant that matters here -- "the state on screen
  // belongs to the segment currently addressed" -- because a boolean is
  // set by an effect and is therefore stale for exactly as long as it
  // takes that effect to run after the identity changed. `loadedIdentity`
  // is compared against the CURRENT identity during render, so the moment
  // the header project switcher moves, `loaded` is false in the very same
  // render -- with no window in which the previous segment's tree is
  // saveable under the new project's id.
  const identity = `${activeId ?? 'none'}:${editId ?? 'new'}`
  const [loadedIdentity, setLoadedIdentity] = useState<string | null>(null)
  // Create mode has nothing to load; an empty form IS its loaded state.
  // Set ONLY by a load that succeeded, so a 404/500 leaves it false and
  // `canSave` below refuses -- there is no separate `loadError` term in
  // `canSave`, deliberately: two overlapping terms would each be
  // unfalsifiable while the other stood, and neither could be pinned by a
  // test of its own.
  const loaded = !isEditing || loadedIdentity === identity
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // `dirty` is false until the first REAL edit (`handleRootChange`,
  // below) -- separately from the fetch effect's own `setRoot(s.filter)`,
  // which must never itself count as one. See this component's own doc
  // comment for why that distinction is load-bearing.
  const [dirty, setDirty] = useState(false)
  const [previewResult, setPreviewResult] = useState<SegmentPreview | null>(null)
  // Captured alongside the result it answers, not before the call --
  // mirrors `FunnelBuilder`'s own `previewedDefinition`/`previewStale`: the
  // one honest reference point is the tree a landed result actually
  // answers, which changes only when a NEW result is accepted, never merely
  // because a field was edited.
  const [previewedRoot, setPreviewedRoot] = useState<FilterNode | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const requestIdRef = useRef(0)
  const answerIdRef = useRef(0)

  // The address the FORM belongs to, which is not the same thing as
  // `identity`. An existing segment is addressed by both the project and
  // the id -- project 1's segment 7 and project 2's segment 7 are two
  // different segments and their forms must never be confused. A segment
  // that does not exist yet is addressed by the ROUTE alone: `/segments/new`
  // is one blank form, and `createSegment` takes the project as an argument
  // at save time, so nothing an operator composes there is bound to the
  // project it was drafted under.
  const formIdentity = isEditing ? identity : 'new'
  const resetIdentityRef = useRef<string | null>(null)
  const resetFormIdentityRef = useRef<string | null>(null)

  // How many times the COMMITTED form address has changed. Every
  // continuation of a save captures this number where the request is issued
  // and writes only while it is still the current one.
  //
  // A monotonic generation rather than the address itself, deliberately.
  // Comparing addresses cannot tell "never left this form" from "left it and
  // came back": project 1's segment 7 -> project 2's segment 7 -> back to
  // project 1's segment 7 reads EQUAL on both sides, so a save abandoned two
  // navigations ago passes the comparison and lands on top of the save that
  // replaced it -- clearing that save's in-flight flag, rendering its own
  // failure banner over it, and, when it succeeded, navigating the operator
  // off a form they are still typing into, discarding the work in it. A
  // counter that only ever increases cannot express that case at all: a
  // return trip is strictly two bumps, so a form returned to is a different
  // generation from the identical-looking one it left, and no amount of
  // address equality is consulted. Same reason `runPreview` below counts
  // rather than compares.
  const formGenerationRef = useRef(0)
  const committedFormIdentityRef = useRef(formIdentity)
  // Written from a LAYOUT effect, which runs synchronously inside the commit
  // phase, before the stack unwinds and before any microtask (so before any
  // promise continuation) can interleave. That makes this ref mean exactly
  // "the address of the most recently COMMITTED render", which is the
  // guard's actual definition.
  //
  // NOT written during render. `<BrowserRouter>`/`<MemoryRouter>` wrap every
  // location update in `startTransition` unless passed `useTransitions={false}`,
  // and `AppRouter` does not pass it, so a route change here is a
  // transition-lane render -- one React may yield partway through, replay, or
  // abandon without ever committing. A render-phase write therefore runs
  // AHEAD of the commit, and a Save clicked during such a yield captures an
  // address the operator has not arrived at yet, so its stale write PASSES
  // the guard that exists to drop it. The same write can also be left naming
  // a render that never committed, in which case a live save has every
  // continuation dropped -- including the one that clears the in-flight flag
  // -- and Save strands disabled with no address change left to reset it.
  //
  // NOT a passive `useEffect` either: those are deferred past paint, so the
  // ref genuinely lags a committed change and a promise settling in that gap
  // passes a guard it should fail.
  //
  // NOT COVERED BY A TEST, and deliberately not given one that looks as
  // though it is. `act()` flushes passive effects before any assertion runs
  // and before any hand-settled promise resolves, so a render-phase write, a
  // `useEffect` write and this one are indistinguishable to every fixture in
  // this screen's suite; telling them apart needs a render React abandons or
  // has not yet committed, which nothing available in these tests can
  // produce. This choice rests on the router's transition behaviour
  // described above, not on a passing test.
  useLayoutEffect(() => {
    if (committedFormIdentityRef.current !== formIdentity) {
      committedFormIdentityRef.current = formIdentity
      formGenerationRef.current += 1
    }
  })

  // The invariant: this screen's state must never describe a segment other
  // than the one addressed by (`activeId`, `editId`) right now.
  //
  // The reset below is the load-bearing half, and it runs at the START of
  // every identity change rather than on a successful load. Writing state
  // only on success is what let a FAILED re-load leave the previous
  // segment's name and tree on screen, fully editable, while the URL and
  // the header already named a different segment and a different project
  // -- and `handleSave` then combined that stale tree with the id in the
  // URL and the currently active project, so a switch to a project where
  // this segment does not exist could overwrite a DIFFERENT project's
  // segment 7 with the one the operator had open, wiping its cached count
  // in the process. The four ways in (a failing re-fetch, a 404 after a
  // project switch, edit -> edit, edit -> /segments/new, which React
  // reconciles onto the SAME component instance) are four doors on one
  // room; this closes the room.
  //
  // It is TWO resets, keyed differently, because the state below is not all
  // bound to the same thing:
  //
  // - Anything bound to the IDENTITY -- a count that was computed under one
  //   project, a save attempt issued against one segment -- is invalid the
  //   moment either half moves, in create mode as much as in edit mode. A
  //   count for the project just switched away from must not sit under the
  //   tree that is still on screen.
  // - The FORM -- name, tree, this screen's belief about what the server
  //   holds, and the state of the last save ATTEMPT made from it -- is bound
  //   to the address. Every edit-mode identity change
  //   resets it, including the edit -> `/segments/new` door, which is
  //   precisely the case an early return at the top of this effect used to
  //   skip, leaving a builder navigated to from an edit route pre-filled
  //   with the segment it had just left and one click from silently
  //   duplicating it. But a project switch while composing a NEW segment
  //   does not: there is no identity for that form to be wrong about, and
  //   throwing away half-composed work silently is not a correctness fix.
  //
  // In edit mode the two buckets are the same set of changes (`formIdentity`
  // IS `identity` there), so the split only ever shows in create mode -- and
  // that is where putting the in-flight flag in the wrong bucket bites.
  // Keeping the half-composed form across a project switch while ALSO
  // clearing `saving` on that switch hands the operator a fully populated
  // form with Save re-enabled and the first `createSegment` still open: two
  // clicks, two segments, one under each project. So `saving` and
  // `saveError` describe the last save attempt made from THIS FORM and are
  // reset with the form, which keeps both halves at once -- the work
  // survives the switch, and Save stays disabled until the create settles.
  //
  // Both are keyed off a ref rather than left to the dependency array so
  // that a re-run for some OTHER reason (`onUnauthorized` is re-created by
  // every render of `App`, so a parent render re-runs this effect) cannot
  // clear a save that is still in flight or a count that still answers the
  // tree on screen.
  useEffect(() => {
    if (resetIdentityRef.current !== identity) {
      resetIdentityRef.current = identity
      setPreviewResult(null)
      setPreviewedRoot(null)
      setPreviewError(null)
      setPreviewing(false)
      // A preview issued for the segment/project just navigated away from
      // must not land against this one -- same reasoning as `runPreview`
      // below, bumped here before this identity has issued anything at all.
      // Load-bearing and pinned on its own: `setPreviewResult(null)` above
      // only clears a count that has ALREADY landed, so a request still open
      // across the switch needs this to be discarded when it lands (this
      // file's test `a count still in flight for the project just left...`).
      answerIdRef.current += 1
      // The mirror, kept for symmetry and honestly UNPINNABLE: removing it
      // changes nothing observable, because `setPreviewing(false)` beside it
      // has already cleared the flag this counter gates, and `requestIdRef`
      // only ever increases, so any preview issued after the switch already
      // outranks the abandoned one. It earns its place as the invariant
      // ("nothing issued under the identity just left may write") applied
      // without exception rather than as a second mechanism.
      requestIdRef.current += 1
    }

    if (resetFormIdentityRef.current !== formIdentity) {
      resetFormIdentityRef.current = formIdentity
      setName('')
      setOriginalName('')
      setRoot(EMPTY_ROOT)
      setOriginalRoot(null)
      setStale(false)
      setDirty(false)
      setLoadError(null)
      // A save issued from the form just left may still be in flight. Its
      // own completion is dropped by `guardedByFormGeneration` below, which
      // is why this has to clear the flag here rather than wait for a
      // `.finally` that will never write: otherwise Save stays disabled on
      // the segment now on screen until a request that no longer concerns
      // it happens to settle.
      setSaving(false)
      // The banner belongs to the attempt that raised it, and that attempt
      // was made against the form being replaced. Left standing it reports a
      // failure over a segment that was never saved -- the same class as the
      // guarded catch below, reached without any request being in flight at
      // all.
      setSaveError(null)
      // Load-bearing on its own, and pinned on its own (this file's test
      // `a segment that loaded once is not saveable...`). `loaded` compares
      // `loadedIdentity` against the CURRENT identity, so leaving a
      // successful load's value standing is invisible until the operator
      // RETURNS to an identity that once loaded and now fails: edit 7 (ok)
      // -> edit 8 (fails) -> edit 7 (fails) leaves `loadedIdentity` still
      // reading `1:7` while `identity` reads `1:7` too, and `canSave`'s
      // second mechanism reports a segment as loaded that this screen has
      // just failed to read.
      setLoadedIdentity(null)
    }

    if (!isEditing || editId == null || activeId == null) return
    const requestedIdentity = identity
    let cancelled = false
    client
      .segment(activeId, editId)
      .then((s) => {
        if (cancelled) return
        setName(s.name)
        setOriginalName(s.name)
        setStale(s.stale)
        if (!s.stale) {
          // Normalised HERE, at the one point a stored tree enters this
          // screen's state -- see `normaliseRoot`'s own doc comment.
          // `originalRoot` takes the normalised value too, so a segment
          // whose stored root is a bare leaf and which the operator does
          // not edit still issues NO request on Save: the baseline and the
          // tree on screen are the same shape, and the stored tree cannot
          // gain a wrapper it never had without an actual edit.
          const normalised = normaliseRoot(s.filter as FilterNode)
          setRoot(normalised)
          setOriginalRoot(normalised)
        }
        setLoadedIdentity(requestedIdentity)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setLoadError('Could not load this segment. Reload to try again.')
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, editId, isEditing, identity, formIdentity, onUnauthorized])

  const trimmedName = name.trim()
  /**
   * Whether the tree on screen is STORABLE, and which rows are not
   * finished -- one `safeParse` against the real `FilterNode` schema from
   * core (`completeness`, `segments/warnings.ts`), pure and synchronous
   * like `costWarnings` below, never a second, hand-written notion of
   * "filled in" that would drift from the one the server enforces.
   *
   * The convention it enforces: an empty field means "not filled in yet",
   * the builder may hold an incomplete draft, and Save is refused while it
   * does. Without this, "Add condition" followed by Save shipped a tree
   * with an empty `key` -- `ast.ts` declares it `z.string().min(1)` -- and
   * the operator got a save error for a form this screen had let them
   * build. `.incomplete` goes down the editor so the sentence lands on the
   * row that is actually incomplete rather than in a banner here; see
   * `ConditionRow`.
   */
  const draft = useMemo(() => completeness(root), [root])
  // The root can legitimately be empty
  // -- `removeAt` returns exactly this shape when an operator empties the
  // tree by removing its last condition, and a brand-new segment starts
  // here too. A segment with no conditions is not a segment, so save is
  // disabled rather than letting an empty tree reach the server, where the
  // AST's `children.min(1)` would refuse it with a field error for a state
  // this screen put the operator in.
  //
  // Checked directly on `root.children.length`, not through `countNodes`:
  // a NESTED empty group inside an otherwise non-empty root still leaves
  // the root with at least one child, and is the server's own
  // `children.min(1)` to reject on that inner group -- this screen only
  // pre-empts the one empty state described above. `root` is always a
  // group (see its declaration), so there is no non-group branch to take:
  // a bare-leaf root normalises to a one-child group and reads as having a
  // condition through the same expression.
  const hasConditions = root.children.length > 0
  // `loaded` is the second, independent mechanism behind the reset above:
  // even if some future edit reintroduced a path where stale state
  // survived an identity change, this refuses to write ANY tree to a
  // segment whose own definition this screen has not successfully read
  // under the project it is about to write to.
  // `draft.complete` sits alongside the terms that were already here rather
  // than replacing `hasConditions`: an empty root fails both, but the empty
  // root is the one incomplete state this screen says something about
  // itself ("No conditions yet", below), and it is the one state where
  // there is no row for a message to land on.
  const canSave =
    trimmedName !== '' && hasConditions && draft.complete && activeId != null && !stale && loaded

  // The real edit path -- wired to `TreeEditor`'s `onChange` below, never
  // called by the fetch effect above. Marks the tree dirty (see this
  // component's own doc comment on why that gate exists) and invalidates
  // any preview answer still in flight for whatever the tree looked like
  // before THIS change, whether or not this change goes on to issue a new
  // request of its own.
  function handleRootChange(next: FilterNode) {
    setDirty(true)
    answerIdRef.current += 1
    // `tree.ts` preserves the root's kind, so what comes back from a
    // group-rooted editor is already a group -- `normaliseRoot` is
    // idempotent and here to make that a property of the STATE rather
    // than of a chain of reasoning about a module this screen does not own.
    setRoot(normaliseRoot(next))
  }

  // Pure, synchronous, no round trip -- recomputed on every render from
  // `root` alone, exactly the property that makes a live count affordable
  // (this component's own doc comment).
  const warnings = useMemo(() => costWarnings({ ast_version: AST_VERSION, filter: root }), [root])
  const hasCostWarning = warnings.length > 0

  const runPreview = useCallback(() => {
    if (activeId == null || !hasConditions || stale) return
    // The SAME completeness Save is gated on -- `draft.complete`, one
    // `safeParse` against the real schema, never a second hand-written notion
    // of "filled in" that would drift from it.
    //
    // Adding a condition marks the tree dirty and fired a preview on a tree
    // the server cannot parse (`newCondition()` has always produced an empty
    // `key`), so the operator got an error banner about a condition they had
    // not started filling in. An incomplete tree is simply not previewed; the
    // row-level "not finished" message already explains why, so nothing new
    // is said here.
    //
    // Here rather than only on the button's `disabled`, and both rather than
    // either: an attribute is a hint to a pointer, and this function is also
    // reached by the debounce effect below, which has no attribute at all.
    // `ConditionRow`'s `switchRefusal` is the same arrangement for the same
    // reason. Each half is pinned by its own test -- one asserts the control
    // is disabled, the other drives the automatic path, which the attribute
    // cannot reach.
    if (!draft.complete) return
    const requestId = ++requestIdRef.current
    const answerId = ++answerIdRef.current
    const requestedRoot = root
    setPreviewing(true)
    setPreviewError(null)
    client
      .previewSegment(activeId, { ast_version: AST_VERSION, filter: requestedRoot })
      .then((r) => {
        // Discarded, not merely dimmed, the moment it no longer answers the
        // tree currently on screen -- see this component's own doc comment.
        if (answerId !== answerIdRef.current) return
        setPreviewResult(r)
        setPreviewedRoot(requestedRoot)
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        if (answerId !== answerIdRef.current) return
        setPreviewError('Could not preview this segment.')
      })
      .finally(() => {
        // Only the most recently ISSUED call may clear the spinner -- an
        // older call settling after a newer one is still open must not
        // (this component's own doc comment; `FunnelDetail`'s own
        // `runNow` is the precedent for why a second counter is needed).
        if (requestId !== requestIdRef.current) return
        setPreviewing(false)
      })
  }, [client, activeId, hasConditions, stale, draft.complete, root, onUnauthorized])

  // The auto half of the split: a CHEAP, dirty, non-empty, non-stale tree
  // previews itself `debounceMs` after the most recent edit. A tree
  // carrying a cost warning never reaches this call at all -- not merely
  // debounced longer -- matching "the product already knows which queries
  // are expensive... rather than guessing a debounce long enough for the
  // worst case and useless for the common one" (this component's own doc
  // comment).
  useEffect(() => {
    if (!dirty || hasCostWarning || !hasConditions || stale || activeId == null) return
    const timer = window.setTimeout(runPreview, debounceMs)
    return () => window.clearTimeout(timer)
  }, [dirty, hasCostWarning, hasConditions, stale, activeId, debounceMs, runPreview])

  const previewStale =
    previewResult != null &&
    previewedRoot != null &&
    JSON.stringify(root) !== JSON.stringify(previewedRoot)

  /**
   * The one way this screen writes state after an await.
   *
   * Called ONCE where an async operation is issued, it captures the
   * GENERATION that operation belongs to and returns a wrapper; wrapping
   * every continuation (`.then`, `.catch`, `.finally`) is what makes it
   * structurally impossible for a completion landing after the header
   * project switcher or the router has moved on to write state describing
   * a form this screen no longer shows. The reset above
   * closes that door for state already on screen; this closes it for state
   * that has not landed yet, which is the same invariant with a delay in
   * it. `runPreview`'s `answerIdRef` is the same guard, written out by
   * hand for the one case that needed it first -- a counter there too, and
   * for the same reason: equality on what is being tracked cannot see a
   * value that left and came back.
   *
   * Guarded by the FORM's generation rather than the identity's, because
   * every state write below belongs to the form bucket of the reset above
   * -- the baselines, the failure banner and the in-flight flag are all
   * facts about one form and its last save attempt. That is the rule, and
   * it is what keeps the two in step: state reset with the form is written
   * only while the form is the same one. In edit mode the two generations
   * move together (`formIdentity` IS `identity` there); in create mode the
   * form outlives a project switch, and so must the in-flight flag of the
   * `createSegment` still open against it.
   *
   * The generation is read where the request is ISSUED, from inside a
   * discrete event handler, so it is the generation of the render that
   * handler came from: React dispatches the most recently committed
   * handler, and this ref is written in the commit phase, so the two cannot
   * disagree. Comparing the closure's own `formIdentity` on top would be
   * strictly redundant -- one generation names exactly one address.
   *
   * A wrapper rather than a guard clause at the top of each continuation
   * deliberately: a `.then` that is not wrapped is visible at a glance,
   * whereas one that quietly omits a clause is not -- and the two writes
   * this was introduced for were added, correctly, by a fix that simply
   * did not think about the switcher.
   *
   * What must NOT be wrapped is anything that is true regardless of which
   * segment is on screen: `onUnauthorized` reports a dead session, not a
   * stale screen, and dropping it would leave the operator typing into a
   * form whose every request will 401.
   */
  function guardedByFormGeneration() {
    const issuedFor = formGenerationRef.current
    return function stillCurrent<A extends unknown[]>(write: (...args: A) => void) {
      return (...args: A) => {
        if (formGenerationRef.current !== issuedFor) return
        write(...args)
      }
    }
  }

  function handleSave() {
    if (!canSave || activeId == null) return
    setSaving(true)
    setSaveError(null)
    const stillCurrent = guardedByFormGeneration()

    if (!isEditing || editId == null) {
      // Create has no "what changed" to compute -- the whole definition is
      // new, and lands on the LIST.
      client
        .createSegment(activeId, trimmedName, { ast_version: AST_VERSION, filter: root })
        // The one continuation in this file deliberately left UNGUARDED, and
        // pinned as such (this file's test `a create that lands after a
        // project switch still leaves the form...`). Its destination is the
        // segment list, which names no segment and no project, and it is the
        // only acknowledgement a create ever gets: guarded, it would leave
        // the operator looking at a form whose contents have already been
        // created, with nothing on screen to say so. Unmounting the form is
        // the safe outcome even when the list on the other side is a
        // different project's.
        //
        // What this does NOT rest on any more is "otherwise Save is one
        // click from a duplicate" -- Save is held disabled for the whole
        // time the create is open, by the in-flight flag now sitting in the
        // form bucket of the reset above, whether this navigation happens or
        // not.
        .then(() => navigate(ROUTES.segments))
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            onUnauthorized?.()
            return
          }
          stillCurrent(setSaveError)(
            'Could not save this segment. Nothing was changed on the server.',
          )
        })
        .finally(stillCurrent(() => setSaving(false)))
      return
    }

    // Edit: send only what actually changed, through the method that can
    // ONLY carry that field -- see this component's own doc comment for why
    // sending a tree the server already has resets the count snapshot.
    //
    // Both sides of the name comparison are TRIMMED. A stored name with
    // surrounding whitespace (a CLI-authored segment, a paste) otherwise
    // compares unequal to its own trimmed self, and a tree-only edit
    // issued a rename nobody asked for -- which also made "a save with
    // neither changed issues no request at all", above, untrue of exactly
    // those segments.
    const nameChanged = trimmedName !== originalName.trim()
    const savedRoot = root
    const treeChanged =
      originalRoot == null || JSON.stringify(savedRoot) !== JSON.stringify(originalRoot)
    // LABELLED, because the message below has to name which half landed.
    // `Promise.all` could only report that *something* failed, so the banner
    // asked the operator to retry blind over a server state it could describe
    // and did not (#118).
    const requests: { part: 'name' | 'tree'; run: Promise<unknown> }[] = []
    if (nameChanged) {
      requests.push({
        part: 'name',
        run: client.renameSegment(activeId, editId, trimmedName).then(
          // The baseline advances the instant THIS request commits, not
          // when the save as a whole succeeds. An edit save can fire two
          // PATCHes and `Promise.all` rejects on the first failure, with
          // the other already committed -- leaving the fetch-time snapshot
          // describing a server state that no longer exists. The operator's
          // natural response to a save error is to change something and try
          // again, and with a stale baseline that second save silently
          // dropped whichever field they reverted: rename Old -> New, tree
          // update fails, type `Old` back, save -- and no rename was sent
          // at all, leaving the server holding `New`.
          //
          // Guarded, because a baseline is a belief about ONE segment under
          // ONE project. Writing this one against whatever the screen shows
          // by the time the PATCH lands is how a save that crossed a header
          // project switch made the next segment's untouched Save issue a
          // real request -- and for the tree below, a request that costs
          // that segment its cached count for a tree nobody edited.
          stillCurrent(() => {
            setOriginalName(trimmedName)
          }),
        ),
      })
    }
    if (treeChanged) {
      requests.push({
        part: 'tree',
        run: client
          .updateSegmentTree(activeId, editId, { ast_version: AST_VERSION, filter: savedRoot })
          .then(
            stillCurrent(() => {
              setOriginalRoot(savedRoot)
            }),
          ),
      })
    }

    // `allSettled`, not `all`. `all` rejects the instant either request does
    // and discards the other's outcome, so the screen could not tell "nothing
    // was saved" from "half of it was" -- and said the vaguer thing, which is
    // the one that leaves the operator unable to act (#118).
    Promise.allSettled(requests.map((r) => r.run))
      .then((results) => {
        const failed = requests.filter((_, i) => results[i]?.status === 'rejected')
        const landed = requests.filter((_, i) => results[i]?.status === 'fulfilled')

        // A dead session first, and UNGUARDED, for the same reason as
        // everywhere else here: a 401 is a fact about the session, not about
        // which form is on screen. Checked across every rejection rather than
        // only the first, which is what `Promise.all` happened to surface.
        const unauthorized = results.some(
          (r) => r.status === 'rejected' && r.reason instanceof ApiError && r.reason.status === 401,
        )
        if (unauthorized) {
          onUnauthorized?.()
          return
        }

        if (failed.length === 0) {
          // Guarded: unlike the create branch above, this destination NAMES a
          // segment, and under a project the operator has since switched to
          // it names a different one -- presented as the result of a save
          // that was not made to it.
          stillCurrent(() => {
            navigate(segmentPath(editId))
          })()
          return
        }
        // The message names what actually happened. Every branch here is
        // something the screen can now prove rather than guess:
        //
        //   nothing landed  -> "nothing was changed" is TRUE, and saying so
        //                      spares the operator checking. This is the
        //                      claim the old copy could not safely make and
        //                      therefore never made, even when it held.
        //   half landed     -> name which half. "Try again" alone left them
        //                      to discover a rename they did not know had
        //                      committed.
        //
        // Retry stays honest advice in both: each request advances its OWN
        // baseline the moment it commits, so a second Save -- verbatim or
        // further edited -- re-sends exactly what still differs from what
        // the server now holds.
        //
        // Guarded for the same reason the delete confirmation on
        // `SegmentDetail` is: an error naming "this segment" rendered over a
        // segment that was never saved is a claim about the wrong thing.
        const message =
          landed.length === 0
            ? 'Could not save this segment. Nothing was changed on the server. Try again.'
            : landed[0]?.part === 'name'
              ? 'The name was saved, but the conditions were not. Try again.'
              : 'The conditions were saved, but the name was not. Try again.'
        stillCurrent(setSaveError)(message)
      })
      .finally(stillCurrent(() => setSaving(false)))
  }

  // Derived from the same `loaded` the save guard reads, rather than from
  // a separate `loading` boolean an effect has to keep in step -- one fact,
  // one source. A failed load falls through to the form (empty, by the
  // reset above) so the operator sees the error rather than a spinner that
  // never ends.
  if (isEditing && !loaded && loadError == null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>
  }

  return (
    <div className="flex min-w-0 max-w-2xl flex-col gap-6">
      <h1 className="text-lg font-semibold">{isEditing ? 'Edit segment' : 'Create segment'}</h1>

      {loadError != null && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}

      {stale && (
        <p role="alert" className="text-sm text-destructive">
          This segment's stored filter cannot be read, and cannot be edited here.
        </p>
      )}

      <div className="flex flex-col gap-1">
        <Label htmlFor="segment-name">Name</Label>
        <Input id="segment-name" value={name} onChange={(e) => setName(e.target.value)} />
        {saveError != null && (
          <p role="alert" className="text-sm text-destructive">
            {saveError}
          </p>
        )}
      </div>

      {!stale && activeId != null && (
        <TreeEditor
          value={root}
          onChange={handleRootChange}
          client={client}
          projectId={activeId}
          onUnauthorized={onUnauthorized}
          warnings={warnings}
          incomplete={draft.incomplete}
        />
      )}

      {!stale && !hasConditions && (
        <p className="text-sm text-muted-foreground">
          No conditions yet. Add one to define who belongs in this segment.
        </p>
      )}

      <div className="flex gap-2">
        <Button type="button" onClick={handleSave} disabled={!canSave || saving}>
          Save
        </Button>
        {/* The explicit override for a COST warning -- the only way a costly
         * tree ever gets counted, and a plain way to force a fresh number for
         * a cheap one too, regardless of `dirty`/debounce state.
         *
         * It overrides the cost gate and nothing else. Completeness is not a
         * judgement call the operator can overrule: an incomplete tree is one
         * the server cannot parse, so Run on it buys an error banner about a
         * condition they have not finished writing. Disabled with no sentence
         * beside it here on purpose -- the row that is unfinished already says
         * so, which is the answer, where the page-level version of it would
         * only ask which of forty conditions was meant. */}
        <Button
          type="button"
          variant="outline"
          onClick={runPreview}
          disabled={!hasConditions || !draft.complete || stale || activeId == null || previewing}
        >
          Run
        </Button>
      </div>

      {previewError != null && (
        <p role="alert" className="text-sm text-destructive">
          {previewError}
        </p>
      )}

      {/* No page-level `WarningPanel` here, deliberately -- a warning
       * renders against the offending condition, not as prose in
       * a panel, which `ConditionRow` already does above, per node, via
       * `warningsAt`. A second, vaguer copy here would be exactly the "which
       * of 40 conditions is meant" problem the per-condition rendering
       * exists to avoid. `WarningPanel` is reused on `SegmentDetail`
       * instead, which has no per-condition breakdown to point at. */}
      {!stale && hasConditions && (
        <div
          data-testid="segment-preview"
          data-stale={String(previewStale)}
          className={`flex min-w-0 flex-col gap-3 ${previewStale ? 'opacity-50' : ''}`}
        >
          {previewResult != null ? (
            <>
              <p
                data-testid="segment-preview-count"
                className="text-2xl font-semibold text-foreground"
              >
                {previewResult.person_count.toLocaleString('en-US')}
              </p>
              {/* A count with no instant beside it cannot be told apart
               * from a live one, and this number can be a cache hit up to
               * the server's TTL old -- `previewSegment` deliberately
               * reports the STORED `as_of` on a hit so a client can say
               * so. Same treatment as `FunnelDetail`/`FunnelBuilder`
               * (`formatRelative` on the result's own `as_of`, never on
               * form state), so the two screens that show a live count
               * stop being the only ones in the product that show a bare
               * number. */}
              <p className="text-sm text-muted-foreground">
                as of{' '}
                <span data-testid="segment-preview-as-of">
                  {formatRelative(previewResult.as_of, new Date())}
                </span>
              </p>
              {/* Dimming alone says nothing. Editing a cheap tree into a
               * costly one leaves the previous count on screen at
               * `opacity-50` and NO sentence at all -- the "click Run"
               * line below renders only when there has never been a
               * result, i.e. never in that transition -- so the operator
               * is left reading a number that answers a tree they can no
               * longer see. */}
              {previewStale && (
                <p data-testid="segment-preview-stale-note" className="text-sm">
                  This count is for an earlier version of this segment. Click Run to count the
                  current one.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {previewing
                ? 'Counting…'
                : hasCostWarning
                  ? 'This segment carries a cost warning -- click Run to see a count.'
                  : null}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
