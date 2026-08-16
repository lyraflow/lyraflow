import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Funnel, FunnelRunResult } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { ROUTES, funnelPath } from '../app/Router.js'
import { FunnelDetail } from './FunnelDetail.js'

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

const FUNNEL: Funnel = {
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

const RUN: FunnelRunResult = {
  entered: 1204,
  converted: 491,
  conversion_rate: 0.4078,
  partial_window_entrants: 312,
  range: { since: '2026-08-08T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' },
  as_of: '2026-08-15T11:58:00.000Z',
  warnings: [],
  steps: [
    { index: 1, event: 'page_view', people: 1204, from_previous: 1, from_start: 1 },
    { index: 2, event: 'signup_completed', people: 491, from_previous: 0.4078, from_start: 0.4078 },
  ],
}

/**
 * Every fixture above resolves instantly and ignores the range it was asked
 * for, which is exactly the blind spot the whole-branch review named: no
 * test built on it can tell "the numbers for the range you asked for" apart
 * from "some numbers", or observe a response landing AFTER a state change.
 * `deferred()` gives a test a promise it controls, so a mutation like C1's
 * (a run landing after a range change un-dims wrong-range numbers) can
 * actually be provoked rather than merely asserted against.
 */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    funnel: vi.fn(async () => FUNNEL),
    runFunnel: vi.fn(async () => RUN),
    deleteFunnel: vi.fn(async () => undefined),
    ...over,
  } as unknown as ApiClient & { funnel: Mock; runFunnel: Mock; deleteFunnel: Mock }
}

function renderDetail(client: ApiClient, onUnauthorized?: () => void) {
  render(
    <MemoryRouter initialEntries={[funnelPath(FUNNEL.id)]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route
            path="/funnels/:id"
            element={<FunnelDetail client={client} onUnauthorized={onUnauthorized} />}
          />
          {/* A successful delete navigates to the list route (Task 6) --
           * this harness doesn't render the real `Funnels` screen, just a
           * placeholder so React Router has somewhere to land instead of
           * logging "no routes matched". */}
          <Route path={ROUTES.funnels} element={<p>deleted</p>} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
}

// Controller correction (binding, from Funnels.test.tsx/Task 2): `vi.setSystemTime()`
// alone is a no-op -- it must follow `vi.useFakeTimers()`, or a pinned-time
// assertion depends on real wall-clock time and passes or fails by accident.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('FunnelDetail', () => {
  it('runs the funnel once on open', async () => {
    const client = fakeClient()
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    expect(client.runFunnel).toHaveBeenCalledTimes(1)
  })

  // Invented mutation: swapping the (projectId, id) argument order into
  // `client.funnel(validId, activeId)` left every OTHER test in this file
  // green, since `fakeClient`'s default `funnel` mock ignores its arguments
  // entirely and always resolves to the same `FUNNEL`. This is the one
  // assertion that distinguishes a genuine `(activeId, id)` call from a
  // swapped or hardcoded one.
  it('fetches the funnel for the active project and the id in the URL', async () => {
    const client = fakeClient()
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    expect(client.funnel).toHaveBeenCalledWith(1, FUNNEL.id)
  })

  it('does not re-run when the range changes -- it dims and offers Run', async () => {
    const client = fakeClient()
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')

    await userEvent.selectOptions(screen.getByLabelText(/range/i), '30')

    expect(client.runFunnel).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('funnel-result')).toHaveAttribute('data-stale', 'true')
    expect(screen.getByRole('button', { name: /^run$/i })).toBeEnabled()
  })

  // I1 (whole-branch review): `FunnelRunResult.range` was declared and never
  // read anywhere in the branch -- the subtitle came from `days`, the picker's
  // own state, which moves the instant a new range is picked, before any run
  // has answered it. The mutation this pins: render `Last {days} days` again
  // instead of `formatRangeDays(result.range)`, and this test alone fails.
  it('labels the range from the result that was actually run, not from picker state', async () => {
    const client = fakeClient()
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    expect(screen.getByTestId('funnel-range-label')).toHaveTextContent('Last 7 days')

    // Picking a new range without running must not relabel numbers that were
    // never recomputed for it.
    await userEvent.selectOptions(screen.getByLabelText(/range/i), '30')
    expect(screen.getByTestId('funnel-range-label')).toHaveTextContent('Last 7 days')
  })

  it('marks the result stale so old numbers are never presented as current', async () => {
    // The mutation this pins: remove data-stale and this test alone fails.
    const client = fakeClient()
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    expect(screen.getByTestId('funnel-result')).toHaveAttribute('data-stale', 'false')
    await userEvent.selectOptions(screen.getByLabelText(/range/i), '30')
    expect(screen.getByTestId('funnel-result')).toHaveAttribute('data-stale', 'true')
  })

  it('clears the stale mark after an explicit Run', async () => {
    const client = fakeClient()
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    await userEvent.selectOptions(screen.getByLabelText(/range/i), '30')
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    await waitFor(() =>
      expect(screen.getByTestId('funnel-result')).toHaveAttribute('data-stale', 'false'),
    )
    expect(client.runFunnel).toHaveBeenCalledTimes(2)
    expect(client.runFunnel.mock.calls[1]?.[2]).toMatchObject({ since: expect.any(String) })
  })

  // C1 (CRITICAL, whole-branch review): repro was opening the funnel,
  // picking "Last 30 days", clicking Run, then picking "Last 90 days" WHILE
  // that run was still in flight -- the 30-day response then landed and
  // un-dimmed the screen under a "Last 90 days" subtitle showing 30-day
  // numbers. The mutation this pins: drop the `runDays !== daysRef.current`
  // guard in `runNow`'s `.then`, and this test alone fails (data-stale flips
  // to "false" for a response that does not answer the selected range).
  it('discards a response whose range no longer matches the one now selected', async () => {
    const inFlight = deferred<FunnelRunResult>()
    const runFunnel = vi
      .fn()
      .mockResolvedValueOnce(RUN) // the mount auto-run, for the default 7-day range
      .mockReturnValueOnce(inFlight.promise) // the explicit Run for 30 days, held open
    const client = fakeClient({ runFunnel })
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')

    await userEvent.selectOptions(screen.getByLabelText(/range/i), '30')
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    expect(runFunnel).toHaveBeenCalledTimes(2)

    // Still in flight for 30 days -- the range moves on to 90 before it lands.
    await userEvent.selectOptions(screen.getByLabelText(/range/i), '90')
    expect(screen.getByTestId('funnel-result')).toHaveAttribute('data-stale', 'true')

    // The 30-day response lands now, after the selection moved to 90. Wrapped
    // in act() and given a real turn of the microtask queue so the state
    // update the fix DOESN'T make (and the bug WOULD make) has every chance
    // to land before the assertion below runs.
    await act(async () => {
      inFlight.resolve({
        ...RUN,
        range: { since: '2026-07-16T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' },
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    // Must still read stale: the 30-day answer is not an answer to the
    // 90-day range currently selected.
    expect(screen.getByTestId('funnel-result')).toHaveAttribute('data-stale', 'true')
  })

  it('renders every warning the run returned', async () => {
    const client = fakeClient({
      runFunnel: vi.fn(async () => ({
        ...RUN,
        warnings: [
          { path: 'range', reason: 'alpha reason' },
          { path: 'segment', reason: 'beta reason' },
        ],
      })),
    })
    renderDetail(client)
    expect(await screen.findByText('alpha reason')).toBeInTheDocument()
    expect(screen.getByText('beta reason')).toBeInTheDocument()
  })

  it('shows as_of by value so a cached result cannot read as live', async () => {
    vi.setSystemTime(new Date('2026-08-15T12:00:00.000Z'))
    const client = fakeClient()
    renderDetail(client)
    expect(await screen.findByTestId('funnel-as-of')).toHaveTextContent('2 minutes ago')
    // Invented beyond the brief, from the stub check: a component that never
    // calls the client at all and just renders a hardcoded "2 minutes ago"
    // satisfies the assertion above unchanged. This is the one line that
    // distinguishes a genuine fetched `as_of` from a hardcoded string.
    expect(client.runFunnel).toHaveBeenCalledWith(1, FUNNEL.id, { since: expect.any(String) })
  })

  it('maps a 422 to an actionable message, not the outage banner', async () => {
    const client = fakeClient({
      runFunnel: vi.fn(async () => {
        throw new ApiError(422, 'segment query timed out')
      }),
    })
    renderDetail(client)
    expect(await screen.findByRole('alert')).toHaveTextContent(/narrow the range/i)
  })

  it('routes a 401 to onUnauthorized rather than an error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      runFunnel: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    renderDetail(client, onUnauthorized)
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('does not offer to edit a funnel the server cannot read', async () => {
    const client = fakeClient({ funnel: vi.fn(async () => ({ ...FUNNEL, stale: true })) })
    renderDetail(client)
    await waitFor(() => expect(screen.queryByRole('link', { name: /edit/i })).toBeNull())
  })

  // Invented mutation, from probing the pair above: inverting the `!funnel.stale`
  // guard (offer Edit ONLY for a stale/unreadable funnel, never for a normal
  // one) left every OTHER test in this file green -- nothing asserted the
  // positive case. This is the test that closes that gap.
  it('offers to edit a funnel the server can read', async () => {
    const client = fakeClient()
    renderDetail(client)
    expect(await screen.findByRole('link', { name: /edit/i })).toBeInTheDocument()
  })
})

// MINOR (whole-branch review): `/funnels/abc` used to be a dead screen --
// `validId` nulled out, nothing fetched, no alert, heading read "Funnel".
// Decision 8 treats an unreachable-from-the-UI `invalid_funnel_id` as a 404.
describe('FunnelDetail — invalid id in the URL', () => {
  it('treats an invalid id as a 404, with a link back to the list, not a dead screen', async () => {
    const client = fakeClient()
    render(
      <MemoryRouter initialEntries={['/funnels/abc']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route path="/funnels/:id" element={<FunnelDetail client={client} />} />
            <Route path={ROUTES.funnels} element={<p>funnels list</p>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/i)
    expect(screen.getByRole('link', { name: /back to funnels/i })).toBeInTheDocument()
    // Nothing was ever fetched: an invalid id is caught before any request,
    // never a 404 the server had a chance to answer.
    expect(client.funnel).not.toHaveBeenCalled()
  })
})

// MINOR (whole-branch review): the funnel fetch and the mount auto-run fire
// concurrently, so a fetch failure alongside a successful run could render
// an error banner and a full, confident result together. Two consequences,
// two tests: the result must not render alongside an error, and a Run click
// must not silently clear a funnel-fetch banner that has nothing to do with
// the run it just kicked off.
describe('FunnelDetail — error banner and result never coexist', () => {
  it('does not render a full result alongside an error banner', async () => {
    // The mutation this pins: gate the result block on `result != null`
    // alone again (drop the `funnelError == null && runError == null`
    // clauses) -- exactly this test fails, because runFunnel still
    // succeeds even though funnel() rejected.
    const client = fakeClient({
      funnel: vi.fn(async () => {
        throw new ApiError(503, 'unavailable')
      }),
    })
    renderDetail(client)
    expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i)
    expect(screen.queryByTestId('funnel-result')).toBeNull()
  })

  it('a Run click does not clear an unrelated funnel-fetch banner', async () => {
    // The mutation this pins: `runNow` clearing the SAME error state the
    // fetch effect writes to (the pre-fix shape) -- exactly this test fails,
    // because a successful Run would then silently erase the fetch banner.
    const client = fakeClient({
      funnel: vi.fn(async () => {
        throw new ApiError(503, 'unavailable')
      }),
    })
    renderDetail(client)
    expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i)
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    await waitFor(() => expect(client.runFunnel).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('alert')).toHaveTextContent(/temporarily unavailable/i)
  })
})

describe('FunnelDetail — delete', () => {
  it('deletes only after a confirmation, then leaves for the list', async () => {
    const client = fakeClient()
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    await userEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(client.deleteFunnel).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: /^delete funnel$/i }))
    await waitFor(() => expect(client.deleteFunnel).toHaveBeenCalledWith(1, 7))
  })

  // Invented mutation: clicking Delete without ever confirming must leave
  // the confirmation dismissible and the funnel untouched -- otherwise the
  // "behind a confirmation" guarantee above is only tested in the direction
  // that proves the happy path, never the one that proves Cancel works.
  it('cancelling the confirmation leaves the funnel in place', async () => {
    const client = fakeClient()
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    await userEvent.click(screen.getByRole('button', { name: /delete/i }))
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByRole('button', { name: /^delete funnel$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
    expect(client.deleteFunnel).not.toHaveBeenCalled()
  })

  it('routes a 401 on delete to onUnauthorized rather than an error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      deleteFunnel: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    renderDetail(client, onUnauthorized)
    await screen.findByTestId('funnel-step-1')
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^delete funnel$/i }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// Controller correction 2 (binding): a funnel referencing a stale/deleted
// segment still answers 200 with real, plausible numbers computed over the
// WHOLE population -- the ONLY signal is a `segment_id` warning. Two
// requirements follow, each with its own test below.
describe('FunnelDetail — broken segment filter', () => {
  it('renders a segment_id warning above the numbers, not as a footnote beneath them', async () => {
    const client = fakeClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, segment_id: 4 })),
      runFunnel: vi.fn(async () => ({
        ...RUN,
        warnings: [
          {
            path: 'segment_id',
            reason:
              'segment 4 no longer exists or cannot be read, so this funnel ran over everyone rather than the population it names',
          },
        ],
      })),
    })
    renderDetail(client)
    const warning = await screen.findByText(/ran over everyone/i)
    const numbers = await screen.findByText(/Entered/)
    // DOCUMENT_POSITION_FOLLOWING (4) means `numbers` comes AFTER `warning`
    // in the DOM -- i.e. the warning is above the numbers it qualifies.
    expect(warning.compareDocumentPosition(numbers) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
  })

  it('does not present the funnel segment filter as applied when the run warns it could not be', async () => {
    const client = fakeClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, segment_id: 4 })),
      runFunnel: vi.fn(async () => ({
        ...RUN,
        warnings: [{ path: 'segment_id', reason: 'segment 4 no longer exists or cannot be read' }],
      })),
    })
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    expect(screen.queryByTestId('funnel-segment-filter')).toBeNull()
    expect(screen.queryByText(/Segment: #4/)).toBeNull()
  })

  it('does present the segment filter as applied when the run has no such warning', async () => {
    const client = fakeClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, segment_id: 4 })),
    })
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    expect(screen.getByTestId('funnel-segment-filter')).toHaveTextContent('#4')
  })
})
