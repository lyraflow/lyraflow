import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { AST_VERSION } from '@lyraflow/core/segments/ast.js'
import { costWarnings } from '@lyraflow/core/segments/validate.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { SegmentPreview } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES, segmentPath } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'
import { TreeEditor } from './segments/TreeEditor.js'

/** A brand-new segment's starting tree: a legal, empty root group. The same
 * shape `removeAt` leaves behind when an operator empties an existing
 * segment down to nothing (see `tree.ts`'s own doc comment on `removeAt`)
 * -- one empty state below, whether the tree started empty or was emptied
 * by editing, not two. */
const EMPTY_ROOT: FilterNode = { kind: 'group', op: 'and', children: [] }

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
 * Task 4 wires this to `TreeEditor` and to create/tree-update. What it
 * deliberately does NOT do yet: send a name change on save in edit mode.
 * `updateSegmentTree` is "tree update ONLY. deliberately cannot carry a
 * name" (its own doc comment in `api/client.ts`) -- Task 9 adds the split
 * save a rename requires (`renameSegment` alone vs `updateSegmentTree`
 * alone vs both, asserted on the REQUEST, not the control). Until then,
 * retyping the name in edit mode and saving updates the tree only; the
 * name reverts to the server's copy on next load. Saving still does not
 * reach the server merely from opening a segment -- only from an explicit
 * Save.
 *
 * Task 6 threads `client`/`projectId`/`onUnauthorized` down into
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
 * Task 7 -- live counts, the reason this editor justifies a frontend
 * framework at all (ADR 009). `costWarnings` is a PURE function of `root`,
 * no round trip -- computed fresh on every render and never fetched. A
 * cheap tree (no warnings) previews itself automatically, `debounceMs`
 * after the operator stops editing; a tree carrying a warning never does,
 * and waits for an explicit click on "Run" instead, which works
 * regardless of warnings. Two things keep this from doing the wrong thing:
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
  const [root, setRoot] = useState<FilterNode>(EMPTY_ROOT)
  // A stale segment's stored tree no longer parses (`Segment`'s own doc
  // comment in `api/types.ts`) -- handing it to TreeEditor as though it
  // were a legal FilterNode risks a crash on data that isn't one. Mirrors
  // how `Segments.tsx`'s `filterSummary` treats staleness as an expected,
  // named state rather than something to render and hope.
  const [stale, setStale] = useState(false)

  const [loading, setLoading] = useState(isEditing)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // Task 7. `dirty` is false until the first REAL edit (`handleRootChange`,
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

  useEffect(() => {
    if (!isEditing || activeId == null || editId == null) return
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    client
      .segment(activeId, editId)
      .then((s) => {
        if (cancelled) return
        setName(s.name)
        setStale(s.stale)
        if (!s.stale) setRoot(s.filter as FilterNode)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setLoadError('Could not load this segment. Reload to try again.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, editId, isEditing, onUnauthorized])

  const trimmedName = name.trim()
  // Controller correction 2 (binding): the root can legitimately be empty
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
  // pre-empts the one empty state the correction names.
  const hasConditions = root.kind !== 'group' || root.children.length > 0
  const canSave = trimmedName !== '' && hasConditions && activeId != null && !stale

  // The real edit path -- wired to `TreeEditor`'s `onChange` below, never
  // called by the fetch effect above. Marks the tree dirty (see this
  // component's own doc comment on why that gate exists) and invalidates
  // any preview answer still in flight for whatever the tree looked like
  // before THIS change, whether or not this change goes on to issue a new
  // request of its own.
  function handleRootChange(next: FilterNode) {
    setDirty(true)
    answerIdRef.current += 1
    setRoot(next)
  }

  // Pure, synchronous, no round trip -- recomputed on every render from
  // `root` alone, exactly the property that makes a live count affordable
  // (this component's own doc comment).
  const warnings = useMemo(() => costWarnings({ ast_version: AST_VERSION, filter: root }), [root])
  const hasCostWarning = warnings.length > 0

  const runPreview = useCallback(() => {
    if (activeId == null || !hasConditions || stale) return
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
  }, [client, activeId, hasConditions, stale, root, onUnauthorized])

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

  function handleSave() {
    if (!canSave || activeId == null) return
    setSaving(true)
    setSaveError(null)
    const query = { ast_version: AST_VERSION, filter: root }
    const request =
      isEditing && editId != null
        ? client.updateSegmentTree(activeId, editId, query)
        : client.createSegment(activeId, trimmedName, query)
    request
      .then((segment) => navigate(isEditing ? segmentPath(segment.id) : ROUTES.segments))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setSaveError('Could not save this segment. Nothing was changed on the server.')
      })
      .finally(() => setSaving(false))
  }

  if (isEditing && loading) {
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
        {/* Explicit override, always available -- the only way a costly tree
         * ever gets counted, and a plain way to force a fresh number for a
         * cheap one too, regardless of `dirty`/debounce state. */}
        <Button
          type="button"
          variant="outline"
          onClick={runPreview}
          disabled={!hasConditions || stale || activeId == null || previewing}
        >
          Run
        </Button>
      </div>

      {previewError != null && (
        <p role="alert" className="text-sm text-destructive">
          {previewError}
        </p>
      )}

      {/* No page-level `WarningPanel` here, deliberately -- Task 7's own
       * brief: "render it against the offending condition, not as prose in
       * a panel", which `ConditionRow` already does above, per node, via
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
            <p
              data-testid="segment-preview-count"
              className="text-2xl font-semibold text-foreground"
            >
              {previewResult.person_count.toLocaleString('en-US')}
            </p>
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
