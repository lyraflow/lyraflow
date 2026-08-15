import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
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
