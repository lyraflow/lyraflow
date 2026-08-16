import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { Funnels } from './Funnels.js'

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

const RUN_ONCE = {
  id: 7,
  name: 'Signup flow',
  definition_version: 1,
  steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
  window_seconds: 604800,
  segment_id: null,
  stale: false,
  last_entered: 1204,
  last_converted: 491,
  last_evaluated_at: '2026-08-15T11:58:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}

const NEVER_RUN = {
  ...RUN_ONCE,
  id: 8,
  name: 'Checkout',
  last_entered: null,
  last_converted: null,
  last_evaluated_at: null,
}

function renderList(funnels: unknown[]) {
  const client = { funnels: vi.fn(async () => funnels) } as unknown as ApiClient
  render(
    <MemoryRouter>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Funnels client={client} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

// Controller correction (binding): `vi.setSystemTime()` is a no-op without
// `vi.useFakeTimers()` -- any test pinning a relative time needs both, or
// the assertion depends on real wall-clock time and passes or fails by
// accident. `shouldAdvanceTime: true` matches every other fake-timer test
// in this package (see `Feed.test.tsx`, `Wizard.test.tsx`): the fake clock
// still ticks in real time from the pinned instant, which is what lets
// `findByRole`'s internal polling (built on `setTimeout`) ever resolve.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Funnels list', () => {
  it('shows the cached rate beside when it was evaluated', async () => {
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'))
    renderList([RUN_ONCE])
    const row = await screen.findByRole('link', { name: /Signup flow/ })
    // The rate and its timestamp must be in the SAME element, not merely both
    // on the page: the server calls this column a cache, not a fact, and
    // requires it always render next to its timestamp.
    expect(row).toHaveTextContent('40.8%')
    expect(row).toHaveTextContent('2 minutes ago')
  })

  it('says a never-run funnel has not been run, rather than showing 0%', async () => {
    renderList([NEVER_RUN])
    const row = await screen.findByRole('link', { name: /Checkout/ })
    expect(row).toHaveTextContent(/not run yet/i)
    expect(row).not.toHaveTextContent('0%')
  })

  it('never calls a run endpoint to freshen the list', async () => {
    const run = vi.fn()
    const client = {
      funnels: vi.fn(async () => [NEVER_RUN]),
      runFunnel: run,
    } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Funnels client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('link', { name: /Checkout/ })
    expect(run).not.toHaveBeenCalled()
  })

  it('marks a stale funnel instead of rendering an empty step chain', async () => {
    renderList([{ ...RUN_ONCE, id: 9, name: 'Broken', stale: true, steps: [] }])
    const row = await screen.findByRole('link', { name: /Broken/ })
    expect(row).toHaveTextContent(/cannot be read/i)
  })

  it('offers the builder when there are no funnels', async () => {
    renderList([])
    expect(await screen.findByRole('link', { name: /create.*funnel/i })).toBeInTheDocument()
  })
})

// Invented beyond the brief, from the stub check: replacing the screen's
// body with a hardcoded success state that never touches `client` at all
// left FIVE of the brief's five given tests green, plus the pin-proof test
// below -- every one of them only inspects rendered text, and none ever
// asserts `client.funnels` was called. Only the unauthorized tests below
// caught the stub, because they're the only ones that make the fetch
// itself reject. This is the single assertion that collapses that gap: a
// component that never calls the client at all now fails immediately,
// exactly `Settings.test.tsx`'s own "requests the active project" /
// "re-requests for the newly active project" pair.
describe('Funnels list — invented mutations', () => {
  it('requests funnels for the active project', async () => {
    const client = { funnels: vi.fn(async () => [RUN_ONCE]) } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Funnels client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('link', { name: /Signup flow/ })
    expect(client.funnels).toHaveBeenCalledWith(1)
  })

  // A hardcoded `client.funnels(1)` satisfies the test above too -- this is
  // the one that actually distinguishes a genuine `activeId` read from a
  // hardcoded literal, by switching the active project to an id the
  // hardcoded call cannot produce.
  it('re-requests for the newly active project, not a fixed id', async () => {
    const client = { funnels: vi.fn(async () => [RUN_ONCE]) } as unknown as ApiClient
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
      <MemoryRouter>
        <ProjectProvider projects={projects} initialId={1}>
          <Funnels client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(client.funnels).toHaveBeenCalledWith(1))

    view.rerender(
      <MemoryRouter>
        <ProjectProvider projects={projects} initialId={2}>
          <Funnels client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(client.funnels).toHaveBeenCalledWith(2))
  })
})

// Invented beyond the brief. The given suite never exercises `onUnauthorized`
// at all -- confirmed directly: routing a 401 to `setError(true)` instead of
// `onUnauthorized?.()` left the whole given suite green, since none of its
// fixtures ever reject. This mirrors `Settings.test.tsx`'s own "calls
// onUnauthorized on a 401" pin -- Funnels has exactly the same shape of
// fetch-once effect and deserves the same guard against an admin sitting on
// `/funnels` with an expired session falling into the generic error banner
// forever instead of being routed back to login.
describe('Funnels list — unauthorized', () => {
  it('calls onUnauthorized on a 401 from the funnels fetch, not the generic error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = {
      funnels: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Funnels client={client} onUnauthorized={onUnauthorized} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an error instead of hanging forever when the funnels fetch fails for any other reason', async () => {
    const client = {
      funnels: vi.fn(async () => {
        throw new Error('boom')
      }),
    } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Funnels client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})

// Proves the time pin actually pins something: with `formatRelative`'s
// minute threshold widened, "2 minutes ago" would instead read "just now",
// and this test is the one that would notice. Guards against a fake-timer
// setup that LOOKS deterministic but never actually exercises the pinned
// value (the failure the controller correction above exists to prevent).
describe('Funnels list — pin proof', () => {
  it('is sensitive to the relative-time threshold, not just present', async () => {
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'))
    renderList([RUN_ONCE])
    const row = await screen.findByRole('link', { name: /Signup flow/ })
    expect(row).not.toHaveTextContent('just now')
    expect(row).toHaveTextContent('2 minutes ago')
  })
})
