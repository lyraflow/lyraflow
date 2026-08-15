import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Project } from '../api/types.js'

interface ProjectState {
  projects: Project[]
  activeId: number | null
  setActiveId(id: number): void
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

  const value = useMemo(
    () => ({ projects: props.projects, activeId, setActiveId }),
    [props.projects, activeId],
  )
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>
}

export function useProject(): ProjectState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useProject outside ProjectProvider')
  return v
}
