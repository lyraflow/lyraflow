import { render, screen } from '@testing-library/react'
// Named import, not the brief's default one: without `esModuleInterop` (not
// set anywhere in this repo's tsconfigs, and not worth adding for one test
// file) `tsc -b` types a default import of this package as the whole module
// namespace, which has no `.click` -- `vitest run` doesn't type-check, so it
// passed while `pnpm typecheck` failed. The named export is the same object.
import { userEvent } from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Project } from '../api/types.js'
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
    disabled_at: null,
  },
  {
    id: 2,
    name: 'Beta',
    slug: 'beta',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
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

  // Defect 3 from the Task 8 visual pass: the wordmark rendered "Lyra" on
  // every screen this Shell wraps -- the product is Lyraflow, and the
  // brand's wordmark spec hand-sets a kern pair (`fl`) that exists only in
  // the full name. Pinned via accessible name, not `getByText`, so a
  // regression (or a markup change that hides the string from assistive
  // tech while still painting the old text) fails this the same way.
  it('names the brand element "Lyraflow", not "Lyra"', () => {
    renderShell()
    expect(screen.getByRole('group', { name: 'Lyraflow' })).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Lyra' })).toBeNull()
  })

  // `Router.tsx` (Task 2) is what gives this app somewhere to route to --
  // Feed and Settings are both real navigation links now, and the current
  // one is marked for assistive technology by `NavLink` itself rather than
  // by anything Shell does by hand. `Router.test.tsx` covers the
  // navigation and aria-current behaviour end-to-end; this only pins that
  // both destinations are advertised.
  it('renders Feed, Funnels and Settings as navigation links', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /feed/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /funnels/i })).toBeInTheDocument()
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

  // Task 7 (#85): three destinations made the deferred narrow-width problem
  // a defect -- at 390px the sidebar took 57% of the viewport, the switcher
  // truncated to "Ce" and a tab label to "ed 1". jsdom has no Tailwind
  // stylesheet loaded (see Shell.tsx's own comment on this), so `sr-only`
  // never actually applies here -- this only pins that every destination
  // keeps an accessible name and stays queryable regardless of width; the
  // visual collapse itself was checked by rendering the page, not by this
  // suite.
  it('exposes every destination at a narrow width', () => {
    renderShell()
    for (const name of [/feed/i, /funnels/i, /settings/i]) {
      expect(screen.getByRole('link', { name })).toBeVisible()
    }
  })

  it('marks the active destination with aria-current', () => {
    render(
      <MemoryRouter initialEntries={['/funnels']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Shell email="a@b.c" onLogout={vi.fn()}>
            {null}
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /funnels/i })).toHaveAttribute('aria-current', 'page')
  })

  // `Shell.tsx`'s own comment explains why Feed is a plain `Link` with
  // `aria-current` computed by hand: `Router.tsx` answers `/` with the same
  // element as `/feed`, and `NavLink`'s own `isActive` match (computed from
  // `to` against the current location) never fires for a `to="/feed"` link
  // when the location is `/` -- the exact state every operator lands on
  // right after login. This is the case a refactor of this file is most
  // likely to break, and nothing above covered it.
  it('marks Feed active at the bare root, not just /feed', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Shell email="a@b.c" onLogout={vi.fn()}>
            {null}
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /feed/i })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('link', { name: /funnels/i })).not.toHaveAttribute('aria-current')
    expect(screen.getByRole('link', { name: /settings/i })).not.toHaveAttribute('aria-current')
  })
})

describe('Shell — archived projects in the switcher', () => {
  /** Its own render: `renderShell` pins one fixture list, and these two need
   * their own. */
  const withProjects = (projects: Project[], initialId: number) =>
    render(
      <MemoryRouter initialEntries={['/feed']}>
        <ProjectProvider projects={projects} initialId={initialId}>
          <Shell email="admin@localhost" onLogout={vi.fn()}>
            <p>content</p>
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )

  const project = (over: Partial<Project> = {}): Project => ({
    id: 1,
    name: 'Demo Data',
    slug: 'demo-data',
    created_at: '2026-08-01T00:00:00.000Z',
    retention_months: 13,
    monthly_event_quota: null,
    disabled_at: null,
    ...over,
  })

  // Listed and labelled rather than filtered out. Hiding them breaks the
  // case that actually happens -- archiving the project you are looking at
  // -- because the switcher would then have no entry for `activeId`, the
  // trigger would read "Select project" while every screen below kept
  // answering for it, and there would be no way back except Settings.
  it('says which projects are archived instead of hiding them', () => {
    withProjects(
      [project(), project({ id: 2, name: 'Old Site', disabled_at: '2026-08-19T00:00:00.000Z' })],
      2,
    )
    expect(screen.getByRole('button', { name: /Old Site \(archived\)/ })).toBeInTheDocument()
  })

  it('leaves an active project unlabelled', () => {
    withProjects([project()], 1)
    expect(screen.getByRole('button', { name: /Demo Data/ })).toBeInTheDocument()
    expect(screen.queryByText(/Demo Data \(archived\)/)).not.toBeInTheDocument()
  })
})

describe('Shell — the account menu', () => {
  // A real anchor, not a button that navigates: an account-menu entry that
  // cannot be middle-clicked or opened in a new tab is a link pretending to
  // be something else, and every other destination in this shell is one.
  it('offers Profile as a link to /profile', async () => {
    renderShell()
    await userEvent.click(screen.getByRole('button', { name: /admin@localhost/ }))
    const profile = await screen.findByRole('menuitem', { name: 'Profile' })
    expect(profile).toHaveAttribute('href', '/profile')
  })

  it('still offers sign out beside it', async () => {
    renderShell()
    await userEvent.click(screen.getByRole('button', { name: /admin@localhost/ }))
    expect(await screen.findByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument()
  })
})
