import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { FunnelBuilder } from './FunnelBuilder.js'
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

  // I4 (whole-branch review): a funnel that RAN and found nobody used to
  // render identically to a funnel that has NEVER run -- both said "Not run
  // yet", losing the timestamp and the fact that it ran at all. Existing
  // coverage (above) only exercised `last_evaluated_at: null`; this is the
  // distinct case, `last_evaluated_at` SET with `last_entered: 0`.
  it('says a funnel that ran and found nobody actually ran, and when -- not "not run yet"', async () => {
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'))
    renderList([{ ...RUN_ONCE, last_entered: 0, last_converted: 0 }])
    const row = await screen.findByRole('link', { name: /Signup flow/ })
    expect(row).not.toHaveTextContent(/not run yet/i)
    expect(row).toHaveTextContent('0 entered')
    expect(row).toHaveTextContent('2 minutes ago')
  })

  // MINOR (whole-branch review): `last_entered` is typed `number | null` --
  // a non-null `last_evaluated_at` paired with a NULL (not literal 0)
  // `last_entered` used to fall through to `Number(last_converted) /
  // Number(last_entered)`, which is `x / 0` (`Number(null) === 0`) and
  // renders as a silent, misleading "0%" via formatPercent's NaN/Infinity
  // guard -- reading as a real computed rate rather than "no rate on the
  // wire for this row".
  it('does not divide by a null last_entered -- same "0 entered" text, never "0%"', async () => {
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'))
    renderList([{ ...RUN_ONCE, last_entered: null, last_converted: null }])
    const row = await screen.findByRole('link', { name: /Signup flow/ })
    expect(row).not.toHaveTextContent(/not run yet/i)
    expect(row).not.toHaveTextContent('0%')
    expect(row).toHaveTextContent('0 entered')
    expect(row).toHaveTextContent('2 minutes ago')
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

// Defect 2 from the Task 8 visual pass: the binding spec requires every row
// to carry the window and whether a segment filter applies, alongside the
// name/chain/rate the given suite already covered -- neither was rendered.
// `RUN_ONCE`'s own window (604800s = 7 days) is deliberately NOT reused
// here: a fixture using the 7-day default could pass against a component
// that hardcodes "7-day window" regardless of the funnel's actual value, so
// both tests below pick a window that is NOT 7 days.
describe('Funnels list — window and segment filter', () => {
  it("shows the funnel's window in human units, not the raw seconds", async () => {
    renderList([{ ...RUN_ONCE, window_seconds: 3600 }])
    const row = await screen.findByRole('link', { name: /Signup flow/ })
    expect(row).toHaveTextContent('1-hour window')
    expect(row).not.toHaveTextContent('3600')
  })

  it('shows no segment indicator when segment_id is null', async () => {
    renderList([{ ...RUN_ONCE, window_seconds: 2_592_000, segment_id: null }])
    const row = await screen.findByRole('link', { name: /Signup flow/ })
    expect(row).toHaveTextContent('30-day window')
    expect(within(row).queryByText(/segment/i)).toBeNull()
  })

  it('shows a segment indicator when segment_id is non-null', async () => {
    renderList([{ ...RUN_ONCE, window_seconds: 2_592_000, segment_id: 4 }])
    const row = await screen.findByRole('link', { name: /Signup flow/ })
    expect(within(row).getByText(/segment/i)).toBeInTheDocument()
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

/** Step 1 = page_view, Step 2 = signup_completed -- same sequence
 * `FunnelBuilder.test.tsx`'s own helper uses; duplicated locally rather than
 * imported so this file's fixture doesn't reach across a test-only module
 * boundary for one helper. */
async function fillTwoSteps() {
  await userEvent.type(screen.getByLabelText('Step 1'), 'page_view')
  await userEvent.click(screen.getByRole('button', { name: /add step/i }))
  await userEvent.type(screen.getByLabelText('Step 2'), 'signup_completed')
}

// On the previous plan the settings screen kept a private fetch while the
// header switcher read context, so a newly created project was invisible in
// the switcher until reload -- two sources of truth for one list, both
// looking correct. This is the same shape of test for funnels: a create in
// the builder must be visible in the list without a reload, which only
// holds if `Funnels` re-fetches on mount rather than serving a copy held
// above the route.
//
// Deliberately mounts `Funnels` TWICE -- once before navigating away to
// create, once after returning -- rather than only once after the create.
// A guarantee about "re-fetch on mount, no cache above the route" can only
// be pinned by a scenario with a SECOND mount for a cache to have been
// populated before: the real-world shape this protects is "open the list,
// navigate away to create a funnel, save, come back," and a single-mount
// test cannot tell a genuine re-fetch apart from a cache that merely
// happens to be empty the one time it's ever consulted (see the fix-round
// report for the lazy-cache mutation this restructure was needed for).
describe('Funnels list — single source of truth with the builder', () => {
  it('shows a funnel created elsewhere without requiring a reload', async () => {
    const created = {
      ...RUN_ONCE,
      id: 11,
      name: 'Brand new',
      last_evaluated_at: null,
      last_entered: null,
      last_converted: null,
    }
    let listed: unknown[] = [RUN_ONCE]
    const client = {
      funnels: vi.fn(async () => listed),
      segments: vi.fn(async () => []),
      schemaEvents: vi.fn(async () => []),
      createFunnel: vi.fn(async () => {
        listed = [RUN_ONCE, created]
        return created
      }),
    } as unknown as ApiClient

    render(
      <MemoryRouter initialEntries={['/funnels']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route path="/funnels" element={<Funnels client={client} />} />
            <Route path="/funnels/new" element={<FunnelBuilder client={client} />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )

    // Mount 1: the list starts here and fetches what already exists.
    // Asserted explicitly (not just implied by what comes later) so this
    // test proves the first mount really happened, rather than assuming it.
    expect(await screen.findByRole('link', { name: /Signup flow/ })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Brand new/ })).toBeNull()

    // Navigate away and create -- exercises the SAME create -> list
    // navigation ruled on in fix round 1 (create still goes to the list;
    // only edit goes to the funnel's own detail page). This assertion is
    // deliberately kept: weakening it back to a single mount would also
    // silently un-pin that ruling.
    await userEvent.click(screen.getByRole('link', { name: /create funnel/i }))
    await fillTwoSteps()
    await userEvent.type(screen.getByLabelText(/name/i), 'Brand new')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    // Mount 2: back on the list. This is the mount a cache populated on
    // mount 1 -- eager OR lazy -- would serve stale data from; the new
    // funnel appearing here is what proves there is no such cache.
    expect(await screen.findByRole('link', { name: /Brand new/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Signup flow/ })).toBeInTheDocument()
  })
})
