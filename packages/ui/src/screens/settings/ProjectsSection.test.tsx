import { render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import type { Project } from '../../api/types.js'
import { ProjectProvider } from '../../app/ProjectContext.js'
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
