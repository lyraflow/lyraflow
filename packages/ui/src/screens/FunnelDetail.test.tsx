import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Funnel, FunnelRunResult, Segment } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { ROUTES, funnelPath } from '../app/Router.js'
import { FunnelDetail } from './FunnelDetail.js'

const PROJECT_1 = {
  id: 1,
  name: 'Alpha',
  slug: 'alpha',
  created_at: '',
  retention_months: 24,
  monthly_event_quota: null,
  disabled_at: null,
  deleting_at: null,
}

const PROJECTS = [PROJECT_1]

const PROJECT_2 = {
  id: 2,
  name: 'Beta',
  slug: 'beta',
  created_at: '',
  retention_months: 24,
  monthly_event_quota: null,
  disabled_at: null,
  deleting_at: null,
}

// A same-route navigation trigger for the race tests below -- clicking it
// changes the `:id` param WITHOUT unmounting `FunnelDetail` (same position
// in the same `<Route>`), which is what lets a request issued for the OLD
// id still be in flight when the mount effect for the NEW id fires.
function Nav(props: { to: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(props.to)}>
      go
    </button>
  )
}

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
  last_range: null,
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

// The fields these segment-picker tests don't care about, so a literal
// resolved through a typed `deferred<Segment[]>()` doesn't have to restate
// them at every call site.
const SEGMENT_DEFAULTS = {
  ast_version: 1,
  filter: null,
  last_count: null,
  last_evaluated_at: null,
  last_range: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    funnel: vi.fn(async () => FUNNEL),
    runFunnel: vi.fn(async () => RUN),
    deleteFunnel: vi.fn(async () => undefined),
    // Issue #94's default: no test that doesn't override this exercises a
    // segment lookup for real (every fixture funnel but the segment-filter
    // ones below has `segment_id: null`, so state 1 never calls it at all).
    segments: vi.fn(async () => []),
    ...over,
  } as unknown as ApiClient & {
    funnel: Mock
    runFunnel: Mock
    deleteFunnel: Mock
    segments: Mock
  }
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

describe('FunnelDetail — a narrowed step says so', () => {
  it('hands the stored definition to the chart, so each step shows its OWN predicates', async () => {
    // Two narrowed steps, two predicates each, four operators. Without the
    // definition reaching `StepBars` these two steps render as bare event
    // names and are indistinguishable from any other funnel over the same
    // pair -- which is the whole complaint.
    const funnel: Funnel = {
      ...FUNNEL,
      steps: [
        {
          event: 'page_view',
          where: [
            { property: 'page', operator: '=', value: 'changelog' },
            { property: 'duration_ms', operator: '>=', value: 30 },
          ],
        },
        {
          event: 'signup_completed',
          where: [
            { property: 'plan', operator: '!=', value: 'free' },
            { property: 'seats', operator: '<=', value: 10 },
          ],
        },
      ],
    }
    renderDetail(fakeClient({ funnel: vi.fn(async () => funnel) }))
    expect(await screen.findByTestId('funnel-step-1-where')).toHaveTextContent(
      'where page is changelog, duration_ms at least 30',
    )
    expect(screen.getByTestId('funnel-step-2-where')).toHaveTextContent(
      'where plan is not free, seats at most 10',
    )
  })

  it('shows no clause for a funnel whose steps carry none', async () => {
    renderDetail(fakeClient())
    await screen.findByTestId('funnel-step-1')
    expect(screen.queryByTestId('funnel-step-1-where')).toBeNull()
  })
})

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
  // numbers. The mutation this pins: drop the identity guard in `runNow`'s
  // `.then`, and this test alone fails (data-stale flips to "false" for a
  // response that does not answer the selected range).
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

    // The 30-day response lands now, after the selection moved to 90, and
    // carries a DIFFERENT `entered` count from the mount's 7-day result --
    // if it were applied at all, the rendered number would change even if
    // some other code path kept `data-stale` "true". Wrapped in act() and
    // given a real turn of the microtask queue so the state update the fix
    // DOESN'T make (and the bug WOULD make) has every chance to land before
    // the assertions below run.
    await act(async () => {
      inFlight.resolve({
        ...RUN,
        entered: 777,
        converted: 111,
        range: { since: '2026-07-16T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' },
      })
      await Promise.resolve()
      await Promise.resolve()
    })

    // Must still read stale: the 30-day answer is not an answer to the
    // 90-day range currently selected.
    expect(screen.getByTestId('funnel-result')).toHaveAttribute('data-stale', 'true')
    // I2 (targeted re-review): discarded OUTRIGHT, not merely left dimmed --
    // the mutation `if (stale) { setResult(r); return }` passes the
    // assertion above unchanged (dimming is a red herring) but applies the
    // discarded response's numbers underneath it. The mount's original
    // 1,204 must still be on screen; the discarded response's 777 must not.
    expect(screen.getByText(/Entered 1,204/)).toBeInTheDocument()
    expect(screen.queryByText(/Entered 777/)).toBeNull()
  })

  // Stub-check gap (targeted re-review): every OTHER fixture in this file
  // resolves a 7-day range, which is also `formatRangeDays`' hardcoded
  // fallback would print if it ignored its argument entirely and just
  // returned the constant string "Last 7 days" -- format.test.ts is the
  // only place that would have caught it. This is the one assertion in
  // THIS file a constant-returning stub cannot satisfy.
  it('labels a range other than the mount default correctly (stub-check gap)', async () => {
    const client = fakeClient({
      runFunnel: vi.fn(async () => ({
        ...RUN,
        range: { since: '2026-07-16T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' },
      })),
    })
    renderDetail(client)
    expect(await screen.findByTestId('funnel-range-label')).toHaveTextContent('Last 30 days')
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

// C1 fix round 2 (targeted re-review): the original guard compared the
// RANGE a response was issued for -- a same-range double-run (a project
// switch that lands back on the default 7-day range being the concrete
// case) was indistinguishable to it. These pin the invariant by IDENTITY
// for every way a second request can be issued: project switch, `:id`
// change, and the mount effect racing a still-open manual Run.
describe('FunnelDetail — response identity survives every way a second request can be issued', () => {
  function renderWithProjects(client: ApiClient, initialId: number) {
    return render(
      <MemoryRouter initialEntries={[funnelPath(FUNNEL.id)]}>
        <ProjectProvider projects={[PROJECT_1, PROJECT_2]} initialId={initialId}>
          <Routes>
            <Route path="/funnels/:id" element={<FunnelDetail client={client} />} />
            <Route path={ROUTES.funnels} element={<p>deleted</p>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
  }

  // The mutation this pins: compare `runDays` (or any range value) instead
  // of request identity -- both requests below share the SAME default
  // range, which a range-equality guard cannot tell apart, so this test
  // alone fails against it (the older project's numbers overwrite the
  // newer project's, undimmed, under the newer project's heading).
  it('discards an older response when the active project changes mid-flight, even though the range never changed', async () => {
    const p1 = deferred<FunnelRunResult>()
    const p2 = deferred<FunnelRunResult>()
    const runFunnel = vi.fn((projectId: number) => (projectId === 1 ? p1.promise : p2.promise))
    const client = fakeClient({ runFunnel })
    const { rerender } = renderWithProjects(client, 1)
    await waitFor(() => expect(runFunnel).toHaveBeenCalledTimes(1))

    rerender(
      <MemoryRouter initialEntries={[funnelPath(FUNNEL.id)]}>
        <ProjectProvider projects={[PROJECT_1, PROJECT_2]} initialId={2}>
          <Routes>
            <Route path="/funnels/:id" element={<FunnelDetail client={client} />} />
            <Route path={ROUTES.funnels} element={<p>deleted</p>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(runFunnel).toHaveBeenCalledTimes(2))

    // Landing order does not track issue order -- resolve the NEWER request
    // (project 2) first, then the OLDER one (project 1) afterwards.
    await act(async () => {
      p2.resolve({ ...RUN, entered: 2222, converted: 900 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(await screen.findByText(/Entered 2,222/)).toBeInTheDocument()

    await act(async () => {
      p1.resolve({ ...RUN, entered: 1111, converted: 400 })
      await Promise.resolve()
      await Promise.resolve()
    })
    // The older, project-1 response must never have applied -- undimmed or
    // otherwise.
    expect(screen.getByText(/Entered 2,222/)).toBeInTheDocument()
    expect(screen.queryByText(/Entered 1,111/)).toBeNull()
  })

  // The other half of the same invariant: a manual Run for one funnel is
  // still open when navigation (the `:id` param) moves to a different
  // funnel entirely, which fires the mount effect's OWN `runNow` call for
  // the new funnel -- the exact "mount effect races a manual Run" shape.
  it('discards a manual run in flight for one funnel once navigating supersedes it with the mount effect for another', async () => {
    const manualRun = deferred<FunnelRunResult>()
    const newerMountRun = deferred<FunnelRunResult>()
    const runFunnel = vi
      .fn()
      .mockResolvedValueOnce(RUN) // mount auto-run for funnel 7
      .mockReturnValueOnce(manualRun.promise) // manual Run click for funnel 7, held open
      .mockReturnValueOnce(newerMountRun.promise) // mount auto-run for funnel 9, held open
    const client = fakeClient({
      funnel: vi.fn(async (_projectId: number, id: number) => ({ ...FUNNEL, id })),
      runFunnel,
    })
    render(
      <MemoryRouter initialEntries={[funnelPath(7)]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path="/funnels/:id"
              element={
                <>
                  <FunnelDetail client={client} />
                  <Nav to="/funnels/9" />
                </>
              }
            />
            <Route path={ROUTES.funnels} element={<p>deleted</p>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByTestId('funnel-step-1')
    expect(runFunnel).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    expect(runFunnel).toHaveBeenCalledTimes(2)

    await userEvent.click(screen.getByText('go'))
    await waitFor(() => expect(runFunnel).toHaveBeenCalledTimes(3))

    // The new funnel's own mount run (the latest request) lands -- it must apply.
    await act(async () => {
      newerMountRun.resolve({ ...RUN, entered: 3333, converted: 1200 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(await screen.findByText(/Entered 3,333/)).toBeInTheDocument()

    // The stale manual run for the funnel navigated away from lands late --
    // discarded outright: no result change, and Run stays usable.
    await act(async () => {
      manualRun.resolve({ ...RUN, entered: 9999, converted: 1 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText(/Entered 3,333/)).toBeInTheDocument()
    expect(screen.queryByText(/Entered 9,999/)).toBeNull()
    expect(screen.getByRole('button', { name: /^run$/i })).toBeEnabled()
  })

  // I2 (targeted re-review): pins the CATCH branch's own identity guard
  // (FunnelDetail.tsx's error-branch staleness guard) in isolation from the
  // success-branch test above -- nothing in the suite exercised an OLDER
  // request failing after a NEWER one had already landed. The mutation this
  // pins: drop the identity check in `runNow`'s `.catch`, and this test
  // alone fails (an error banner appears, and the current good result is
  // marked stale, for a funnel the operator already navigated away from).
  it('discards an older run error after a newer request has already landed', async () => {
    const manualRun = deferred<FunnelRunResult>()
    const newerMountRun = deferred<FunnelRunResult>()
    const runFunnel = vi
      .fn()
      .mockResolvedValueOnce(RUN) // mount auto-run for funnel 7
      .mockReturnValueOnce(manualRun.promise) // manual Run for funnel 7, held open, will FAIL late
      .mockReturnValueOnce(newerMountRun.promise) // mount auto-run for funnel 9, held open
    const client = fakeClient({
      funnel: vi.fn(async (_projectId: number, id: number) => ({ ...FUNNEL, id })),
      runFunnel,
    })
    render(
      <MemoryRouter initialEntries={[funnelPath(7)]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path="/funnels/:id"
              element={
                <>
                  <FunnelDetail client={client} />
                  <Nav to="/funnels/9" />
                </>
              }
            />
            <Route path={ROUTES.funnels} element={<p>deleted</p>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByTestId('funnel-step-1')
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    await userEvent.click(screen.getByText('go'))
    await waitFor(() => expect(runFunnel).toHaveBeenCalledTimes(3))

    await act(async () => {
      newerMountRun.resolve({ ...RUN, entered: 3333, converted: 1200 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(await screen.findByText(/Entered 3,333/)).toBeInTheDocument()

    await act(async () => {
      manualRun.reject(new ApiError(422, 'segment query timed out'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('funnel-result')).toHaveAttribute('data-stale', 'false')
    expect(screen.getByText(/Entered 3,333/)).toBeInTheDocument()
  })

  // Pins `runNow`'s `.finally` guard in isolation: the two tests above
  // always resolve the NEWER call first, so `running` would already read
  // false by the time the older call's own `.finally` runs even WITHOUT
  // this guard. Here the OLDER call settles FIRST, while the newer one the
  // operator is actually waiting on is still open. The mutation this pins:
  // drop the `requestId !== requestIdRef.current` check in `.finally`, and
  // this test alone fails -- Run re-enables early, while a request is still
  // outstanding.
  it('does not re-enable Run when an older call settles before a still-open newer call', async () => {
    const manualRun = deferred<FunnelRunResult>()
    const newerMountRun = deferred<FunnelRunResult>()
    const runFunnel = vi
      .fn()
      .mockResolvedValueOnce(RUN) // mount auto-run for funnel 7
      .mockReturnValueOnce(manualRun.promise) // manual Run for funnel 7, held open
      .mockReturnValueOnce(newerMountRun.promise) // mount auto-run for funnel 9, held open
    const client = fakeClient({
      funnel: vi.fn(async (_projectId: number, id: number) => ({ ...FUNNEL, id })),
      runFunnel,
    })
    render(
      <MemoryRouter initialEntries={[funnelPath(7)]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path="/funnels/:id"
              element={
                <>
                  <FunnelDetail client={client} />
                  <Nav to="/funnels/9" />
                </>
              }
            />
            <Route path={ROUTES.funnels} element={<p>deleted</p>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByTestId('funnel-step-1')
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled()

    await userEvent.click(screen.getByText('go'))
    await waitFor(() => expect(runFunnel).toHaveBeenCalledTimes(3))
    expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled()

    // The OLDER call (the manual run for the funnel navigated away from)
    // settles first.
    await act(async () => {
      manualRun.resolve({ ...RUN, entered: 9999 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled()

    // Only now, once the newer call ALSO settles, may Run re-enable.
    await act(async () => {
      newerMountRun.resolve({ ...RUN, entered: 3333 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: /^run$/i })).toBeEnabled()
  })
})

// Ruling (targeted re-review): the previous wave gated the result block on
// `runError == null` too, which went wider than the finding it was meant to
// fix -- a transient failed Run (e.g. a 422 "narrow the range") wiped
// previously-good numbers off the screen entirely. A failed Run keeps the
// last good result on screen, dimmed, beside the error banner; a failed
// FUNNEL fetch (the actual finding) still suppresses the result, since
// there is no funnel to show numbers for.
describe('FunnelDetail — a failed Run keeps the previous good result on screen', () => {
  it('dims the last good result beside the error banner rather than wiping it', async () => {
    const runFunnel = vi
      .fn()
      .mockResolvedValueOnce(RUN) // mount auto-run succeeds
      .mockRejectedValueOnce(new ApiError(422, 'segment query timed out')) // manual Run fails
    const client = fakeClient({ runFunnel })
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    expect(screen.getByTestId('funnel-result')).toHaveAttribute('data-stale', 'false')

    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/narrow the range/i)

    // The mutation this pins: gating the result block on `runError == null`
    // again -- exactly these assertions fail, because the last-good numbers
    // would disappear the moment the failed Run set `runError`.
    const box = screen.getByTestId('funnel-result')
    expect(box).toBeInTheDocument()
    expect(box).toHaveAttribute('data-stale', 'true')
    expect(screen.getByText(/Entered 1,204/)).toBeInTheDocument()
  })

  it('still suppresses the result when the funnel itself cannot be read (the actual finding)', async () => {
    // Unlike a run error, a funnel-fetch failure means there is no funnel to
    // show numbers for at all -- this must still suppress the result block.
    const client = fakeClient({
      funnel: vi.fn(async () => {
        throw new ApiError(404, 'funnel_not_found')
      }),
    })
    renderDetail(client)
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/i)
    expect(screen.queryByTestId('funnel-result')).toBeNull()
  })
})

// MINOR (whole-branch review): decision 8 gives a 404 (deleted elsewhere)
// the remedy "offer the list" -- a bare error banner left an operator with a
// message and no way to act on it.
describe('FunnelDetail — a server 404 offers a way back to the list', () => {
  it('shows a link back to the list when the funnel fetch 404s', async () => {
    const client = fakeClient({
      funnel: vi.fn(async () => {
        throw new ApiError(404, 'funnel_not_found')
      }),
    })
    renderDetail(client)
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer exists/i)
    expect(screen.getByRole('link', { name: /back to funnels/i })).toBeInTheDocument()
  })

  it('does not offer a list link for a non-404 fetch failure', async () => {
    const client = fakeClient({
      funnel: vi.fn(async () => {
        throw new ApiError(503, 'unavailable')
      }),
    })
    renderDetail(client)
    expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i)
    expect(screen.queryByRole('link', { name: /back to funnels/i })).toBeNull()
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

  // State 4 (issue #94 brief), pinned so it survives resolution being added:
  // `segments` resolves a REAL match for id 4 here, deliberately -- if the
  // `!brokenSegment` suppression were ever "simplified away", the subtitle
  // would render "Segment: Paying customers (#4)" instead of nothing, which
  // is the exact contradiction (a named filter above numbers that in fact
  // ran over everyone) this state exists to prevent. A test that left
  // `segments` empty could pass this assertion by accident, off an
  // unresolved-id rendering, without the suppression doing any work at all.
  it('does not present the funnel segment filter as applied when the run warns it could not be', async () => {
    const client = fakeClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, segment_id: 4 })),
      segments: vi.fn(async () => [{ id: 4, name: 'Paying customers', stale: false }]),
      runFunnel: vi.fn(async () => ({
        ...RUN,
        warnings: [{ path: 'segment_id', reason: 'segment 4 no longer exists or cannot be read' }],
      })),
    })
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    expect(screen.queryByTestId('funnel-segment-filter')).toBeNull()
    expect(screen.queryByText(/Segment/)).toBeNull()
    expect(screen.queryByText(/Paying customers/)).toBeNull()
  })
})

// Issue #94: `GET /v1/funnels/:id` returns `segment_id` with no name, so the
// screen resolves it itself via `client.segments(projectId)`. Each of the
// four states the brief names gets its own test, plus the lookup failing
// outright and a 401 on that lookup specifically.
describe('FunnelDetail — segment name resolution (issue #94)', () => {
  // State 1: no filter at all. The mutation this pins: fetch segments
  // unconditionally on every funnel view -- this is the one assertion that
  // would catch a `client.segments` call for a funnel that never named one.
  it('does not fetch segments at all when the funnel has no filter', async () => {
    const client = fakeClient() // FUNNEL.segment_id is null
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    expect(screen.queryByTestId('funnel-segment-filter')).toBeNull()
    expect(client.segments).not.toHaveBeenCalled()
  })

  // State 2: the filter resolves. The mutation this pins: render only the
  // bare id (the pre-fix behaviour) -- this fails unless the name itself is
  // on screen.
  //
  // Flake fix (issue #109): `findByTestId` alone only waits for the NODE to
  // exist, not for its content -- and this node exists a render earlier than
  // the resolved name does. It mounts as soon as `funnel` and `result` are
  // both set (the fallback bare-id text, since `segments` hasn't loaded
  // yet), and only gets the resolved name on a LATER commit once the
  // `segments` effect -- which only fires after the `funnel` commit, so it
  // is strictly behind the other two fetches -- settles. Under load,
  // `findByTestId` could resolve on that first, bare-id commit, and the
  // assertion right after it ran against stale text (confirmed live: a
  // failure read "Received: Segment: #4" against the intended
  // "Paying customers (#4)"). `waitFor` here re-runs the assertion itself
  // until the FINAL text lands, rather than trusting that the node's first
  // appearance already carries it -- still proving both the name and the id
  // render, nothing weaker.
  it('renders the segment name, with the id alongside it, once resolved', async () => {
    const client = fakeClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, segment_id: 4 })),
      segments: vi.fn(async () => [{ id: 4, name: 'Paying customers', stale: false }]),
    })
    renderDetail(client)
    await waitFor(() =>
      expect(screen.getByTestId('funnel-segment-filter')).toHaveTextContent(
        'Paying customers (#4)',
      ),
    )
    expect(client.segments).toHaveBeenCalledWith(1)
  })

  // State 3: `segment_id` deliberately carries no foreign key, so a deleted
  // segment leaves a dangling id -- this is a designed state, not an edge
  // case. The mutation this pins: fall back to the bare id (or blank) for an
  // unresolved id exactly the way a failed lookup does -- this fails unless
  // the "cannot be resolved" wording is on screen, distinct from both the
  // resolved-name text and a bare id.
  // Flake fix (issue #109): the same shape as the test above -- the "cannot
  // be resolved" wording only appears once `segments` resolves, but the node
  // exists a render earlier showing the bare-id fallback, which also
  // contains "#4" and does not yet contain "cannot be resolved". A
  // `findByTestId` that stops at the node's first appearance could catch
  // that earlier commit under load and fail the `/cannot be resolved/i`
  // assertion against text that just hadn't arrived yet. `waitFor` re-runs
  // both assertions together until they hold.
  it('renders an honest "cannot be resolved" state when the id is not in the list', async () => {
    const client = fakeClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, segment_id: 4 })),
      segments: vi.fn(async () => [{ id: 9, name: 'Trial users', stale: false }]),
    })
    renderDetail(client)
    await waitFor(() => {
      const el = screen.getByTestId('funnel-segment-filter')
      expect(el).toHaveTextContent('#4')
      expect(el).toHaveTextContent(/cannot be resolved/i)
    })
    expect(screen.getByTestId('funnel-segment-filter')).not.toHaveTextContent('Trial users')
  })

  // The segments fetch failing outright (not a 401): must not blank the
  // subtitle or break the rest of the page -- falls back to the id. The
  // mutation this pins: let the rejection propagate unhandled (or render
  // nothing) -- this fails either by the page crashing before
  // `funnel-step-1` appears, or by the subtitle being absent.
  it('falls back to the bare id when the segments fetch fails outright', async () => {
    const client = fakeClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, segment_id: 4 })),
      segments: vi.fn(async () => {
        throw new ApiError(503, 'unavailable')
      }),
    })
    renderDetail(client)
    await screen.findByTestId('funnel-step-1')
    const el = await screen.findByTestId('funnel-segment-filter')
    expect(el).toHaveTextContent('#4')
    expect(el).not.toHaveTextContent(/cannot be resolved/i)
  })

  // A 401 on the segments lookup specifically routes to `onUnauthorized`,
  // the same as every other fetch on this screen -- not a banner, and not a
  // silent blank. The mutation this pins: swallow a 401 from `segments` into
  // the generic failure branch instead of routing it -- `onUnauthorized`
  // would never fire.
  it('routes a 401 from the segments lookup to onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, segment_id: 4 })),
      segments: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    renderDetail(client, onUnauthorized)
    await screen.findByTestId('funnel-step-1')
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    // The rest of the page must not break just because this one lookup 401ed.
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/Entered 1,204/)).toBeInTheDocument()
  })
})

// Fix round 1 review (issue #94): the funnel/run effects already have a
// dedicated race block ("response identity survives every way a second
// request can be issued") because a response landing after the question on
// screen changed once shipped wrong-range numbers under a confident label.
// The segments fetch is the same class of race and was, until this test,
// protected only by the `cancelled` closure flag in FunnelDetail's segments
// effect -- real, but unpinned: a refactor (an AbortController, a reworked
// dependency array) could remove it silently with the whole suite green.
describe('FunnelDetail — segments response identity survives a project switch mid-flight', () => {
  function renderWithProjects(client: ApiClient, initialId: number) {
    return render(
      <MemoryRouter initialEntries={[funnelPath(FUNNEL.id)]}>
        <ProjectProvider projects={[PROJECT_1, PROJECT_2]} initialId={initialId}>
          <Routes>
            <Route path="/funnels/:id" element={<FunnelDetail client={client} />} />
            <Route path={ROUTES.funnels} element={<p>deleted</p>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
  }

  // Both projects' segment lists deliberately share the SAME id (4) under a
  // DIFFERENT name -- this is what makes the test fail if the stale
  // response is applied to the wrong project, rather than merely if nothing
  // renders. A guard that only suppressed rendering on error, without
  // actually discarding the stale response, would still pass a test built
  // on non-overlapping ids.
  //
  // The mutation this pins: remove the `if (cancelled) return` checks in
  // FunnelDetail's segments effect -- this test alone fails (project 1's
  // name renders after the switch to project 2).
  it('discards a segments response for the project switched away from, even though it names the same id', async () => {
    const segP1 = deferred<Segment[]>()
    const segP2 = deferred<Segment[]>()
    const segments = vi.fn((projectId: number) => (projectId === 1 ? segP1.promise : segP2.promise))
    const client = fakeClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, segment_id: 4 })),
      segments,
    })
    const { rerender } = renderWithProjects(client, 1)
    await screen.findByTestId('funnel-step-1')
    await waitFor(() => expect(segments).toHaveBeenCalledWith(1))

    // Switching the active project re-renders the same route (no unmount)
    // -- the exact shape that makes a stale-response race possible, the
    // same pattern the funnel/run race block above applies to `runFunnel`.
    rerender(
      <MemoryRouter initialEntries={[funnelPath(FUNNEL.id)]}>
        <ProjectProvider projects={[PROJECT_1, PROJECT_2]} initialId={2}>
          <Routes>
            <Route path="/funnels/:id" element={<FunnelDetail client={client} />} />
            <Route path={ROUTES.funnels} element={<p>deleted</p>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(segments).toHaveBeenCalledWith(2))

    // Project 1's stale response lands now, AFTER the switch to project 2.
    await act(async () => {
      segP1.resolve([{ ...SEGMENT_DEFAULTS, id: 4, name: 'Alpha Paying customers', stale: false }])
      await Promise.resolve()
      await Promise.resolve()
    })
    // Must not show project 1's name -- project 2's own lookup hasn't
    // resolved yet, so this falls back to the bare id.
    expect(screen.getByTestId('funnel-segment-filter')).toHaveTextContent('#4')
    expect(screen.queryByText(/Alpha Paying customers/)).toBeNull()

    // Now project 2's own response lands.
    await act(async () => {
      segP2.resolve([{ ...SEGMENT_DEFAULTS, id: 4, name: 'Beta Paying customers', stale: false }])
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('funnel-segment-filter')).toHaveTextContent(
      'Beta Paying customers (#4)',
    )
    // The stale project-1 response must never have applied, even after
    // project 2's own resolves -- not before, not after.
    expect(screen.queryByText(/Alpha Paying customers/)).toBeNull()
  })
})
