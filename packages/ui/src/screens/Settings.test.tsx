import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { ProjectProvider, useProject } from '../app/ProjectContext.js'
import { Shell } from '../app/Shell.js'
import { Settings } from './Settings.js'

// Same idiom as SegmentPicker.test.tsx's own `deferred`: a promise the test
// controls, so an ordering that would otherwise depend on real timing (the
// race in #89) can be driven deterministically instead.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// Reads project context directly rather than through any one screen's own
// rendering of a field -- `LimitsSection`'s retention input only reflects
// what was TYPED, not what context ends up holding after `updateProject`'s
// merge, so it can't be used to prove a race outcome on its own. This is
// the one place the race test below can observe whether a whole-list
// replace clobbered `updateProject`'s already-applied edit.
function RetentionProbe(props: { id: number }) {
  const { projects } = useProject()
  const value = projects.find((p) => p.id === props.id)?.retention_months
  return <div data-testid="retention-probe">{value ?? 'missing'}</div>
}

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
]

// The full `CreatedProject` shape (#89): every `Project` field plus the two
// one-time keys. Tests below use this instead of the pre-fix
// name/slug/write_key/server_key-only shape so a fixture that omits a field
// `addProject` needs (id in particular) doesn't silently push an incomplete
// row into context.
function createdProject(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 2,
    name: 'Beta',
    slug: 'beta',
    created_at: '2026-08-14T00:00:00.000Z',
    retention_months: 13,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
    write_key: 'wk_new',
    server_key: 'sk_new',
    ...over,
  }
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    project: vi.fn(async () => ({ name: 'Alpha', slug: 'alpha', write_key: 'wk_abc123' })),
    usage: vi.fn(async () => ({
      month: '2026-08',
      events_accepted: 42180,
      events_rejected: 17,
      events_throttled: 0,
      events_bot: 3906,
      monthly_event_quota: 50000000,
      disabled_at: null,
    })),
    projects: vi.fn(async () => PROJECTS),
    meta: vi.fn(async () => ({ version: '0.10.0' })),
    ...over,
  } as unknown as ApiClient & { project: Mock; usage: Mock }
}

function renderSettings(client = fakeClient()) {
  render(
    <ProjectProvider projects={PROJECTS} initialId={1}>
      <Settings client={client} />
    </ProjectProvider>,
  )
  return client
}

describe('Settings — snippet', () => {
  it('shows a snippet carrying this project write key', async () => {
    renderSettings()
    const block = await screen.findByTestId('install-snippet')
    expect(block.textContent).toContain('wk_abc123')
    expect(block.textContent).toContain('/lyraflow.js')
  })

  // The snippet is the one thing on this page a person must copy exactly.
  it('copies the snippet to the clipboard', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    renderSettings()
    await userEvent.click(await screen.findByRole('button', { name: /copy/i }))
    await waitFor(() => expect(writeText).toHaveBeenCalled())
    expect(String(writeText.mock.calls[0]?.[0])).toContain('wk_abc123')
  })

  // The server key is unrecoverable by construction -- only its hash is
  // stored. Implying it can be shown again would send someone hunting.
  it('says plainly that the server key cannot be shown again', async () => {
    renderSettings()
    expect(await screen.findByText(/shown once/i)).toBeInTheDocument()
  })

  // The async clipboard API REJECTS -- it doesn't just no-op -- when the
  // document isn't focused, and is unavailable entirely on a non-secure
  // origin that isn't localhost: exactly a self-hoster on plain HTTP over
  // a private network. Nothing above drives a rejecting `writeText`, so a
  // regression in the `catch` branch would be invisible.
  it('tells the person to copy by hand when the clipboard write is rejected', async () => {
    const writeText = vi.fn(async (_text: string) => {
      throw new DOMException('Document is not focused', 'NotAllowedError')
    })
    Object.assign(navigator, { clipboard: { writeText } })
    renderSettings()
    await userEvent.click(await screen.findByRole('button', { name: /copy/i }))
    expect(await screen.findByText(/copy it by hand/i)).toBeInTheDocument()
  })
})

describe('Settings — usage', () => {
  // The quota rendered here comes from PROJECT CONTEXT, not from `usage()`
  // (IMPORTANT 1 from the whole-branch review -- see `UsageSection`'s own
  // doc comment) -- so this needs a project whose OWN `monthly_event_quota`
  // agrees with the fixture's `usage()` response, unlike the shared
  // `PROJECTS` fixture (`monthly_event_quota: null`) most other tests in
  // this file use.
  it('shows this month against the quota', async () => {
    const projects = [
      {
        id: 1,
        name: 'Alpha',
        slug: 'alpha',
        created_at: '',
        retention_months: 24,
        monthly_event_quota: 50_000_000,
        disabled_at: null,
        deleting_at: null,
      },
    ]
    render(
      <ProjectProvider projects={projects} initialId={1}>
        <Settings client={fakeClient()} />
      </ProjectProvider>,
    )
    expect(await screen.findByText(/42,180/)).toBeInTheDocument()
    expect(screen.getByText(/50,000,000/)).toBeInTheDocument()
  })

  // null means unlimited and is what every project carries by default.
  // Rendering it as "0" or "NaN" would read as a project that can accept
  // nothing -- the opposite of the truth.
  it('renders an unlimited quota as unlimited, not as a number', async () => {
    renderSettings(
      fakeClient({
        usage: vi.fn(async () => ({
          month: '2026-08',
          events_accepted: 10,
          events_rejected: 0,
          events_throttled: 0,
          events_bot: 0,
          monthly_event_quota: null,
          disabled_at: null,
        })),
      }),
    )
    expect(await screen.findByText(/unlimited/i)).toBeInTheDocument()
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
  })

  // The bot counter is a SEPARATE tile, not folded into "Rejected". Before
  // bot drops had their own column they were counted as rejections -- a
  // wrong label, but a visible number. Splitting the column without adding
  // this tile made the same crawler traffic vanish from the screen
  // altogether, which is strictly worse than the wrong label was.
  it('shows bot drops as their own figure, not folded into rejections', async () => {
    renderSettings()
    const bot = await screen.findByText('Bot')
    // Read through the <dt>'s own <div>, so this cannot pass by matching
    // some other 3,906 elsewhere on the page.
    expect(bot.parentElement).toHaveTextContent('3,906')
    // And the rejections tile still reports only rejections.
    expect(screen.getByText('Rejected').parentElement).toHaveTextContent('17')
  })

  it('requests the active project', async () => {
    const client = renderSettings()
    await waitFor(() => expect(client.project).toHaveBeenCalledWith(1))
    expect(client.usage).toHaveBeenCalledWith(1)
  })
})

// Invented beyond the brief's table. The fixture above always carries
// `initialId: 1`, so "requests the active project" alone cannot tell a
// genuine `activeId` read apart from a hardcoded literal `1` -- both
// satisfy `toHaveBeenCalledWith(1)`. Confirmed directly: hardcoding
// `client.project(1)` in Settings.tsx left the whole suite green. This is
// the pin that actually distinguishes the two, by switching the active
// project to an id the hardcoded mutation cannot produce.
describe('Settings — invented mutations', () => {
  it('re-requests for the newly active project, not a fixed id', async () => {
    const client = fakeClient()
    const projects = [
      ...PROJECTS,
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
    const view = render(
      <ProjectProvider projects={projects} initialId={1}>
        <Settings client={client} />
      </ProjectProvider>,
    )
    await waitFor(() => expect(client.project).toHaveBeenCalledWith(1))

    view.rerender(
      <ProjectProvider projects={projects} initialId={2}>
        <Settings client={client} />
      </ProjectProvider>,
    )
    await waitFor(() => expect(client.project).toHaveBeenCalledWith(2))
    expect(client.usage).toHaveBeenCalledWith(2)
  })

  // Every fake client in the suite above resolves promptly. A real
  // `GET /v1/project` can 401, 500 or hit a flaky proxy -- this must not
  // leave the screen showing an empty skeleton forever with an unhandled
  // rejection loose in the console.
  it('shows an error instead of hanging forever when the project fetch fails', async () => {
    const client = fakeClient({
      project: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    renderSettings(client)
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})

describe('Settings — limits', () => {
  it('saves a changed retention', async () => {
    const patchProject = vi.fn(async () => ({ retention_months: 6, monthly_event_quota: null }))
    renderSettings(fakeClient({ patchProject }))
    const input = await screen.findByLabelText(/retention/i)
    await userEvent.clear(input)
    await userEvent.type(input, '6')
    await userEvent.click(screen.getByRole('button', { name: /save retention/i }))
    await waitFor(() => expect(patchProject).toHaveBeenCalledWith(1, { retention_months: 6 }))
  })

  // Clearing the quota field means "unlimited", and unlimited is null.
  // Sending 0 makes the API refuse it, and if it ever got through it would
  // 503 every event of the project.
  it('sends null, not 0, when the quota is cleared', async () => {
    const patchProject = vi.fn(async () => ({ retention_months: 24, monthly_event_quota: null }))
    renderSettings(fakeClient({ patchProject }))
    const input = await screen.findByLabelText(/quota/i)
    await userEvent.clear(input)
    await userEvent.click(screen.getByRole('button', { name: /save quota/i }))
    await waitFor(() => expect(patchProject).toHaveBeenCalledWith(1, { monthly_event_quota: null }))
  })

  it('sends a typed quota as a number', async () => {
    const patchProject = vi.fn(async () => ({ retention_months: 24, monthly_event_quota: 1000 }))
    renderSettings(fakeClient({ patchProject }))
    const input = await screen.findByLabelText(/quota/i)
    await userEvent.clear(input)
    await userEvent.type(input, '1000')
    await userEvent.click(screen.getByRole('button', { name: /save quota/i }))
    await waitFor(() => expect(patchProject).toHaveBeenCalledWith(1, { monthly_event_quota: 1000 }))
  })

  // The column's CHECK is BETWEEN 1 AND 120. Catching it here means the
  // person is told what is wrong; letting it reach Postgres means a 503
  // that reads as an outage.
  it.each([
    ['zero', '0'],
    ['too large', '121'],
  ])('refuses retention out of range without calling the API: %s', async (_name, value) => {
    const patchProject = vi.fn()
    renderSettings(fakeClient({ patchProject }))
    const input = await screen.findByLabelText(/retention/i)
    await userEvent.clear(input)
    await userEvent.type(input, value)
    await userEvent.click(screen.getByRole('button', { name: /save retention/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(patchProject).not.toHaveBeenCalled()
  })

  // IMPORTANT 2 from the whole-branch review: `Number.isInteger(1e20)` is
  // `true`, so a naive integer check lets this through -- proved end to end
  // to reach Postgres as an out-of-range `bigint` write, a deterministic
  // client error that rendered as a `503 unavailable`. `parseQuota` must
  // refuse it client-side, before `patchProject` is ever called.
  it.each([
    ['far outside bigint range but still an integer', '99999999999999999999'],
    ['serialises as exponential notation', '1e21'],
  ])('refuses an unrepresentable quota without calling the API: %s', async (_name, value) => {
    const patchProject = vi.fn()
    renderSettings(fakeClient({ patchProject }))
    const input = await screen.findByLabelText(/quota/i)
    await userEvent.clear(input)
    await userEvent.type(input, value)
    await userEvent.click(screen.getByRole('button', { name: /save quota/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(patchProject).not.toHaveBeenCalled()
  })

  it('surfaces an API rejection without losing what was typed', async () => {
    const patchProject = vi.fn(async () => {
      throw new ApiError(400, 'invalid_body')
    })
    renderSettings(fakeClient({ patchProject }))
    const input = await screen.findByLabelText(/quota/i)
    await userEvent.clear(input)
    await userEvent.type(input, '5')
    await userEvent.click(screen.getByRole('button', { name: /save quota/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByLabelText(/quota/i)).toHaveValue(5)
  })
})

// Invented beyond the brief's table.
describe('Settings — limits invented mutations', () => {
  // Every fixture's quota is either a round number or null, and the seeded
  // retention (24) is comfortably inside 1-120. This drives the quota
  // input from a project that already carries a non-null, non-round
  // quota, and edits retention to a boundary value (1) -- an off-by-one
  // in either the range check (`< 1` vs `<= 1`) or a naive `parseInt`
  // truncation of a value like retention_months would slip past a test
  // suite built only from round numbers and 0/121.
  it('accepts the retention boundary value 1 and seeds from a non-round existing quota', async () => {
    const patchProject = vi.fn(async () => ({ retention_months: 1, monthly_event_quota: 12345 }))
    const projects = [
      {
        id: 1,
        name: 'Alpha',
        slug: 'alpha',
        created_at: '',
        retention_months: 24,
        monthly_event_quota: 12345,
        disabled_at: null,
        deleting_at: null,
      },
    ]
    render(
      <ProjectProvider projects={projects} initialId={1}>
        <Settings client={fakeClient({ patchProject })} />
      </ProjectProvider>,
    )
    const quotaInput = await screen.findByLabelText(/quota/i)
    expect(quotaInput).toHaveValue(12345)

    const retentionInput = screen.getByLabelText(/retention/i)
    await userEvent.clear(retentionInput)
    await userEvent.type(retentionInput, '1')
    await userEvent.click(screen.getByRole('button', { name: /save retention/i }))
    await waitFor(() => expect(patchProject).toHaveBeenCalledWith(1, { retention_months: 1 }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  // Every save in the brief's suite succeeds on its first try. This
  // retries after a rejection with a DIFFERENT valid value than the one
  // that failed, to catch a save handler that got latched into a
  // permanent error/disabled state, or that replays the first (now
  // stale) input instead of what is currently in the box.
  it('allows a second, different save attempt to succeed after the first is rejected', async () => {
    const patchProject = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(400, 'invalid_body'))
      .mockResolvedValueOnce({ retention_months: 24, monthly_event_quota: 42 })
    renderSettings(fakeClient({ patchProject }))
    const input = await screen.findByLabelText(/quota/i)

    await userEvent.clear(input)
    await userEvent.type(input, '5')
    await userEvent.click(screen.getByRole('button', { name: /save quota/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await userEvent.clear(input)
    await userEvent.type(input, '42')
    await userEvent.click(screen.getByRole('button', { name: /save quota/i }))
    await waitFor(() => expect(patchProject).toHaveBeenCalledWith(1, { monthly_event_quota: 42 }))
    expect(patchProject).toHaveBeenCalledTimes(2)
  })
})

// IMPORTANT 1 from the whole-branch review: `UsageSection` used to read
// `usage.monthly_event_quota`, which only ever changes on the
// `[client, activeId]` fetch effect -- a quota saved through
// `LimitsSection` never re-triggers that, so this card went stale the
// instant a save succeeded.
describe('Settings — usage stays in sync with a saved limit', () => {
  it('reflects a newly-set quota immediately, without a second usage fetch', async () => {
    const patchProject = vi.fn(async () => ({ retention_months: 24, monthly_event_quota: 1000 }))
    const client = fakeClient({
      patchProject,
      usage: vi.fn(async () => ({
        month: '2026-08',
        events_accepted: 5000,
        events_rejected: 0,
        events_throttled: 0,
        events_bot: 0,
        monthly_event_quota: null,
        disabled_at: null,
      })),
    })
    renderSettings(client)
    // Scoped to the Usage card's own "Quota" value (its `<dd>`), not a bare
    // `screen` query: `LimitsSection`'s own static hint text ("Leave empty
    // for unlimited.") also matches `/unlimited/i` and is present the whole
    // time, so an unscoped query would keep "passing" even if this card's
    // own quota value were wrong.
    const quotaValue = () => screen.getByText('Quota').nextElementSibling
    await waitFor(() => expect(quotaValue()?.textContent).toMatch(/unlimited/i))

    const input = await screen.findByLabelText(/quota/i)
    await userEvent.clear(input)
    await userEvent.type(input, '1000')
    await userEvent.click(screen.getByRole('button', { name: /save quota/i }))

    await waitFor(() => expect(quotaValue()?.textContent).toBe('1,000'))
    // The fix reads the quota from project context (kept correct by
    // `updateProject`), not from a re-fetch -- `usage()` is called exactly
    // once, at mount, never again from a limits save.
    expect(client.usage).toHaveBeenCalledTimes(1)
  })

  // The sharper direction: LOWERING a quota below what a project has
  // already accepted this month must not leave the progress bar drawn
  // against the old, larger denominator -- that renders a now-over-quota
  // project as if it were barely used at all.
  it('reflects a lowered quota immediately, not the stale larger one', async () => {
    const patchProject = vi.fn(async () => ({ retention_months: 24, monthly_event_quota: 1000 }))
    const projects = [
      {
        id: 1,
        name: 'Alpha',
        slug: 'alpha',
        created_at: '',
        retention_months: 24,
        monthly_event_quota: 50_000_000,
        disabled_at: null,
        deleting_at: null,
      },
    ]
    const client = fakeClient({
      patchProject,
      usage: vi.fn(async () => ({
        month: '2026-08',
        events_accepted: 5000,
        events_rejected: 0,
        events_throttled: 0,
        events_bot: 0,
        monthly_event_quota: 50_000_000,
        disabled_at: null,
      })),
    })
    render(
      <ProjectProvider projects={projects} initialId={1}>
        <Settings client={client} />
      </ProjectProvider>,
    )
    expect(await screen.findByText('50,000,000')).toBeInTheDocument()

    const input = await screen.findByLabelText(/quota/i)
    await userEvent.clear(input)
    await userEvent.type(input, '1000')
    await userEvent.click(screen.getByRole('button', { name: /save quota/i }))

    await waitFor(() => expect(screen.getByText('1,000')).toBeInTheDocument())
    expect(screen.queryByText('50,000,000')).not.toBeInTheDocument()
    // 5000 accepted against a quota of 1000 caps at 100%, not the ~0.01%
    // the stale 50,000,000 denominator would have shown.
    expect((screen.getByRole('progressbar') as HTMLProgressElement).value).toBe(100)
  })
})

describe('Settings — projects', () => {
  it('lists the projects', async () => {
    renderSettings()
    expect(await screen.findByText('Alpha')).toBeInTheDocument()
  })

  it('creates a project and shows both keys', async () => {
    const createProject = vi.fn(async () => createdProject())
    renderSettings(fakeClient({ createProject }))
    await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'Beta')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(await screen.findByText('sk_new')).toBeInTheDocument()
    expect(screen.getByText('wk_new')).toBeInTheDocument()
  })

  // The one moment this value is visible. A dialog that can be dismissed
  // by clicking away, or by Escape, will lose it for someone.
  //
  // Scoped to the keys panel itself (`within`), not a bare `screen`
  // query: the snippet section's own static disclaimer ("cannot be shown
  // again") already contains the substring "not be shown again", so an
  // unscoped `screen.findByText(/not be shown again/i)` is satisfied by
  // that unrelated, always-present text and would keep passing even if
  // this panel's own warning were deleted -- a guard that doesn't guard
  // anything. Scoping it to the panel is what makes "drop the
  // not-shown-again warning" actually fail this test.
  it('warns that the server key will not be shown again', async () => {
    const createProject = vi.fn(async () => createdProject())
    renderSettings(fakeClient({ createProject }))
    await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'Beta')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))
    const panel = await screen.findByTestId('created-project-keys')
    expect(within(panel).getByText(/not be shown again/i)).toBeInTheDocument()
  })

  it('reports a duplicate name without losing what was typed', async () => {
    const createProject = vi.fn(async () => {
      throw new ApiError(409, 'project_exists')
    })
    renderSettings(fakeClient({ createProject }))
    await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'Alpha')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toHaveValue('Alpha')
  })

  // Renders the REAL Shell/ProjectSwitcher alongside Settings, sharing one
  // ProjectProvider, the way the running app does -- not a call count on a
  // fake client. A previous version of this test asserted only
  // `client.projects` was called twice, which is satisfiable by a
  // component-local fetch that never reaches the switcher at all: the
  // header would go on naming the old project after a reload-free create,
  // and this test would still pass. That divergence -- the header saying
  // one thing while the data underneath says another, both looking
  // correct -- is the worst available failure on this screen, so this
  // asserts the new project is actually selectable in the switcher.
  //
  // #89: this now proves the switcher updates WITHOUT any `GET /v1/projects`
  // at all -- `projects` below is a fake that would hand back the stale
  // pre-create list forever, and the test still has to pass. Before the fix
  // this test relied on a mocked refetch actually returning Beta; that
  // refetch (and the race it enabled against a concurrent limits save) is
  // gone, and `createProject`'s own response is now the only source for the
  // new row.
  it('adds the new project to the switcher without a reload', async () => {
    const createProject = vi.fn(async () => createdProject())
    const projects = vi.fn(async () => PROJECTS)
    const client = fakeClient({ createProject, projects })
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Shell email="admin@localhost" onLogout={vi.fn()} client={client}>
            <Settings client={client} />
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'Beta')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))
    await screen.findByTestId('created-project-keys')

    await userEvent.click(screen.getByRole('button', { name: /^alpha$/i }))
    expect(await screen.findByRole('option', { name: /beta/i })).toBeInTheDocument()
    // The stale-refetch path this test used to exercise is gone entirely --
    // creating a project must never issue a `GET /v1/projects` at all.
    expect(projects).not.toHaveBeenCalled()
  })

  // The race #89 describes: a limits save (PATCH, merged in via
  // `updateProject`) commits WHILE a project creation is in flight, and the
  // creation's response resolves after. Driven with deferred promises so the
  // ordering is exact rather than timing-dependent: the PATCH's `updateProject`
  // merge happens first, then the create resolves and is added -- and the
  // saved retention value must survive the add.
  //
  // Mutation-tested: reverting `ProjectsSection`'s additive `addProject` call
  // back to a `client.projects()` refetch + whole-list replace makes this
  // fail, because the refetch mock below deliberately answers with the
  // PRE-save retention value (12), representing a `GET` issued before the
  // `PATCH` committed. The fix removed that refetch entirely, so this
  // fake's `projects` is never even consulted.
  it('a concurrent limits save survives a project creation whose list fetch was issued first', async () => {
    const patch = deferred<{ retention_months: number; monthly_event_quota: number | null }>()
    const patchProject = vi.fn(() => patch.promise)
    const create = deferred<ReturnType<typeof createdProject>>()
    const createProject = vi.fn(() => create.promise)
    // Stands in for "the GET issued before the PATCH committed": if
    // anything in the create flow still calls this, it answers with the
    // OLD retention value (12), never the saved one (7).
    const projects = vi.fn(async () => [{ ...PROJECTS[0], retention_months: 12 }])
    const client = fakeClient({ createProject, patchProject, projects })
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Shell email="admin@localhost" onLogout={vi.fn()} client={client}>
            <RetentionProbe id={1} />
            <Settings client={client} />
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('retention-probe')).toHaveTextContent('24')

    // Start the creation first (its "list fetch", if the buggy path issued
    // one, would be dispatched at this point -- before the save below ever
    // commits).
    await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'Beta')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(createProject).toHaveBeenCalledTimes(1)

    // Now the concurrent limits save: change retention and save it while
    // the creation above is still unresolved.
    const retentionInput = await screen.findByLabelText(/retention/i)
    await userEvent.clear(retentionInput)
    await userEvent.type(retentionInput, '7')
    await userEvent.click(screen.getByRole('button', { name: /save retention/i }))
    expect(patchProject).toHaveBeenCalledTimes(1)

    // The PATCH commits first, applying `updateProject`'s merge...
    patch.resolve({ retention_months: 7, monthly_event_quota: null })
    await waitFor(() => expect(screen.getByTestId('retention-probe')).toHaveTextContent('7'))

    // ...then the creation resolves and is added afterward.
    create.resolve(createdProject())
    await screen.findByTestId('created-project-keys')
    await userEvent.click(screen.getByRole('button', { name: /^alpha$/i }))
    expect(await screen.findByRole('option', { name: /beta/i })).toBeInTheDocument()

    // The saved value must have survived the creation settling afterward --
    // the whole point of this test. A whole-list-replace fed by a `GET`
    // issued before the PATCH committed would show '12' (the stale fixture
    // above) here instead.
    expect(screen.getByTestId('retention-probe')).toHaveTextContent('7')
    expect(projects).not.toHaveBeenCalled()
  })
})

describe('Settings — install', () => {
  it('shows the version the server reports', async () => {
    renderSettings()
    expect(await screen.findByText('0.10.0')).toBeInTheDocument()
  })
})

describe('Settings — unauthorized', () => {
  // IMPORTANT 3 from the whole-branch review: neither of Settings' own
  // fetches had any unauthorized detector before this fix -- a 401 fell
  // into the generic `error` state and rendered "Could not load...", the
  // same as any other failure, with `onUnauthorized` never called at all.
  it('calls onUnauthorized on a 401 from the project fetch, not the generic error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      project: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    })
    render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Settings client={client} onUnauthorized={onUnauthorized} />
      </ProjectProvider>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('calls onUnauthorized on a 401 from the usage fetch too', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      usage: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    })
    render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Settings client={client} onUnauthorized={onUnauthorized} />
      </ProjectProvider>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
  })

  // The Install card has its own fetch, so it needs the prop passed to it
  // explicitly -- nothing structural carries it. Without this, dropping
  // `onUnauthorized` at that one call site leaves an expired session on
  // this screen with the card silently swallowing the 401, and every test
  // in `AboutSection.test.tsx` still green.
  it('calls onUnauthorized on a 401 from the version fetch too', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      meta: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    })
    render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Settings client={client} onUnauthorized={onUnauthorized} />
      </ProjectProvider>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
  })
})

// Invented beyond the brief's table.
describe('Settings — projects invented mutations', () => {
  // Every fixture above dismisses the keys panel by never dismissing it at
  // all -- the create tests just assert the keys are present and stop.
  // This drives the explicit dismiss button and confirms the panel is
  // truly gone rather than merely covered, and that dismissing it does not
  // also wipe the (already-refreshed) project list underneath it.
  it('dismisses the keys panel only on the explicit button, and the list survives it', async () => {
    const createProject = vi.fn(async () => createdProject())
    renderSettings(fakeClient({ createProject }))
    await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'Beta')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))
    await screen.findByText('sk_new')

    await userEvent.click(screen.getByRole('button', { name: /saved these keys/i }))
    expect(screen.queryByText('sk_new')).not.toBeInTheDocument()
    expect(screen.queryByText('wk_new')).not.toBeInTheDocument()
    expect(screen.getByText('Alpha')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: /new project/i })).toBeInTheDocument()
  })

  // Every create in the brief's suite succeeds or fails on the first
  // attempt. This retries after a 409 with a DIFFERENT name than the one
  // that collided, to catch a handler that latches into a permanent
  // disabled/error state, or that resubmits the stale first value instead
  // of what is currently in the box.
  it('allows a second, different name to succeed after the first collides', async () => {
    const createProject = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(409, 'project_exists'))
      .mockResolvedValueOnce(
        createdProject({
          id: 3,
          name: 'Gamma',
          slug: 'gamma',
          write_key: 'wk_g',
          server_key: 'sk_g',
        }),
      )
    renderSettings(fakeClient({ createProject }))
    await userEvent.click(await screen.findByRole('button', { name: /new project/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'Alpha')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()

    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'Gamma')
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }))
    expect(await screen.findByText('sk_g')).toBeInTheDocument()
    expect(createProject).toHaveBeenCalledTimes(2)
  })
})
