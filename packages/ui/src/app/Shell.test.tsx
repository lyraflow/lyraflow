import { render, screen } from '@testing-library/react'
// Named import, not the brief's default one: without `esModuleInterop` (not
// set anywhere in this repo's tsconfigs, and not worth adding for one test
// file) `tsc -b` types a default import of this package as the whole module
// namespace, which has no `.click` -- `vitest run` doesn't type-check, so it
// passed while `pnpm typecheck` failed. The named export is the same object.
import { userEvent } from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
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
    <MemoryRouter initialEntries={['/feed']}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Shell email="admin@localhost" onLogout={onLogout}>
          <p>content</p>
        </Shell>
      </ProjectProvider>
    </MemoryRouter>,
  )
}

describe('Shell', () => {
  it('renders navigation and the signed-in email', () => {
    renderShell()
    expect(screen.getByText('Feed')).toBeInTheDocument()
    expect(screen.getByText('admin@localhost')).toBeInTheDocument()
  })

  // `Router.tsx` (Task 2) is what gives this app somewhere to route to --
  // Feed and Settings are both real navigation links now, and the current
  // one is marked for assistive technology by `NavLink` itself rather than
  // by anything Shell does by hand. `Router.test.tsx` covers the
  // navigation and aria-current behaviour end-to-end; this only pins that
  // both destinations are advertised.
  it('renders Feed and Settings as navigation links', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /feed/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /feed/i })).toHaveAttribute('aria-current', 'page')
  })

  it('shows the active project in the switcher', () => {
    // initialId is deliberately projects[1], not projects[0]: with the
    // fixture's original initialId={1} (== PROJECTS[0].id), a switcher that
    // renders `projects[0].name` instead of the active project is
    // indistinguishable from a correct one -- every assertion in this file
    // still passes. This is the mutation that slipped through.
    render(
      <MemoryRouter initialEntries={['/feed']}>
        <ProjectProvider projects={PROJECTS} initialId={2}>
          <Shell email="admin@localhost" onLogout={vi.fn()}>
            <p>content</p>
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
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
      <MemoryRouter initialEntries={['/feed']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Shell email="a@b.c" onLogout={vi.fn()}>
            <Probe />
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await userEvent.click(screen.getByRole('button', { name: /alpha/i }))
    await userEvent.click(screen.getByRole('option', { name: /beta/i }))
    expect(seen.at(-1)).toBe(2)
  })

  // MINOR from the whole-branch review: `GET /v1/auth/session` can answer
  // `{ email: null }` when the session cookie is still valid but the admin
  // row it names is gone. `email` was typed `string` unconditionally, and
  // this renders it with no null check, which would otherwise show a blank
  // label (or, before the type fix, hide a real bug at the type level).
  it('renders a fallback, not a blank label, when email is null', () => {
    render(
      <MemoryRouter initialEntries={['/feed']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Shell email={null} onLogout={vi.fn()}>
            <p>content</p>
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole('button', { name: /unknown admin/i })).toBeInTheDocument()
  })

  it('calls onLogout from the account menu', async () => {
    const onLogout = vi.fn()
    renderShell(onLogout)
    await userEvent.click(screen.getByRole('button', { name: /admin@localhost/i }))
    await userEvent.click(screen.getByRole('menuitem', { name: /sign out/i }))
    expect(onLogout).toHaveBeenCalled()
  })
})
