import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { Project, ProjectDeletion } from '../../api/types.js'
import { ProjectProvider, useProject } from '../../app/ProjectContext.js'
import { Shell } from '../../app/Shell.js'
import { ProjectsSection } from './ProjectsSection.js'

function project(over: Partial<Project> = {}): Project {
  return {
    id: 1,
    name: 'Demo Data',
    slug: 'demo-data',
    created_at: '2026-08-01T00:00:00.000Z',
    retention_months: 13,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
    ...over,
  }
}

/** Answers a PATCH with the row as it would be stored -- the response is
 * what the component merges, never its own optimistic guess. */
function fakeClient(over: Partial<Project> = {}) {
  const updateProject = vi.fn(async (id: number, patch: { name?: string; archived?: boolean }) => ({
    ...project({ id, ...over }),
    ...(patch.name === undefined ? {} : { name: patch.name }),
    disabled_at:
      patch.archived === undefined
        ? (over.disabled_at ?? null)
        : patch.archived
          ? '2026-08-20T10:00:00.000Z'
          : null,
  }))
  return { client: { updateProject } as unknown as ApiClient, updateProject }
}

function renderSection(projects: Project[], client: ApiClient) {
  return render(
    <ProjectProvider projects={projects} initialId={projects[0]?.id ?? null}>
      <ProjectsSection client={client} />
    </ProjectProvider>,
  )
}

const row = (name: string) => screen.getByText(name).closest('li') as HTMLElement

describe('ProjectsSection — rename', () => {
  it('sends the new name and shows what came back', async () => {
    const { client, updateProject } = fakeClient()
    renderSection([project()], client)

    await userEvent.click(within(row('Demo Data')).getByRole('button', { name: 'Rename' }))
    const field = screen.getByLabelText('New name for Demo Data')
    await userEvent.clear(field)
    await userEvent.type(field, 'Production')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(updateProject).toHaveBeenCalledWith(1, { name: 'Production' })
    await waitFor(() => expect(screen.getByText('Production')).toBeInTheDocument())
  })

  // The slug is what the CLI addresses a project by, and this is the only
  // screen that says so -- an operator whose scripts call `seed-demo
  // demo-data` needs to see the handle is not the name they just edited.
  it('shows the slug beside the name and leaves it alone across a rename', async () => {
    const { client } = fakeClient()
    renderSection([project()], client)
    expect(screen.getByText('demo-data')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await userEvent.clear(screen.getByLabelText('New name for Demo Data'))
    await userEvent.type(screen.getByLabelText('New name for Demo Data'), 'Production')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(screen.getByText('Production')).toBeInTheDocument())
    expect(screen.getByText('demo-data')).toBeInTheDocument()
  })

  it('cancels without sending anything', async () => {
    const { client, updateProject } = fakeClient()
    renderSection([project()], client)
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await userEvent.type(screen.getByLabelText('New name for Demo Data'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(updateProject).not.toHaveBeenCalled()
    expect(screen.getByText('Demo Data')).toBeInTheDocument()
  })

  it('refuses to save an empty name without asking the server', async () => {
    const { client, updateProject } = fakeClient()
    renderSection([project()], client)
    await userEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await userEvent.clear(screen.getByLabelText('New name for Demo Data'))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(updateProject).not.toHaveBeenCalled()
  })
})

describe('ProjectsSection — archive', () => {
  // Archiving stops ingest, which is outward-facing and invisible from this
  // screen: every page already carrying the snippet starts being refused.
  // One click must therefore never be treated as consent.
  it('asks before archiving, and says what archiving does', async () => {
    const { client, updateProject } = fakeClient()
    renderSection([project()], client)

    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(updateProject).not.toHaveBeenCalled()
    expect(screen.getByText(/stops Lyraflow accepting events/)).toBeInTheDocument()
    // And says the two things that decide whether it is safe: nothing is
    // deleted, and refused events do not arrive later.
    expect(screen.getByText(/Nothing is deleted/)).toBeInTheDocument()
    expect(screen.getByText(/refused, not queued/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Archive Demo Data' }))
    expect(updateProject).toHaveBeenCalledWith(1, { archived: true })
  })

  it('backs out of the confirmation without archiving', async () => {
    const { client, updateProject } = fakeClient()
    renderSection([project()], client)
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(updateProject).not.toHaveBeenCalled()
    expect(screen.queryByText(/stops Lyraflow accepting events/)).not.toBeInTheDocument()
  })

  it('marks an archived project and offers to restore it', async () => {
    const { client, updateProject } = fakeClient()
    renderSection([project({ disabled_at: '2026-08-20T10:00:00.000Z' })], client)

    expect(screen.getByText('archived')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument()

    // Restoring needs no confirmation: it can only ever admit more.
    await userEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(updateProject).toHaveBeenCalledWith(1, { archived: false })
    await waitFor(() => expect(screen.queryByText('archived')).not.toBeInTheDocument())
  })

  it('reports a failure on the row it happened to, and changes nothing', async () => {
    const client = {
      updateProject: vi.fn(async () => {
        throw new Error('boom')
      }),
    } as unknown as ApiClient
    renderSection([project()], client)
    await userEvent.click(screen.getByRole('button', { name: 'Archive' }))
    await userEvent.click(screen.getByRole('button', { name: 'Archive Demo Data' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save')
    expect(screen.queryByText('archived')).not.toBeInTheDocument()
  })

  // Each row owns its own state: renaming one while archiving another is
  // the ordinary case on an install with several sites, and shared flags in
  // the parent would make the two rows fight over them.
  it("keeps one row's state out of another's", async () => {
    const { client } = fakeClient()
    renderSection([project(), project({ id: 2, name: 'Marketing', slug: 'marketing' })], client)

    await userEvent.click(within(row('Demo Data')).getByRole('button', { name: 'Rename' }))
    expect(screen.getByLabelText('New name for Demo Data')).toBeInTheDocument()
    expect(within(row('Marketing')).getByRole('button', { name: 'Rename' })).toBeInTheDocument()
    expect(screen.queryByLabelText('New name for Marketing')).not.toBeInTheDocument()
  })
})

describe('ProjectsSection — delete', () => {
  const NOW = '2026-08-21T09:00:00.000Z'
  // `name` deliberately differs from `slug` -- the row renders both, and a
  // fixture where they're identical makes every text query ambiguous
  // (`getByText('acme')` would match the name span AND the slug span).
  const acme = project({ id: 1, name: 'Acme Corp', slug: 'acme' })
  const other = project({ id: 2, name: 'Other Co', slug: 'other' })

  /** A `render` wrapper -- this describe block's tests need
   * `{ wrapper: withProjects([...]) }`, not a helper that renders itself. */
  function withProjects(projects: Project[]) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ProjectProvider projects={projects} initialId={projects[0]?.id ?? null}>
          {children}
        </ProjectProvider>
      )
    }
  }

  let client: ApiClient
  let user: ReturnType<typeof userEvent.setup>

  beforeEach(() => {
    // `shouldAdvanceTime` lets `user.click`/`user.type` (both driven by real
    // promises under the hood) resolve normally while `vi.advanceTimersByTimeAsync`
    // still drives the poll effect's `setInterval` -- the same technique
    // `usePolling.test.ts` and `Feed.test.tsx` already use for a polled screen.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    user = userEvent.setup({ delay: null })
    client = {
      deleteProject: vi.fn(async () => ({ id: 1, project_id: acme.id, status: 'pending' })),
      projectDeletion: vi.fn(
        async (): Promise<ProjectDeletion> => ({
          status: 'in_progress',
          requested_at: NOW,
          completed_at: null,
        }),
      ),
    } as unknown as ApiClient
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** Opens the row's delete confirmation, types the slug exactly, and
   * confirms -- the flow every polling test starts from. */
  async function confirmDelete(slug: string) {
    // Scoped to the row: more than one project on screen means more than
    // one plain "Delete" button, and only the row's own must be clicked.
    await user.click(within(row(slug)).getByRole('button', { name: 'Delete' }))
    await user.type(screen.getByLabelText(new RegExp(`Type ${slug} to confirm`)), slug)
    await user.click(screen.getByRole('button', { name: new RegExp(`Delete ${slug} permanently`) }))
  }

  it('keeps the delete button disabled until the slug is typed exactly', async () => {
    render(<ProjectsSection client={client} />, { wrapper: withProjects([acme]) })
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    const confirm = screen.getByRole('button', { name: /Delete acme permanently/ })
    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText(/Type acme to confirm/), 'acm')
    expect(confirm).toBeDisabled()
    await user.type(screen.getByLabelText(/Type acme to confirm/), 'e')
    expect(confirm).toBeEnabled()
  })

  it('says what delete destroys, at the moment of asking', async () => {
    render(<ProjectsSection client={client} />, { wrapper: withProjects([acme]) })
    await user.click(screen.getByRole('button', { name: 'Delete' }))
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument()
  })

  it('polls after a delete and removes the row when it completes', async () => {
    client.deleteProject = vi.fn(async () => ({ id: 7, project_id: acme.id, status: 'pending' }))
    client.projectDeletion = vi
      .fn()
      .mockResolvedValueOnce({ status: 'in_progress', requested_at: NOW, completed_at: null })
      .mockResolvedValueOnce({ status: 'completed', requested_at: NOW, completed_at: NOW })
    render(<ProjectsSection client={client} />, { wrapper: withProjects([acme, other]) })
    await confirmDelete('acme')
    expect(await screen.findByText('deleting')).toBeInTheDocument()
    await vi.advanceTimersByTimeAsync(6000)
    // The removal lands via `removeProject`, triggered from inside the poll
    // effect's own `setInterval` callback rather than an RTL-tracked event --
    // `waitFor` is what the rest of this codebase reaches for after a fake-
    // timer advance for exactly that reason (see `Feed.test.tsx`).
    await waitFor(() => expect(screen.queryByText('acme')).not.toBeInTheDocument())
    expect(screen.getByText('other')).toBeInTheDocument()
  })

  it('shows the error and keeps the row when a deletion fails', async () => {
    client.deleteProject = vi.fn(async () => ({ id: 7, project_id: acme.id, status: 'pending' }))
    client.projectDeletion = vi.fn(async () => ({
      status: 'failed' as const,
      requested_at: NOW,
      completed_at: null,
      error: 'ClickHouse unreachable',
    }))
    render(<ProjectsSection client={client} />, { wrapper: withProjects([acme]) })
    await confirmDelete('acme')
    await vi.advanceTimersByTimeAsync(3500)
    expect(await screen.findByText(/ClickHouse unreachable/)).toBeInTheDocument()
    expect(screen.getByText('acme')).toBeInTheDocument()
  })

  it('stops polling when unmounted', async () => {
    client.deleteProject = vi.fn(async () => ({ id: 7, project_id: acme.id, status: 'pending' }))
    client.projectDeletion = vi.fn(async () => ({
      status: 'in_progress' as const,
      requested_at: NOW,
      completed_at: null,
    }))
    const view = render(<ProjectsSection client={client} />, { wrapper: withProjects([acme]) })
    await confirmDelete('acme')
    await vi.advanceTimersByTimeAsync(3500)
    const callsBefore = (client.projectDeletion as ReturnType<typeof vi.fn>).mock.calls.length
    view.unmount()
    await vi.advanceTimersByTimeAsync(10_000)
    expect((client.projectDeletion as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(
      callsBefore,
    )
  })

  it('renders a project that was already deleting as deleting, with its controls disabled', async () => {
    render(<ProjectsSection client={client} />, {
      wrapper: withProjects([{ ...acme, deleting_at: NOW }]),
    })
    expect(screen.getByText('deleting')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled()
  })

  // A delete started in THIS tab must close the header switcher to the
  // project immediately, on the 202 -- not only once a poll happens to
  // catch up. Otherwise the switcher keeps offering a project mid-teardown
  // for the whole 3s (or longer) window before the first poll tick, which
  // is exactly the failure `Shell.tsx`'s own filter exists to prevent.
  it('closes the switcher to the project the moment a delete is confirmed, before any poll has run', async () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <ProjectProvider projects={[acme, other]} initialId={acme.id}>
          <Shell email="a@example.com" onLogout={() => {}}>
            <ProjectsSection client={client} />
          </Shell>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await confirmDelete('acme')
    // `client.projectDeletion`'s default (beforeEach) never resolves to
    // 'completed', and no timer is advanced here -- this is the state
    // BEFORE the first poll tick, the window the switcher must already
    // reflect.
    await user.click(screen.getByRole('button', { name: /Acme Corp/ }))
    expect(screen.queryByRole('option', { name: /Acme Corp/ })).not.toBeInTheDocument()
    expect(screen.getByRole('option', { name: /Other Co/ })).toBeInTheDocument()
  })

  // Pins the poll effect's `if (cancelled) return` guard specifically.
  // `clearInterval` (also run on unmount) only stops FUTURE ticks -- it
  // does not cancel a callback invocation already in flight, awaiting a
  // response that has not landed yet. Without the flag, a response that
  // resolves after unmount would still call `onDeleted`, mutating a
  // context that has outlived this row.
  it('ignores a poll response that resolves after the row unmounted mid-poll', async () => {
    client.deleteProject = vi.fn(async () => ({ id: 7, project_id: acme.id, status: 'pending' }))
    let resolvePoll: (v: ProjectDeletion) => void = () => {}
    client.projectDeletion = vi.fn(
      () =>
        new Promise<ProjectDeletion>((resolve) => {
          resolvePoll = resolve
        }),
    )

    function ProjectCount() {
      const { projects } = useProject()
      return <span data-testid="count">{projects.length}</span>
    }

    function Harness() {
      const [show, setShow] = useState(true)
      return (
        <>
          <ProjectCount />
          <button type="button" onClick={() => setShow(false)}>
            hide
          </button>
          {show && <ProjectsSection client={client} />}
        </>
      )
    }

    render(
      <ProjectProvider projects={[acme]} initialId={acme.id}>
        <Harness />
      </ProjectProvider>,
    )
    await confirmDelete('acme')
    // Fires the poll's one tick; `client.projectDeletion`'s promise is now
    // in flight and will not settle until `resolvePoll` is called below.
    await vi.advanceTimersByTimeAsync(3000)
    expect(client.projectDeletion).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: 'hide' }))
    resolvePoll({ status: 'completed', requested_at: NOW, completed_at: NOW })
    await vi.advanceTimersByTimeAsync(0)

    expect(screen.getByTestId('count').textContent).toBe('1')
  })

  // The 401 branch of `startDelete` is a DIFFERENT condition from a
  // completed deletion emptying the list: the admin's own session expired,
  // the same routine, recoverable case `Settings`'s own two fetches already
  // report as `onUnauthorized`. Reporting it as `onSessionStale` instead
  // would re-fetch the session, 401 again because it really is gone, and
  // land on "server not responding" -- this pins it going to the login
  // screen's own signal instead.
  it('reports a 401 starting a delete as an expired session, not as the list emptying', async () => {
    client.deleteProject = vi.fn(async () => {
      throw new ApiError(401, 'no_session')
    })
    const onUnauthorized = vi.fn()
    const onSessionStale = vi.fn()
    render(
      <ProjectsSection
        client={client}
        onUnauthorized={onUnauthorized}
        onSessionStale={onSessionStale}
      />,
      { wrapper: withProjects([acme]) },
    )
    await confirmDelete('acme')
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
    expect(onSessionStale).not.toHaveBeenCalled()
  })

  // Regression: `handleDeleted` used to depend directly on `projects`,
  // which is `ProjectContext`'s own state array and gets a fresh reference
  // on every `updateProject` call -- including a rename on a DIFFERENT row.
  // `ProjectRow`'s poll effect depends on `onDeleted`'s identity, so that
  // unrelated rename tore down and restarted the `setInterval` for a row
  // that was mid-delete, resetting its 3-second clock. Pinned by starting
  // a delete on `acme`, renaming `other` partway through the first poll
  // interval, and checking the original tick still lands on schedule
  // rather than being pushed out by a second interval.
  it("does not reset another row's poll timer when an unrelated rename lands mid-delete", async () => {
    client.deleteProject = vi.fn(async () => ({ id: 7, project_id: acme.id, status: 'pending' }))
    client.projectDeletion = vi.fn(async () => ({
      status: 'in_progress' as const,
      requested_at: NOW,
      completed_at: null,
    }))
    client.updateProject = vi.fn(async (id: number, patch: { name?: string }) => ({
      ...other,
      id,
      ...(patch.name === undefined ? {} : { name: patch.name }),
    }))
    render(<ProjectsSection client={client} />, { wrapper: withProjects([acme, other]) })
    await confirmDelete('acme')
    expect(await screen.findByText('deleting')).toBeInTheDocument()

    // Partway through the first 3s poll interval -- renaming `other` here
    // must not be what decides whether `acme`'s next poll lands on time.
    await vi.advanceTimersByTimeAsync(2000)
    await user.click(within(row('Other Co')).getByRole('button', { name: 'Rename' }))
    await user.clear(screen.getByLabelText('New name for Other Co'))
    await user.type(screen.getByLabelText('New name for Other Co'), 'Renamed Co')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(client.updateProject).toHaveBeenCalledTimes(1))

    // The remaining 1s of the ORIGINAL 3s window: if the poll effect had
    // been torn down and restarted by the rename, this would not be enough
    // time left for a fresh 3s interval to fire.
    await vi.advanceTimersByTimeAsync(1000)
    await waitFor(() => expect(client.projectDeletion).toHaveBeenCalledTimes(1))
  })
})
