import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Project } from '../api/types.js'

interface ProjectState {
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
  initialId: number | null
  children: ReactNode
}) {
  const [activeId, setActiveId] = useState<number | null>(props.initialId)
  const [projects, setProjects] = useState<Project[]>(props.projects)

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
  useEffect(() => {
    setActiveId(props.initialId)
  }, [props.initialId])

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

  const value = useMemo(
    () => ({ projects, activeId, setActiveId, updateProject, addProject }),
    [projects, activeId, updateProject, addProject],
  )
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

export function useProject(): ProjectState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useProject outside ProjectProvider')
  return v
}
