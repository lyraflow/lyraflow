import { createContext, useContext, useMemo, useState } from 'react'
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
