import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { type ApiClient, ApiError } from '../api/client.js'
import type { DashboardTileInput, Dashboard as DashboardWire, ResolvedTile } from '../api/types.js'
import { useProject } from '../app/ProjectContext.js'
import { ROUTES } from '../app/Router.js'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import { AddTilePicker } from './dashboards/AddTilePicker.js'
import { DashboardTile } from './dashboards/DashboardTile.js'
import { HomeStar } from './dashboards/HomeStar.js'
import { createRunQueue } from './dashboards/runQueue.js'
import { MAX_TILES } from './dashboards/tileRequest.js'
import { describeError } from './funnels/errors.js'
import { RangePicker } from './shared/RangePicker.js'
import { AUTO, rangeIncomplete, readRange, writeRange } from './shared/range.js'

const EDIT_KEY = 'edit'

/** This screen's noun for `describeError`, so a failure here reads as a
 *  message about the dashboard rather than about a funnel. */
const NOUN = 'dashboard'

/** A tile as a `PATCH` carries it: the reference only. `report` is resolved
 *  server-side and must never be sent back. */
function toInput(t: ResolvedTile): DashboardTileInput {
  return { kind: t.kind, report_id: t.report_id, width: t.width }
}

function swap(tiles: ResolvedTile[], i: number, j: number): ResolvedTile[] {
  const next = tiles.slice()
  const a = next[i]
  const b = next[j]
  if (a === undefined || b === undefined) return tiles
  next[i] = b
  next[j] = a
  return next
}

/**
 * `/dashboards/:id`: one screen, two modes. View is the name, the shared
 * range picker (URL state, never stored) and the tile grid. Edit adds
 * rename, home, delete, add-tile and the per-tile controls. Every edit
 * action is ONE `PATCH` carrying only the field it changed, and local state
 * is replaced by the response -- there is no unsaved state and no Save.
 * A failed PATCH leaves the previous layout on screen.
 *
 * The range is the viewer's question, not the dashboard's: the same rule
 * every saved report keeps. It lives in the URL by `readRange`/`writeRange`
 * and is never sent in a PATCH.
 */
export function Dashboard(props: { client: ApiClient; onUnauthorized?: () => void }) {
  const { client, onUnauthorized } = props
  const { activeId } = useProject()
  const { id: rawId } = useParams()
  const id = rawId !== undefined && /^\d+$/.test(rawId) ? Number(rawId) : null
  const navigate = useNavigate()
  const [search, setSearch] = useSearchParams()
  const editing = search.get(EDIT_KEY) === '1'

  // `DashboardTile`'s run effect depends on the IDENTITY of `range`, `tile`
  // and `queue` (see its own dependency comment), so all three have to
  // survive a re-render that changed none of them. Two consequences here:
  //
  //  - the range is rebuilt only when one of the THREE keys that make one
  //    changes, not whenever the search string does. Deriving it from
  //    `search` directly -- or memoising on `search.toString()` -- would
  //    re-run every tile each time `?edit=1` went in or out of the URL,
  //    which is a full page of queries for a button that changes nothing
  //    about what was asked.
  //  - tiles are handed to the grid straight off the fetched or patched
  //    response. Mapping them into fresh objects on render would defeat the
  //    tile's identity check just as thoroughly, and invisibly.
  const rangeParam = search.get('range')
  const fromParam = search.get('from')
  const toParam = search.get('to')
  const range = useMemo(() => {
    const only = new URLSearchParams()
    if (rangeParam !== null) only.set('range', rangeParam)
    if (fromParam !== null) only.set('from', fromParam)
    if (toParam !== null) only.set('to', toParam)
    return readRange(only)
  }, [rangeParam, fromParam, toParam])

  const queue = useRef(createRunQueue()).current

  const [dash, setDash] = useState<DashboardWire | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [nameDraft, setNameDraft] = useState('')

  // What the screen is currently ASKING ABOUT, as one value. A response is
  // applied only if this still matches what the request was made for.
  //
  // The load effect has a `cancelled` flag and needs nothing else -- its
  // cleanup runs when `activeId` or `id` changes. `patch()` cannot use that
  // shape: it is a handler, not an effect, so there is no cleanup to hang
  // the flag on and the request outlives the render that started it. A
  // `PATCH` still in flight when the project switches used to call
  // `setDash(theOldProjectsDashboard)` on top of the new project's load,
  // and every tile then ran the old project's questions scoped to the NEW
  // project's id. `id` is in the key as well as `activeId`: navigating
  // between two dashboards is the same race with the same consequence.
  const asking = useRef<string | null>(null)
  useEffect(() => {
    asking.current = activeId == null || id === null ? null : `${activeId}:${id}`
  }, [activeId, id])

  useEffect(() => {
    if (activeId == null || id === null) return
    let cancelled = false
    setDash(null)
    setNotFound(false)
    setLoadError(null)
    // A save failure belongs to the dashboard it was reported for. Left
    // standing, it reads as a failure of the one now on screen.
    setSaveError(null)
    client
      .dashboard(activeId, id)
      .then((d) => {
        if (cancelled) return
        setDash(d)
        setNameDraft(d.name)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        if (err instanceof ApiError && err.status === 404) setNotFound(true)
        else setLoadError(describeError(err, NOUN))
      })
    return () => {
      cancelled = true
    }
  }, [client, activeId, id, onUnauthorized])

  const patch = useCallback(
    (body: { name?: string; tiles?: DashboardTileInput[]; is_home?: boolean }) => {
      if (activeId == null || id === null) return
      const askedFor = `${activeId}:${id}`
      setSaving(true)
      setSaveError(null)
      client
        .patchDashboard(activeId, id, body)
        .then((d) => {
          if (asking.current !== askedFor) return
          // A `PATCH` that carried no `tiles` keeps the PREVIOUS tiles
          // reference. The response is parsed JSON, so `d.tiles` and every
          // tile object in it are fresh references even when the layout came
          // back byte-identical -- and `DashboardTile`'s effect fires on
          // `tile` IDENTITY. Without this, renaming a dashboard or setting it
          // as home drops every tile to a skeleton and re-queries the whole
          // page, for an edit that changed no tile at all.
          //
          // Safe because the server cannot change a dashboard's layout in
          // response to a body that did not mention it: `tiles` is
          // "omit means unchanged", the same contract every other patch field
          // in `api/types.ts` keeps.
          setDash((prev) => (body.tiles === undefined && prev ? { ...d, tiles: prev.tiles } : d))
          setNameDraft(d.name)
        })
        .catch((err: unknown) => {
          // Same check as the success path, and for the same reason: this
          // failure is about a dashboard that is no longer on screen.
          if (asking.current !== askedFor) return
          if (err instanceof ApiError && err.status === 401) {
            onUnauthorized?.()
            return
          }
          // The previous layout stays on screen: nothing was applied
          // locally before the response, so a failure needs no rollback --
          // which is the whole reason there is no optimistic update here.
          // `describeError`'s 409 branch already names this screen's noun.
          setSaveError(describeError(err, NOUN))
        })
        // UNCONDITIONAL, unlike the two handlers above: `saving` is what
        // holds the edit controls shut, and skipping it for a response that
        // arrived late would leave the screen frozen for the dashboard that
        // is now on it.
        .finally(() => setSaving(false))
    },
    [client, activeId, id, onUnauthorized],
  )

  const tiles = dash?.tiles ?? []
  const sendTiles = (next: ResolvedTile[]) => patch({ tiles: next.map(toInput) })

  function setEditing(on: boolean) {
    // Leaving edit mode withdraws an open delete confirmation. Without this
    // the panel -- and its `Delete dashboard` button -- outlives the mode
    // that raised it: `Done` would leave a destructive prompt on a screen
    // that no longer shows any other edit control, and the operator who
    // pressed Done has already said they are finished editing.
    if (!on) setConfirmingDelete(false)
    setSearch(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (on) next.set(EDIT_KEY, '1')
        else next.delete(EDIT_KEY)
        return next
      },
      { replace: true },
    )
  }

  function commitName() {
    const trimmed = nameDraft.trim()
    if (dash === null || trimmed === '' || trimmed === dash.name) {
      setNameDraft(dash?.name ?? '')
      return
    }
    patch({ name: trimmed })
  }

  function handleDelete() {
    if (activeId == null || id === null) return
    setSaving(true)
    client
      .deleteDashboard(activeId, id)
      .then(() => navigate(ROUTES.dashboards))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.()
          return
        }
        setSaveError(describeError(err, NOUN))
      })
      .finally(() => setSaving(false))
  }

  const incomplete = rangeIncomplete(range)

  if (id === null || notFound) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-sm text-destructive">
          This dashboard no longer exists.
        </p>
        <Link to={ROUTES.dashboards} className="font-medium text-primary text-sm hover:underline">
          Back to dashboards
        </Link>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* The sidebar's Dashboards entry and the Lyraflow mark both now open
       * the starred dashboard directly rather than the list (O1/O2), so the
       * list is no longer one click away from here the way it used to be.
       * This is that click back, in both modes -- there was never a reason
       * to bury it behind Edit. */}
      <Link to={ROUTES.dashboards} className="text-sm text-muted-foreground hover:underline">
        All dashboards
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {editing && dash ? (
          <Input
            aria-label="Dashboard name"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            maxLength={200}
            className="max-w-sm"
          />
        ) : (
          <h1 className="min-w-0 break-words font-semibold text-lg">{dash?.name ?? 'Dashboard'}</h1>
        )}
        <div className="flex flex-wrap gap-2">
          {/* In BOTH modes, unlike every other control in this group. Which
           * dashboard `/` opens is a fact about this dashboard rather than
           * an edit to its contents, and it was the one thing a viewer
           * could not see without entering a mode that also offers Delete.
           * The star reads as a state when it is filled, which the old
           * `Home`/`Set as home` button could not do at a glance. */}
          {dash && (
            <HomeStar
              isHome={dash.is_home}
              disabled={saving}
              onToggle={() => patch({ is_home: !dash.is_home })}
            />
          )}
          {dash && editing && !confirmingDelete && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete
            </Button>
          )}
          {dash && (
            <Button type="button" size="sm" onClick={() => setEditing(!editing)}>
              {editing ? 'Done' : 'Edit'}
            </Button>
          )}
        </div>
      </div>

      {editing && confirmingDelete && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="text-foreground">
            Delete this dashboard? Its reports are kept. This cannot be undone.
          </p>
          <div className="ml-auto flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setConfirmingDelete(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={saving}
            >
              Delete dashboard
            </Button>
          </div>
        </div>
      )}

      {loadError != null && (
        <p role="alert" className="text-destructive text-sm">
          {loadError}
        </p>
      )}
      {saveError != null && (
        <p role="alert" className="text-destructive text-sm">
          {saveError}
        </p>
      )}

      {dash?.stale && (
        <p role="alert" className="text-destructive text-sm">
          This dashboard's stored layout cannot be read by this version. Add tiles to replace it, or
          delete it.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <RangePicker
          id="dashboard-range"
          value={range}
          onChange={(next) => setSearch((prev) => writeRange(prev, next), { replace: true })}
        />
      </div>
      {incomplete && (
        <p className="text-muted-foreground text-sm">Pick both dates, or choose a preset range.</p>
      )}
      {/* `auto` sends NO range, so each endpoint applies its own default
       * window -- a stats query defaults by the report's interval, retention
       * and funnels each have their own. Tiles under `auto` are therefore
       * showing different periods side by side, which the picker's own
       * label ("Default for this resolution") reads as one shared setting.
       * Saying so is the fix rather than making `auto` resolve to some
       * concrete span here: that would answer a question no report's own
       * screen answers that way, and every tile would silently stop matching
       * the report it links to. */}
      {range.preset === AUTO && (
        <p className="text-muted-foreground text-sm">
          At this setting each tile uses its own report's default window. Pick a preset to give
          every tile the same range.
        </p>
      )}

      {/* No ternary on the range: while a custom range is unfinished the grid
       * is not rendered at all, so no tile mounts and nothing runs. Falling
       * back to `auto` here would silently answer a question nobody asked --
       * a page of results for a range still being typed. */}
      {dash && activeId != null && !incomplete && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {tiles.map((tile, i) => (
            <DashboardTile
              key={`${i}-${tile.kind}-${tile.report_id}`}
              client={client}
              projectId={activeId}
              tile={tile}
              range={range}
              queue={queue}
              editing={editing}
              onUnauthorized={onUnauthorized}
              actions={
                editing
                  ? {
                      onMoveUp: i > 0 ? () => sendTiles(swap(tiles, i, i - 1)) : undefined,
                      onMoveDown:
                        i < tiles.length - 1 ? () => sendTiles(swap(tiles, i, i + 1)) : undefined,
                      onToggleWidth: () =>
                        sendTiles(
                          tiles.map((t, j) =>
                            j === i ? { ...t, width: t.width === 'half' ? 'full' : 'half' } : t,
                          ),
                        ),
                      onRemove: () => sendTiles(tiles.filter((_, j) => j !== i)),
                      // Every action above sends the whole array as it
                      // stands on screen, and that array is the pre-edit one
                      // until the response lands.
                      disabled: saving,
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {dash && !editing && tiles.length === 0 && !dash.stale && (
        <p className="text-muted-foreground text-sm">
          No tiles yet. Edit this dashboard to add saved reports.
        </p>
      )}

      {/* The picker is REPLACED at the cap rather than left on screen
       * disabled: the server refuses a thirteenth tile with a field-level
       * 400, which reaches an operator as "This dashboard could not be
       * read: tiles -- …" for an add they had every reason to think was
       * allowed. Saying the number here is the only place it can be acted
       * on. */}
      {dash && editing && activeId != null && tiles.length >= MAX_TILES && (
        <p className="text-muted-foreground text-sm">
          A dashboard holds at most {MAX_TILES} tiles. Remove one to add another.
        </p>
      )}

      {dash && editing && activeId != null && tiles.length < MAX_TILES && (
        <AddTilePicker
          client={client}
          projectId={activeId}
          onUnauthorized={onUnauthorized}
          disabled={saving}
          onAdd={(t) => patch({ tiles: [...tiles.map(toInput), t] })}
        />
      )}
    </div>
  )
}
