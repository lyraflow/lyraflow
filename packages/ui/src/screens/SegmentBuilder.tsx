import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { AST_VERSION } from '@lyraflow/core/segments/ast.js'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
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
 * name reverts to the server's copy on next load. This does not reach the
 * server merely from opening a segment -- see `TreeEditor`'s own doc
 * comment on why that matters -- only from an explicit Save.
 */
export function SegmentBuilder(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
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

      {!stale && <TreeEditor value={root} onChange={setRoot} />}

      {!stale && !hasConditions && (
        <p className="text-sm text-muted-foreground">
          No conditions yet. Add one to define who belongs in this segment.
        </p>
      )}

      <div className="flex gap-2">
        <Button type="button" onClick={handleSave} disabled={!canSave || saving}>
          Save
        </Button>
      </div>
    </div>
  )
}
