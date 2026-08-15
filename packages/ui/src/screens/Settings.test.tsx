import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { ApiClient } from '../api/client.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { Settings } from './Settings.js'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
  },
]

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    project: vi.fn(async () => ({ name: 'Alpha', slug: 'alpha', write_key: 'wk_abc123' })),
    usage: vi.fn(async () => ({
      month: '2026-08',
      events_accepted: 42180,
      events_rejected: 17,
      events_throttled: 0,
      monthly_event_quota: 50000000,
    })),
    projects: vi.fn(async () => PROJECTS),
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
})

describe('Settings — usage', () => {
  it('shows this month against the quota', async () => {
    renderSettings()
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
          monthly_event_quota: null,
        })),
      }),
    )
    expect(await screen.findByText(/unlimited/i)).toBeInTheDocument()
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument()
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
