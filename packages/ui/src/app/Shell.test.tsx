import { render, screen } from '@testing-library/react'
// Named import, not the brief's default one: without `esModuleInterop` (not
// set anywhere in this repo's tsconfigs, and not worth adding for one test
// file) `tsc -b` types a default import of this package as the whole module
// namespace, which has no `.click` -- `vitest run` doesn't type-check, so it
// passed while `pnpm typecheck` failed. The named export is the same object.
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProjectProvider, useProject } from './ProjectContext.js'
import { Shell } from './Shell.js'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
  },
  {
    id: 2,
    name: 'Beta',
    slug: 'beta',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
  },
]

function renderShell(onLogout = vi.fn()) {
  return render(
    <ProjectProvider projects={PROJECTS} initialId={1}>
      <Shell email="admin@localhost" onLogout={onLogout}>
        <p>content</p>
      </Shell>
    </ProjectProvider>,
  )
}

describe('Shell', () => {
  it('renders navigation and the signed-in email', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /feed/i })).toBeInTheDocument()
    expect(screen.getByText('admin@localhost')).toBeInTheDocument()
  })

  it('shows the active project in the switcher', () => {
    // initialId is deliberately projects[1], not projects[0]: with the
    // fixture's original initialId={1} (== PROJECTS[0].id), a switcher that
    // renders `projects[0].name` instead of the active project is
    // indistinguishable from a correct one -- every assertion in this file
    // still passes. This is the mutation that slipped through.
    render(
      <ProjectProvider projects={PROJECTS} initialId={2}>
        <Shell email="admin@localhost" onLogout={vi.fn()}>
          <p>content</p>
        </Shell>
      </ProjectProvider>,
    )
    expect(screen.getByRole('button', { name: /beta/i })).toBeInTheDocument()
  })

  // The switcher is the only control over which project every subsequent
  // request names. If selecting one does not change the context, every
  // screen quietly keeps reading the old project while the header says
  // otherwise -- the worst available failure, because the numbers look real.
  it('switching project updates the context', async () => {
    const seen: Array<number | null> = []
    function Probe() {
      const { activeId } = useProject()
      seen.push(activeId)
      return null
    }
    render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Shell email="a@b.c" onLogout={vi.fn()}>
          <Probe />
        </Shell>
      </ProjectProvider>,
    )
    await userEvent.click(screen.getByRole('button', { name: /alpha/i }))
    await userEvent.click(screen.getByRole('option', { name: /beta/i }))
    expect(seen.at(-1)).toBe(2)
  })

  it('calls onLogout from the account menu', async () => {
    const onLogout = vi.fn()
    renderShell(onLogout)
    await userEvent.click(screen.getByRole('button', { name: /admin@localhost/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /sign out/i }))
    expect(onLogout).toHaveBeenCalled()
  })
})
