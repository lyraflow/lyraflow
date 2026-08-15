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
  // Replaces the whole list -- the one operation `updateProject` cannot do,
  // because a brand-new project has no existing entry to merge a patch
  // into. This is deliberately the ONLY other write path: a caller that
  // just created a project re-fetches the authoritative list (the create
  // response itself lacks `id`/`retention_months`/`monthly_event_quota`)
  // and hands the result here, so the header switcher and every other
  // consumer of `projects` see it too. A second, component-local copy of
  // the list is exactly the divergence this exists to prevent -- the
  // switcher and a screen's own list disagreeing while both look correct.
  setProjects(projects: Project[]): void
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
  // prop can legitimately change (a re-fetched list after creating a
  // project), and this provider's own local edits from `updateProject`
  // must not survive past that -- the fresh list from the server is
  // always the newer truth.
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

  const value = useMemo(
    () => ({ projects, activeId, setActiveId, updateProject, setProjects }),
    [projects, activeId, updateProject],
  )
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

export function useProject(): ProjectState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useProject outside ProjectProvider')
  return v
}
