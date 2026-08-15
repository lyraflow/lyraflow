import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import { DEFAULT_WIZARD_POLL_INTERVAL_MS, Wizard } from './Wizard.js'

const CREATED = { name: 'My App', slug: 'my-app', write_key: 'wk_new', server_key: 'sk_new' }

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => vi.useRealTimers())

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    createProject: vi.fn(async () => CREATED),
    projects: vi.fn(async () => [
      {
        id: 7,
        name: 'My App',
        slug: 'my-app',
        created_at: '',
        retention_months: 24,
        monthly_event_quota: null,
      },
    ]),
    events: vi.fn(async () => ({ events: [], next_cursor: null })),
    ...over,
  } as never
}

describe('Wizard', () => {
  it('starts by asking for a project name, with no snippet yet', () => {
    render(<Wizard client={fakeClient()} onReady={vi.fn()} pollIntervalMs={10} />)
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
    expect(screen.queryByTestId('install-snippet')).not.toBeInTheDocument()
  })

  it('shows the snippet with the new write key after creating', async () => {
    render(<Wizard client={fakeClient()} onReady={vi.fn()} pollIntervalMs={10} />)
    await userEvent.type(screen.getByLabelText(/name/i), 'My App')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    const block = await screen.findByTestId('install-snippet')
    expect(block.textContent).toContain('wk_new')
  })

  // The whole point of the screen: it does not claim success until an
  // event has actually arrived.
  it('waits, then reports success only once an event arrives', async () => {
    let arrived = false
    const client = fakeClient({
      events: vi.fn(async () => ({
        events: arrived ? [{ event_id: 'e1', event_name: 'page_view' }] : [],
        next_cursor: null,
      })),
    })
    const onReady = vi.fn()
    render(<Wizard client={client} onReady={onReady} pollIntervalMs={10} />)
    await userEvent.type(screen.getByLabelText(/name/i), 'My App')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    expect(await screen.findByText(/waiting/i)).toBeInTheDocument()
    expect(onReady).not.toHaveBeenCalled()

    arrived = true
    await vi.advanceTimersByTimeAsync(50)
    await waitFor(() => expect(onReady).toHaveBeenCalled())
  })

  it('keeps waiting rather than failing when a poll errors', async () => {
    const client = fakeClient({
      events: vi.fn(async () => {
        throw new ApiError(503, 'unavailable')
      }),
    })
    render(<Wizard client={client} onReady={vi.fn()} pollIntervalMs={10} />)
    await userEvent.type(screen.getByLabelText(/name/i), 'My App')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    await vi.advanceTimersByTimeAsync(50)
    expect(await screen.findByText(/waiting/i)).toBeInTheDocument()
  })

  it('reports a duplicate name and stays on the first step', async () => {
    const client = fakeClient({
      createProject: vi.fn(async () => {
        throw new ApiError(409, 'project_exists')
      }),
    })
    render(<Wizard client={client} onReady={vi.fn()} pollIntervalMs={10} />)
    await userEvent.type(screen.getByLabelText(/name/i), 'Taken')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toBeInTheDocument()
  })

  // Someone instrumenting a site they cannot deploy to right now must not
  // be trapped on this screen forever.
  it('offers a way through without waiting for an event', async () => {
    const onReady = vi.fn()
    render(<Wizard client={fakeClient()} onReady={onReady} pollIntervalMs={10} />)
    await userEvent.type(screen.getByLabelText(/name/i), 'My App')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    await userEvent.click(await screen.findByRole('button', { name: /skip|later|dashboard/i }))
    expect(onReady).toHaveBeenCalled()
  })

  // The production default itself, pinned as a plain value -- no timer has
  // to prove it, and it cannot be quietly changed without this failing.
  it('defaults the poll interval to a few seconds', () => {
    expect(DEFAULT_WIZARD_POLL_INTERVAL_MS).toBe(3000)
  })

  // Invented mutation 1: the server key is required here by the brief
  // ("this is its one showing"), but none of the prescribed tests above
  // ever look for it -- a wizard that silently dropped it would pass every
  // test above. Pin its presence and its one-time-only warning directly.
  it('shows the new server key with a not-shown-again warning', async () => {
    render(<Wizard client={fakeClient()} onReady={vi.fn()} pollIntervalMs={10} />)
    await userEvent.type(screen.getByLabelText(/name/i), 'My App')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    const panel = await screen.findByTestId('wizard-server-key')
    expect(panel.textContent).toContain('sk_new')
    expect(panel.textContent).toMatch(/not be shown again/i)
  })

  // Invented mutation 2: every fake `events()` in the tests above ignores
  // its arguments entirely, so a Wizard that polled a hardcoded or
  // undefined project id -- instead of the id resolved from the freshly
  // created project -- would pass every test above too. Pin the actual
  // call.
  it('polls events for the newly created project, not a placeholder id', async () => {
    const client = fakeClient()
    render(<Wizard client={client} onReady={vi.fn()} pollIntervalMs={10} />)
    await userEvent.type(screen.getByLabelText(/name/i), 'My App')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    await screen.findByTestId('install-snippet')
    await vi.advanceTimersByTimeAsync(10)
    await waitFor(() =>
      expect((client as { events: ReturnType<typeof vi.fn> }).events).toHaveBeenCalledWith(7, {
        limit: 1,
      }),
    )
  })
})
