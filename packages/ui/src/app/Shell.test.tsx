import { act, render, screen } from '@testing-library/react'
// Named import, not the brief's default one: without `esModuleInterop` (not
// set anywhere in this repo's tsconfigs, and not worth adding for one test
// file) `tsc -b` types a default import of this package as the whole module
// namespace, which has no `.click` -- `vitest run` doesn't type-check, so it
// passed while `pnpm typecheck` failed. The named export is the same object.
import { userEvent } from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api/client.js'
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
    deleting_at: null,
  },
  {
    id: 2,
    name: 'Beta',
    slug: 'beta',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
  },
]

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    meta: vi.fn(async () => ({ version: '0.10.0' })),
    ...over,
  } as unknown as ApiClient
}

/** A promise the test settles, so "before the answer arrives" is a real state. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderWithClient(client: ApiClient) {
  return render(
    <MemoryRouter initialEntries={['/feed']}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Shell email="admin@localhost" onLogout={vi.fn()} client={client}>
          <p>content</p>
        </Shell>
      </ProjectProvider>
    </MemoryRouter>,
  )
}

function renderShell(onLogout = vi.fn()) {
  return render(
    <MemoryRouter initialEntries={['/feed']}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Shell email="admin@localhost" onLogout={onLogout} client={fakeClient()}>
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
  //
  // The brand element is now a link to `/` (its own test below covers the
  // destination); this only pins that its accessible name still carries the
  // full "Lyraflow" wordmark, not the shortened "Lyra".
  it('names the brand element "Lyraflow", not "Lyra"', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /^lyraflow/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^lyra$/i })).toBeNull()
  })

  // O2: the mark is the one way back to the home dashboard besides the
  // sidebar's own Dashboards entry -- a real `Link`, not a decorative group,
  // so it is reachable the same way every other destination in this sidebar
  // is.
  it('the brand mark links to /', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /lyraflow home/i })).toHaveAttribute('href', '/')
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

  // Task 6: Dashboards is the first nav entry, above Feed. Same
  // aria-current shape as the other resolution guards in this file --
  // rendered AT /dashboards, its own link carries aria-current and Feed's
  // does not, so this can't pass from the link merely existing.
  it('renders Dashboards as a navigation link, current at /dashboards', () => {
    render(
      <MemoryRouter initialEntries={['/dashboards']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Shell email="a@b.c" onLogout={vi.fn()} client={fakeClient()}>
            {null}
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /dashboards/i })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: /^feed$/i })).not.toHaveAttribute('aria-current')
  })

  // O1: Dashboards now opens the starred dashboard when one exists --
  // `/dashboards/home`, resolved by `Router.tsx`'s `HomeEntry` -- rather
  // than the list directly.
  it('Dashboards links to /dashboards/home', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /^dashboards$/i })).toHaveAttribute(
      'href',
      '/dashboards/home',
    )
  })

  // Dashboards is a plain `Link` now, like Feed, so its `aria-current` is
  // computed by hand rather than by `NavLink`'s own match against `to` --
  // and it has to stay current on every `/dashboards/*` screen, not just at
  // `/dashboards/home` itself, since that is where a click on it actually
  // lands. Rendered at a dashboard's own id, the list route, and a
  // different destination, so this can't pass from `startsWith` alone
  // matching everything.
  it('marks Dashboards current on any /dashboards/* screen', () => {
    render(
      <MemoryRouter initialEntries={['/dashboards/7']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Shell email="a@b.c" onLogout={vi.fn()} client={fakeClient()}>
            {null}
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /^dashboards$/i })).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(screen.getByRole('link', { name: /^feed$/i })).not.toHaveAttribute('aria-current')
  })

  it('marks Dashboards current at /dashboards itself', () => {
    render(
      <MemoryRouter initialEntries={['/dashboards']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Shell email="a@b.c" onLogout={vi.fn()} client={fakeClient()}>
            {null}
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /^dashboards$/i })).toHaveAttribute(
      'aria-current',
      'page',
    )
  })

  it('does not mark Dashboards current at /feed', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /^dashboards$/i })).not.toHaveAttribute('aria-current')
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
          <Shell email="admin@localhost" onLogout={vi.fn()} client={fakeClient()}>
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
          <Shell email="a@b.c" onLogout={vi.fn()} client={fakeClient()}>
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
          <Shell email={null} onLogout={vi.fn()} client={fakeClient()}>
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
          <Shell email="a@b.c" onLogout={vi.fn()} client={fakeClient()}>
            {null}
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /funnels/i })).toHaveAttribute('aria-current', 'page')
  })

  it('fills the active destination, so it is not distinguished by colour alone', () => {
    // `aria-current` above is what a screen reader hears; this is what a
    // sighted operator sees, and until now it was one colour step on one
    // axis -- `text-foreground` against `text-muted-foreground`, every item
    // the same weight. The fill is the same `bg-muted` the hover state
    // uses.
    //
    // Asserted on the ACTIVE and an INACTIVE link together. The active
    // half alone would still pass if every item were filled, which is the
    // one way this could be wrong while looking right.
    render(
      <MemoryRouter initialEntries={['/funnels']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Shell email="a@b.c" onLogout={vi.fn()} client={fakeClient()}>
            {null}
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    // `classList`, not a substring of `className`: the inactive link carries
    // `hover:bg-muted`, which CONTAINS `bg-muted` as text. A substring
    // assertion passes on the active link and fails on the inactive one for
    // a reason that has nothing to do with the fill. `classList` tokenises
    // on whitespace, so `bg-muted` and `hover:bg-muted` are distinct.
    expect(screen.getByRole('link', { name: /funnels/i }).classList.contains('bg-muted')).toBe(true)
    expect(screen.getByRole('link', { name: /settings/i }).classList.contains('bg-muted')).toBe(
      false,
    )
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
          <Shell email="a@b.c" onLogout={vi.fn()} client={fakeClient()}>
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
          <Shell email="admin@localhost" onLogout={vi.fn()} client={fakeClient()}>
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
    deleting_at: null,
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

describe('Shell — deleting projects in the switcher', () => {
  const NOW = '2026-08-21T09:00:00.000Z'
  const acme: Project = {
    id: 1,
    name: 'Acme',
    slug: 'acme',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
  }
  const other: Project = { ...acme, id: 2, name: 'Other', slug: 'other' }

  /** A `render` wrapper, not a self-rendering helper -- this test needs
   * `{ wrapper: withProjects([...]) }`, the shape `render`'s own option
   * expects, rather than a function that renders on its own. */
  function withProjects(projects: Project[]) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <MemoryRouter initialEntries={['/feed']}>
          <ProjectProvider projects={projects} initialId={projects[0]?.id ?? null}>
            {children}
          </ProjectProvider>
        </MemoryRouter>
      )
    }
  }

  it('omits a deleting project from the switcher', async () => {
    render(<Shell email="a@example.com" onLogout={() => {}} client={fakeClient()} />, {
      wrapper: withProjects([acme, { ...other, deleting_at: NOW }]),
    })
    expect(screen.getByRole('button', { name: /Acme/ })).toBeInTheDocument()
    // The trigger alone never names a non-active project either way, so the
    // filter can only be pinned by opening the list: Radix unmounts
    // `SelectContent` entirely while closed, and "Other" is absent from
    // the closed trigger regardless of whether this filter runs at all.
    await userEvent.click(screen.getByRole('button', { name: /Acme/ }))
    expect(screen.getByRole('option', { name: /Acme/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Other/ })).not.toBeInTheDocument()
  })
})

describe('Shell — the GitHub link', () => {
  /** The one URL this control exists to reach. Hard-coded rather than
   * imported from the component so a typo in `Shell.tsx` fails here instead
   * of being asserted against itself. */
  const REPO = 'https://github.com/lyraflow/lyraflow'

  it('links to the public repository', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /star on github/i })).toHaveAttribute('href', REPO)
  })

  // A dashboard is a working surface -- an operator mid-investigation who
  // clicks this must not lose the screen they were on.
  it('opens in a new tab', () => {
    renderShell()
    expect(screen.getByRole('link', { name: /star on github/i })).toHaveAttribute(
      'target',
      '_blank',
    )
  })

  // `noreferrer` is the privacy guard, and it is separate from `noopener`:
  // without it the outbound request carries this page's URL, which on a
  // self-hosted install is the operator's own hostname. Pinned on its own so
  // dropping just this token fails just this test.
  it('sends no referrer, so a self-hosted hostname does not reach GitHub', () => {
    renderShell()
    const rel = screen.getByRole('link', { name: /star on github/i }).getAttribute('rel') ?? ''
    expect(rel.split(/\s+/)).toContain('noreferrer')
    expect(rel.split(/\s+/)).toContain('noopener')
  })

  // The count was the deliberate omission (O1), not an unfinished piece: it
  // cannot be fetched in the browser without sending every operator's IP to
  // GitHub, and it cannot be fetched at all in an install with no egress.
  // An exact-name match is what pins it -- any count rendered beside the
  // label lands in the accessible name and breaks this.
  it('shows no star count', () => {
    renderShell()
    const link = screen.getByRole('link', { name: 'Star on GitHub' })
    expect(link.textContent).toBe('Star on GitHub')
    expect(link.textContent).not.toMatch(/\d/)
  })

  // The other half of the same decision: no buttons.github.io widget, no
  // embedded frame. Either would reintroduce the third-party request that
  // dropping the count exists to avoid.
  it('embeds no third-party widget', () => {
    const { container } = renderShell()
    // Asserted first on purpose: without it this test is a pure negative
    // and passes when the control is absent entirely -- it would then be
    // testing nothing, which is precisely the state the two assertions
    // below exist to rule out.
    expect(screen.getByRole('link', { name: /star on github/i })).toBeInTheDocument()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
  })
})

describe('Shell — version', () => {
  it('shows the running version in the sidebar', async () => {
    renderWithClient(fakeClient())
    expect(await screen.findByText('v0.10.0')).toBeInTheDocument()
  })

  // Deliberately NOT a skeleton, unlike the Settings card. There the value
  // sits beside the label "Version", where a blank reads as "this install
  // has none"; here it is standalone chrome, and absent-until-loaded is
  // both honest and invisible.
  it('shows nothing at all before the answer arrives', async () => {
    const d = deferred<{ version: string }>()
    renderWithClient(fakeClient({ meta: vi.fn(() => d.promise) }))
    expect(screen.queryByTestId('sidebar-version')).not.toBeInTheDocument()
    d.resolve({ version: '0.10.0' })
    expect(await screen.findByText('v0.10.0')).toBeInTheDocument()
  })

  // The chrome is on every screen, so a failure here would follow an
  // operator everywhere. The Settings card is the place that reports one,
  // because it is the place that can explain it.
  it('stays silent when the version cannot be read, rather than showing an error in the chrome', async () => {
    // The rejection is DEFERRED and settled inside `act` rather than awaited
    // with a bare `await Promise.resolve()`, which was the first shape of
    // this test and was vacuous: it asserted the absence before the
    // rejection had propagated into state, so it passed against a component
    // that renders an error on failure. Caught by mutating exactly that.
    // Settling inside `act` flushes the hook's catch and the re-render it
    // schedules, so the assertions below run against the settled state.
    const d = deferred<{ version: string }>()
    renderWithClient(fakeClient({ meta: vi.fn(() => d.promise) }))
    await act(async () => {
      d.reject(new Error('offline'))
      await d.promise.catch(() => {})
    })
    expect(screen.queryByTestId('sidebar-version')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('offers a changelog link beside the version', async () => {
    renderWithClient(fakeClient())
    await screen.findByText('v0.10.0')
    const link = screen.getByRole('link', { name: /changelog/i })
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/lyraflow/lyraflow/blob/main/CHANGELOG.md',
    )
  })

  // Absent until the version is, since it reads as a footnote to it -- a
  // lone `[changelog]` under the nav with no version above it is chrome
  // pointing at nothing.
  it('does not offer the changelog link before the version arrives', () => {
    const d = deferred<{ version: string }>()
    renderWithClient(fakeClient({ meta: vi.fn(() => d.promise) }))
    expect(screen.queryByRole('link', { name: /changelog/i })).not.toBeInTheDocument()
  })

  /**
   * The third outbound GitHub link in this shell, and it needs the same
   * guard as the other two for the same reason: without `noreferrer` the
   * request carries this page's URL, which on a self-hosted install is the
   * operator's own hostname. Pinned separately because nothing structural
   * ties the three together -- each is a plain anchor someone can add
   * without it.
   */
  it('does not leak the install hostname to GitHub through the changelog link', async () => {
    renderWithClient(fakeClient())
    await screen.findByText('v0.10.0')
    const rel = screen.getByRole('link', { name: /changelog/i }).getAttribute('rel')
    expect(rel).toContain('noreferrer')
    expect(rel).toContain('noopener')
  })

  /**
   * Pins the DECISION, not the rendering. Below `sm` this aside reflows from
   * a vertical sidebar into a compact top bar -- the row that already scrolls
   * horizontally at 390px, which is why the nav labels are `sr-only` there.
   * The version is the least important thing in that row, so it is hidden
   * rather than allowed to compete; the Settings Install card still carries
   * it at every width.
   *
   * jsdom loads no Tailwind stylesheet (see this file's own note on `hidden`
   * never actually hiding anything here), so visibility cannot be asserted.
   * The class is the only available pin.
   */
  it('is hidden below sm, where the sidebar is a compact top bar', async () => {
    renderWithClient(fakeClient())
    await screen.findByText('v0.10.0')
    const el = screen.getByTestId('sidebar-version')
    // The decision is "not displayed below `sm`, displayed at `sm` and up".
    // Which display value restores it (`block` when it was the version
    // alone, `flex` now that it is a row) is not the decision, so the
    // assertion does not pin one -- it pins that `hidden` is there and that
    // some `sm:` display utility undoes it.
    expect(el.className).toContain('hidden')
    expect(el.className).toMatch(/\bsm:(block|flex|inline-flex)\b/)
  })
})
