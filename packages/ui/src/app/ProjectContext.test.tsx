import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Project } from '../api/types.js'
import { ProjectProvider, readStoredProjectId, useProject } from './ProjectContext.js'

function project(id: number, name: string): Project {
  return {
    id,
    name,
    slug: name.toLowerCase().replace(/ /g, '-'),
    created_at: '2026-08-01T00:00:00.000Z',
    retention_months: 13,
    monthly_event_quota: null,
  }
}

const PROJECTS = [project(1, 'First'), project(8, 'Demo Data')]

/** Reads what the provider resolved, and offers the switcher's one act. */
function Probe() {
  const { activeId, projects, setActiveId } = useProject()
  return (
    <>
      <span data-testid="active">{String(activeId)}</span>
      {projects.map((p) => (
        <button key={p.id} type="button" onClick={() => setActiveId(p.id)}>
          {p.name}
        </button>
      ))}
    </>
  )
}

const active = () => screen.getByTestId('active').textContent

describe('ProjectProvider remembering the active project', () => {
  beforeEach(() => localStorage.clear())

  it('opens on initialId when this browser has never switched', () => {
    render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Probe />
      </ProjectProvider>,
    )
    expect(active()).toBe('1')
  })

  // The bug: switching to a project and reloading came back to whichever
  // project the server listed first, so a second project was unusable for
  // anything that outlived one page load.
  //
  // Two failure modes, and this pins BOTH. `useState` must resolve to the
  // remembered project -- and the `initialId` sync effect, which runs after
  // the first render like every effect, must not then assign `initialId`
  // over it. React Testing Library flushes effects before this assertion, so
  // a provider that restores and then clobbers fails here rather than
  // looking correct until someone watches the screen flash.
  it('comes back to the project this browser last switched to', async () => {
    const first = render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Probe />
      </ProjectProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Demo Data' }))
    expect(active()).toBe('8')
    first.unmount()

    // A reload is a fresh provider over the same storage.
    render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Probe />
      </ProjectProvider>,
    )
    expect(active()).toBe('8')
  })

  // A stored id outlives the thing it names: a project deleted by hand, a
  // different install on the same origin, a different operator on this
  // browser. Restoring it anyway would scope every request on every screen
  // to a project the session does not carry, with a switcher showing no
  // selection and no way back short of clearing site data.
  it('falls back to initialId when the remembered project is not in the list', () => {
    localStorage.setItem('lf-project', '99')
    render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Probe />
      </ProjectProvider>,
    )
    expect(active()).toBe('1')
  })

  it('ignores a stored value that is not a project id', () => {
    for (const raw of ['', '   ', 'demo-data', '1.5', '-8', 'NaN']) {
      localStorage.setItem('lf-project', raw)
      expect(readStoredProjectId()).toBeNull()
    }
  })

  it('remembers only a deliberate switch, never the fallback it opened on', () => {
    const view = render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Probe />
      </ProjectProvider>,
    )
    // Nothing written by merely rendering: "never chose" must stay
    // distinguishable from "chose the first one", or a later change to what
    // initialId means is invisible to anyone who has loaded this page once.
    expect(readStoredProjectId()).toBeNull()
    view.unmount()
  })

  it('writes the switch as it happens', async () => {
    render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Probe />
      </ProjectProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Demo Data' }))
    expect(readStoredProjectId()).toBe(8)
    await userEvent.click(screen.getByRole('button', { name: 'First' }))
    expect(readStoredProjectId()).toBe(1)
  })

  // What the ref guard in that effect is for. The effect's deps include
  // `projects`, so it re-runs whenever `App` hands down a new array --
  // an ordinary re-render, not a change of anything. Without the guard it
  // would re-resolve on every one of those, which silently makes the
  // in-session selection only as durable as what is in storage: clear the
  // site data in another tab, or in devtools, and the next unrelated
  // re-render throws the operator back to the first project mid-session.
  // The guard makes the effect fire when `initialId` actually CHANGES.
  it('holds the switch for the session even after what was stored goes away', async () => {
    const view = render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Probe />
      </ProjectProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Demo Data' }))
    localStorage.clear()

    // Same contents, new array: exactly what a re-render of `App` produces.
    view.rerender(
      <ProjectProvider projects={[...PROJECTS]} initialId={1}>
        <Probe />
      </ProjectProvider>,
    )
    expect(active()).toBe('8')
  })

  // The sync effect's own job, unchanged: a caller whose initialId changes
  // on a later render must not be left pointing at a project that is not in
  // the new list.
  it('re-resolves when initialId changes, keeping a remembered project that is still listed', async () => {
    const view = render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Probe />
      </ProjectProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Demo Data' }))
    expect(active()).toBe('8')

    view.rerender(
      <ProjectProvider projects={PROJECTS} initialId={99}>
        <Probe />
      </ProjectProvider>,
    )
    expect(active()).toBe('8')
  })

  it('re-resolves when initialId changes, dropping a remembered project the new list lost', async () => {
    const view = render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Probe />
      </ProjectProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Demo Data' }))

    const withoutDemo = [project(1, 'First'), project(2, 'Second')]
    view.rerender(
      <ProjectProvider projects={withoutDemo} initialId={2}>
        <Probe />
      </ProjectProvider>,
    )
    expect(active()).toBe('2')
  })
})
