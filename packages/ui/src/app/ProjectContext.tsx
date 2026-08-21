import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Project } from '../api/types.js'

/** Same `lf-` prefix as the theme's own key, and the same storage, for the
 * same reason: this is a preference belonging to whoever is sitting at this
 * browser, not to the session or the server. */
const KEY = 'lf-project'

/**
 * The project this browser was last switched to, or `null` if it has never
 * been switched, or if what is stored is not a project id.
 *
 * Exported so a test can pin the parsing rather than reach into
 * localStorage's key name. `Number('')` is 0 and `Number('  8 ')` is 8, so a
 * blank value would otherwise pass as an id and a padded one would work by
 * accident -- both are checked here rather than left to whatever the value
 * happens to do when it reaches `projects.some(...)`.
 */
export function readStoredProjectId(): number | null {
  const raw = localStorage.getItem(KEY)
  if (raw === null || raw.trim() === '') return null
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Which project this provider should open on: the one this browser last
 * switched to, if it is still one of `projects`, and `initialId` otherwise.
 *
 * The membership check is the whole point of resolving rather than simply
 * restoring. A stored id outlives the thing it names -- a project deleted by
 * hand in Postgres (there is no UI for it yet, #60), a different install
 * reached at the same origin, a different operator signing in on this
 * browser -- and an `activeId` naming a project the session does not carry
 * scopes every request on every screen to something the server will refuse,
 * with a switcher showing no selection and no way back except clearing site
 * data.
 */
function resolveInitialId(projects: Project[], initialId: number | null): number | null {
  const remembered = readStoredProjectId()
  if (remembered != null && projects.some((p) => p.id === remembered)) return remembered
  return initialId
}

export interface ProjectState {
  projects: Project[]
  activeId: number | null
  setActiveId(id: number): void
  // Merges a patch into the named project's entry so every consumer of
  // `projects` -- the header switcher today, this screen's own limits
  // section -- agrees with what a successful save just changed, without
  // a second round trip to re-fetch the whole list.
  updateProject(id: number, patch: Partial<Project>): void
  // Appends a newly-created project to the list -- the one operation
  // `updateProject` cannot do, because a brand-new project has no existing
  // entry to merge a patch into. Additive ONLY: this must never be a
  // whole-list replace fed by a re-fetch (#89). A `POST /v1/projects`
  // followed by `GET /v1/projects` has no ordering guarantee against a
  // concurrent `PATCH /v1/project` elsewhere in the same tab -- if the GET
  // was issued before the PATCH committed server-side, its stale response
  // would win a replace even though `updateProject`'s merge already applied
  // the newer value, and the header switcher and this screen's own list
  // would silently disagree with what was just saved. `POST /v1/projects`'s
  // response now carries every field a `Project` needs (`CreatedProject`,
  // `api/types.ts`), so there is no re-fetch to race in the first place.
  addProject(project: Project): void
  // Drops a destroyed project from the list. Paired with `addProject` and
  // deliberately NOT a whole-list re-fetch, for the same reason (#89): a GET
  // issued here could still be in flight when a concurrent PATCH commits,
  // and its stale response would win the replace.
  removeProject(id: number): void
}

const Ctx = createContext<ProjectState | null>(null)

/**
 * Holds the project every request is scoped to.
 *
 * Deliberately a context rather than a prop threaded through screens: the
 * value is read by the API layer on essentially every call, and threading it
 * is how one screen ends up reading a different project than the header
 * shows.
 */
export function ProjectProvider(props: {
  projects: Project[]
  /**
   * Which project to open on when this browser has no remembered choice, or
   * when the remembered one is not in `projects`. The FALLBACK, not the
   * answer -- see `resolveInitialId`.
   */
  initialId: number | null
  children: ReactNode
}) {
  const [activeId, setActiveIdState] = useState<number | null>(() =>
    resolveInitialId(props.projects, props.initialId),
  )
  const [projects, setProjects] = useState<Project[]>(props.projects)

  /**
   * Remembers the switch, so a reload comes back to the project the operator
   * was looking at rather than to whichever one the server happened to list
   * first. Written here, on the deliberate act, and nowhere else: persisting
   * the resolved `activeId` in an effect would also write the fallback, which
   * turns "never chose" into a choice on the first render and makes a later
   * change to what `initialId` means invisible to anyone who has ever loaded
   * this page.
   */
  const setActiveId = useCallback((id: number) => {
    localStorage.setItem(KEY, String(id))
    setActiveIdState(id)
  }, [])

  // Same reasoning as the `activeId` sync below: the caller's `projects`
  // prop can legitimately change (a freshly-mounted provider given a newly
  // loaded session -- `App`'s post-wizard and post-login paths, both of
  // which replace this provider rather than update it in place), and this
  // provider's own local edits from `updateProject`/`addProject` must not
  // survive past that -- the fresh list from the server is always the
  // newer truth. NOT how a project created from inside an already-mounted
  // provider reaches this list -- that is `addProject`, deliberately never
  // a re-fetch; see its own doc comment (#89).
  useEffect(() => {
    setProjects(props.projects)
  }, [props.projects])

  // `useState`'s initial value is read once, on mount -- a caller whose own
  // `initialId` changes on a later render (a re-loaded session naming a
  // different first project, or a test driving this the same way) would
  // otherwise leave `activeId` pointing at a project that no longer exists
  // for this provider, with no way back short of a full remount. This
  // syncs it without disturbing a project the user picked by hand via
  // `setActiveId`: that only ever moves in response to `initialId` itself
  // changing, never on an unrelated re-render.
  //
  // The ref is what keeps that true on MOUNT. Effects run after the first
  // render too, and this one used to fire with the value `useState` had just
  // resolved -- harmless while that value WAS `props.initialId`, and a
  // clobber the moment it became the remembered project instead: the feed
  // would flash the restored project and then snap back to the first one,
  // which is the bug this whole change is about. Comparing against the last
  // `initialId` actually seen makes "changed" mean changed.
  //
  // And it re-resolves rather than assigning: a remembered project that is
  // still in the new list is still the one the operator asked for, and the
  // membership check is exactly what this effect exists to enforce.
  const lastInitialId = useRef(props.initialId)
  useEffect(() => {
    if (props.initialId === lastInitialId.current) return
    lastInitialId.current = props.initialId
    setActiveIdState(resolveInitialId(props.projects, props.initialId))
  }, [props.initialId, props.projects])

  // `removeProject` (below) sets `activeId` to `null` when the project that
  // just vanished was the active one, rather than resolving the fallback
  // itself -- it only has the PREVIOUS `projects` list in scope inside its
  // own updater, not the filtered one `setProjects`'s updater computes.
  // This is what actually resolves that `null` to the first survivor, the
  // moment one exists: every screen stays scoped to a project that exists,
  // and `null` only ever persists when nothing survives (`App.tsx`'s
  // wizard case, a later task). Watching internal `projects`/`activeId`
  // rather than the `props.initialId` the effect above tracks -- a removal
  // changes neither of those props.
  useEffect(() => {
    const first = projects[0]
    if (activeId === null && first !== undefined) {
      setActiveIdState(first.id)
    }
  }, [activeId, projects])

  const updateProject = useCallback((id: number, patch: Partial<Project>) => {
    setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }, [])

  // Guards against ever appending the same project twice -- a caller
  // retrying after a slow response whose creation actually succeeded is the
  // ordinary way that would happen. Silently a no-op rather than replacing
  // the existing entry: any edit to it since creation (an `updateProject`
  // merge from a limits save) would otherwise be exactly the kind of
  // clobber this method exists to prevent.
  const addProject = useCallback((project: Project) => {
    setProjects((prev) => (prev.some((p) => p.id === project.id) ? prev : [...prev, project]))
  }, [])

  const removeProject = useCallback((id: number) => {
    setProjects((prev) => prev.filter((p) => p.id !== id))
    // The active project may be the one that just vanished. Falling back to
    // the first survivor keeps every screen scoped to a project that exists;
    // `null` is reachable only when nothing survives, which is `App.tsx`'s
    // wizard case (Task 8).
    setActiveIdState((prev) => (prev === id ? null : prev))
  }, [])

  const value = useMemo(
    () => ({ projects, activeId, setActiveId, updateProject, addProject, removeProject }),
    [projects, activeId, setActiveId, updateProject, addProject, removeProject],
  )
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

export function useProject(): ProjectState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useProject outside ProjectProvider')
  return v
}
