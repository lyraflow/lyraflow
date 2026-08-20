import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import { DEFAULT_WIZARD_POLL_INTERVAL_MS, Wizard } from './Wizard.js'

// The full `CreatedProject` shape (#89): `createProject`'s response alone
// now carries the numeric id polling needs, so this fixture must too, or a
// regression back to resolving it via a second `projects()` call would go
// uncaught.
const CREATED = {
  id: 7,
  name: 'My App',
  slug: 'my-app',
  created_at: '',
  retention_months: 24,
  monthly_event_quota: null,
  disabled_at: null,
  write_key: 'wk_new',
  server_key: 'sk_new',
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => vi.useRealTimers())

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    createProject: vi.fn(async () => CREATED),
    // A stand-in for a stale/failing refetch: if the wizard ever calls this
    // again, it answers with a DIFFERENT id (99) than the one `createProject`
    // already returned, so a regression back to resolving polling from here
    // is caught by "polls events for the newly created project" below
    // rather than passing by coincidence.
    projects: vi.fn(async () => [
      {
        id: 99,
        name: 'My App',
        slug: 'my-app',
        created_at: '',
        retention_months: 24,
        monthly_event_quota: null,
        disabled_at: null,
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
  // event has actually arrived -- and, per the CRITICAL fix, it does not
  // leave on its own just because one did. An arriving event flips step 3
  // into its success state; only an explicit click on "Continue to
  // dashboard" actually calls `onReady`.
  it('waits, then shows success (without leaving) once an event arrives, and leaves only on the click', async () => {
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
    expect(await screen.findByText(/first event received/i)).toBeInTheDocument()
    // The critical assertion: the event arriving alone must NOT have fired
    // `onReady` -- that auto-fire is exactly what used to unmount this
    // screen (and the server key with it) the instant the operator did what
    // step 3 told them to do.
    expect(onReady).not.toHaveBeenCalled()
    // ...and the server key must still be on screen at this point, not
    // already gone with a dismissed wizard.
    expect(screen.getByTestId('wizard-server-key').textContent).toContain('sk_new')

    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    expect(onReady).toHaveBeenCalled()
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

  // Task 8's visual fixes shipped with zero regression tests -- these two
  // pin the cheaply pinnable ones (small fix from the whole-branch review).
  it('keeps step 1 numbered and visible after creating, not replaced by the title alone', async () => {
    render(<Wizard client={fakeClient()} onReady={vi.fn()} pollIntervalMs={10} />)
    await userEvent.type(screen.getByLabelText(/name/i), 'My App')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    expect(await screen.findByText('1. Project created')).toBeInTheDocument()
  })

  // `min-h-dvh`, not `h-dvh`: a fixed height combined with `justify-center`
  // clips content taller than the viewport at a negative, unreachable
  // scroll offset (see the component's own comment). A regression back to
  // `h-dvh` would pass every other test in this file, since none of them
  // assert on layout classes at all.
  it('uses min-h-dvh on the outer container, not a fixed h-dvh', () => {
    const { container } = render(
      <Wizard client={fakeClient()} onReady={vi.fn()} pollIntervalMs={10} />,
    )
    const outer = container.firstElementChild
    expect(outer?.className).toContain('min-h-dvh')
    expect(outer?.className).not.toMatch(/(?<!min-)\bh-dvh\b/)
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

  // Fix round 1 on #89: `createProject`'s response now carries the id
  // directly (`CreatedProject` extends `Project`), so the wizard no longer
  // needs a second `GET /v1/projects` to resolve it. `fakeClient`'s
  // `projects` fixture answers with a DIFFERENT id (99) specifically so a
  // regression back to that refetch is caught two ways: this assertion
  // that the call never happens, and the previous test's id-7 pin, which
  // would instead see 99.
  it('never calls GET /v1/projects to resolve the created project', async () => {
    const client = fakeClient()
    render(<Wizard client={client} onReady={vi.fn()} pollIntervalMs={10} />)
    await userEvent.type(screen.getByLabelText(/name/i), 'My App')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    await screen.findByTestId('install-snippet')
    await vi.advanceTimersByTimeAsync(10)
    await waitFor(() =>
      expect((client as { events: ReturnType<typeof vi.fn> }).events).toHaveBeenCalled(),
    )
    expect((client as { projects: ReturnType<typeof vi.fn> }).projects).not.toHaveBeenCalled()
  })
})
