import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { StatsPage, TrendReport, TrendReportInput } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { Trends } from './Trends.js'

/** An arbitrary fixed timestamp -- the exact value never matters to any
 * assertion below, only that every stored report carries one. */
const T = '2026-06-01T00:00:00.000Z'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
  },
]

const PAGE: StatsPage = {
  buckets: [
    { bucket: '2026-06-01T00:00:00.000Z', series: 'pro', events: 5 },
    { bucket: '2026-06-02T00:00:00.000Z', series: 'pro', events: 3 },
    { bucket: '2026-06-01T00:00:00.000Z', series: 'free', events: 2 },
  ],
  folded_series: 0,
}

function harness(over: Partial<ApiClient> = {}, url = '/trends') {
  const client = {
    stats: vi.fn(async () => PAGE),
    schemaEvents: vi.fn(async () => ['checkout', 'signup']),
    schemaProperties: vi.fn(async () => [{ name: 'plan', kind: 'string' as const }]),
    ...over,
  } as unknown as ApiClient
  render(
    <MemoryRouter initialEntries={[url]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Trends client={client} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

const runButton = () => screen.getByRole('button', { name: /^run$/i })
const SPLIT = '/trends?event=checkout&source=property&field=plan'

function reportFixture(over: Partial<TrendReport> = {}): TrendReport {
  return {
    id: 3,
    name: 'Report',
    event: 'signup',
    interval: '1d',
    group_by: null,
    created_at: T,
    updated_at: T,
    ...over,
  }
}

/**
 * Renders `Trends` behind the SAME two routes `Router.tsx` actually
 * declares (`/trends/new`, `/trends/:id`) rather than the component
 * directly -- unlike `harness`, this screen now reads `useParams().id`, so
 * a test that wants that id populated needs a real `<Routes>` match, not
 * just a URL string sitting under a router with nothing to parse it.
 *
 * Defaults every saved-report method to something that resolves rather
 * than throws, matching whatever the URL/body implies where it reasonably
 * can -- a test that does not care about the load or the save should not
 * have to mock either just to keep the screen from showing an error banner
 * it isn't testing for.
 */
function renderAt(url: string, over: Partial<ApiClient> = {}) {
  const client = {
    stats: vi.fn(async () => PAGE),
    schemaEvents: vi.fn(async () => ['checkout', 'signup']),
    schemaProperties: vi.fn(async () => [{ name: 'plan', kind: 'string' as const }]),
    trendReport: vi.fn(async (_projectId: number, id: number) => reportFixture({ id })),
    createTrendReport: vi.fn(async (_projectId: number, body: TrendReportInput) =>
      reportFixture({ id: 99, ...body }),
    ),
    patchTrendReport: vi.fn(
      async (_projectId: number, id: number, body: Partial<TrendReportInput>) =>
        reportFixture({ id, ...body }),
    ),
    // A no-op default, matching the other saved-report methods above --
    // only the delete tests care what this actually does, and every other
    // test in this file should not have to stub it just to avoid an
    // unrelated "not a function" crash if it were ever called by accident.
    deleteTrendReport: vi.fn(async () => undefined),
    ...over,
  } as unknown as ApiClient
  render(
    <MemoryRouter initialEntries={[url]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          {/* A successful delete navigates to the list route (matches
           * `FunnelDetail.test.tsx`'s own harness) -- this placeholder gives
           * that navigation somewhere to land instead of logging "no routes
           * matched". */}
          <Route path="/trends" element={<p>trends list</p>} />
          <Route path="/trends/new" element={<Trends client={client} />} />
          <Route path="/trends/:id" element={<Trends client={client} />} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

async function type(labelRe: RegExp, value: string) {
  const input = screen.getByLabelText(labelRe)
  await userEvent.clear(input)
  await userEvent.type(input, value)
}

async function click(nameRe: RegExp) {
  await userEvent.click(screen.getByRole('button', { name: nameRe }))
}

async function changeRange(id: string) {
  await userEvent.selectOptions(screen.getByRole('combobox', { name: /range/i }), id)
}

function lastCallArg<T = Record<string, unknown>>(fn: unknown, index: number): T {
  return (fn as { mock: { calls: unknown[][] } }).mock.calls[0]?.[index] as T
}

describe('Trends', () => {
  it('does not run on render -- an aggregate is a real scan', async () => {
    const client = harness({}, SPLIT)
    await new Promise((r) => setTimeout(r, 20))
    expect(client.stats).not.toHaveBeenCalled()
  })

  it('sends the breakdown from the URL in the endpoint the server parses', async () => {
    const client = harness({}, SPLIT)
    await userEvent.click(runButton())
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    expect(client.stats).toHaveBeenCalledWith(1, {
      interval: '1d',
      event: 'checkout',
      group_by: 'property:plan',
    })
  })

  it('omits group_by entirely when nothing is split', async () => {
    const client = harness({}, '/trends?event=checkout')
    await userEvent.click(runButton())
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    expect(client.stats).toHaveBeenCalledWith(1, { interval: '1d', event: 'checkout' })
  })

  it('sends no group_by for a half-finished split, and says the split is unfinished', async () => {
    // Sending `property:` would be a 400 the operator did not ask for.
    const client = harness({}, '/trends?event=checkout&source=property')
    expect(screen.getByTestId('trend-incomplete-split')).toBeInTheDocument()
    await userEvent.click(runButton())
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    expect(client.stats).toHaveBeenCalledWith(1, { interval: '1d', event: 'checkout' })
  })

  it('clears the chart when the definition changes', async () => {
    harness({}, SPLIT)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('trend-panels')).toBeInTheDocument())
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /resolution/i }), '1w')
    expect(screen.queryByTestId('trend-panels')).toBeNull()
  })

  it('clears the field when the split source changes', async () => {
    // `utm_source` is a valid column and an unlikely property name; carrying
    // it across would silently ask a different question.
    harness({}, '/trends?event=checkout&source=attribute&field=utm_source')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /split by/i }), 'property')
    expect(screen.queryByDisplayValue('utm_source')).toBeNull()
  })

  it('says how many series were folded, so the panels reconcile with the total', async () => {
    const folded = vi.fn(async () => ({ ...PAGE, folded_series: 340 }))
    harness({ stats: folded } as unknown as Partial<ApiClient>, SPLIT)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('trend-folded')).toBeInTheDocument())
    expect(screen.getByTestId('trend-folded')).toHaveTextContent('340')
  })

  it('says nothing about folding when nothing was folded', async () => {
    harness({}, SPLIT)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('trend-panels')).toBeInTheDocument())
    expect(screen.queryByTestId('trend-folded')).toBeNull()
  })

  it('reports a failure instead of leaving the previous chart on screen', async () => {
    const failing = vi.fn(async () => {
      throw new Error('too many series')
    })
    harness({ stats: failing } as unknown as Partial<ApiClient>, SPLIT)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/too many series/))
    expect(screen.queryByTestId('trend-panels')).toBeNull()
  })

  it('puts no description inside the controls row, so nothing lifts out of alignment', () => {
    // The row is `items-end` so the Run button lines up with the inputs, and
    // that holds only while every column is the same height. A hint paragraph
    // under the Property field made its column taller and pushed the field
    // itself visibly UP -- reported as a glitch on 2026-08-28. Explanations
    // go below the row.
    harness({}, '/trends?event=checkout&source=property&field=plan')
    const row = screen.getByTestId('trend-controls')
    expect(row.querySelectorAll('p')).toHaveLength(0)
  })

  it('still explains what a property is, below the row rather than inside it', () => {
    harness({}, '/trends?event=checkout&source=property&field=plan')
    expect(screen.getByText(/whatever your app put in/i)).toBeInTheDocument()
    expect(screen.getByTestId('trend-controls')).not.toContainElement(
      screen.getByText(/whatever your app put in/i),
    )
  })

  it('sends no bounds on the default range, keeping the server’s tuned window', async () => {
    const client = harness({}, '/trends?event=checkout')
    await userEvent.click(runButton())
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    const q = (client.stats as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as Record<string, unknown>
    expect('since' in q).toBe(false)
    expect('until' in q).toBe(false)
  })

  it('sends bounds once a range is chosen', async () => {
    const client = harness({}, '/trends?event=checkout&range=90d')
    await userEvent.click(runButton())
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    const q = (client.stats as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as Record<string, string>
    expect(new Date(q.until as string).getTime() - new Date(q.since as string).getTime()).toBe(
      90 * 86_400_000,
    )
  })

  it('refuses a span-and-resolution pairing the server would refuse, before sending it', async () => {
    // 30 days at one-minute resolution is 43,200 buckets against a ceiling of
    // 1000. Saying so beats a 400 the operator has to interpret.
    const client = harness({}, '/trends?event=checkout&interval=1m&range=30d')
    expect(screen.getByTestId('trend-too-many-buckets')).toHaveTextContent('43,200')
    expect(runButton()).toBeDisabled()
    expect(client.stats).not.toHaveBeenCalled()
  })

  it('blocks a half-filled custom range instead of pairing a start with no end', async () => {
    harness({}, '/trends?event=checkout&range=custom&from=2026-06-01')
    expect(screen.getByTestId('trend-range-unfinished')).toBeInTheDocument()
    expect(runButton()).toBeDisabled()
  })

  it('clears the chart when the range changes, like every other control', async () => {
    harness({}, '/trends?event=checkout&range=90d')
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('trend-panels')).toBeInTheDocument())
    await userEvent.selectOptions(screen.getByRole('combobox', { name: /range/i }), '30d')
    expect(screen.queryByTestId('trend-panels')).toBeNull()
  })
})

describe('Trends -- saving and reopening a saved report', () => {
  it('warns on LOAD when the stored interval exceeds the ceiling for the opened range', async () => {
    // THE POINT OF THIS TASK. The range is never stored (decision 1), so a
    // trend saved at `1m` can reopen over a range that asks for far more
    // buckets than the ceiling allows -- 30 days at `1m` is 43,200 against
    // a limit of 1000. `range=30d` here stands in for a range already
    // sitting in the URL (a bookmark, a shared link with only the range
    // pinned): the bare default range (`auto`) is engineered server-side
    // to never exceed the cap on its own (`STATS_DEFAULT_WINDOW_MS`), so a
    // bare `/trends/3` could never reproduce the danger decision 5
    // describes -- this is the one combination that actually can.
    const client = renderAt('/trends/3?range=30d', {
      trendReport: vi.fn(async () => reportFixture({ interval: '1m' })),
    })
    expect(await screen.findByTestId('trend-too-many-buckets')).toBeInTheDocument()
    expect(client.stats).not.toHaveBeenCalled()
  })

  it('does not silently widen the stored interval to make the request fit', async () => {
    // Substituting `1h` would show a report the operator did not save.
    // Same setup as the warn-on-load test above -- a `1m` report reopened
    // over a range that overflows at that resolution -- so this is a real
    // over-cap situation, not a vacuous check against a value nothing
    // could have changed.
    renderAt('/trends/3?range=30d', {
      trendReport: vi.fn(async () => reportFixture({ interval: '1m' })),
    })
    await screen.findByTestId('trend-too-many-buckets')
    // Not `getByDisplayValue` -- for a `<select>`, Testing Library matches
    // the SELECTED OPTION'S TEXT ("by minute"), not its `value` ("1m"), so
    // that query would pass against a mislabelled option too. `.value` on
    // the control itself is what the interval actually resolves to.
    expect(screen.getByRole('combobox', { name: /resolution/i })).toHaveValue('1m')
  })

  it('seeds the URL from the stored definition', async () => {
    const client = renderAt('/trends/3', {
      trendReport: vi.fn(async () =>
        reportFixture({ name: 'Signups', interval: '1d', group_by: 'attribute:country' }),
      ),
    })
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    expect(lastCallArg(client.stats, 1)).toMatchObject({
      event: 'signup',
      interval: '1d',
      group_by: 'attribute:country',
    })
  })

  it('does not overwrite parameters already in the URL', async () => {
    // A shared link to a saved report at a particular interval must win
    // over the stored definition, or the link does not mean what it says.
    const client = renderAt('/trends/3?interval=1h&range=7d', {
      trendReport: vi.fn(async () => reportFixture({ interval: '1m' })),
    })
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    expect(lastCallArg(client.stats, 1)).toMatchObject({ interval: '1h' })
  })

  it('changing the range does not modify the saved report', async () => {
    const client = renderAt('/trends/3')
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    await changeRange('30d')
    expect(client.patchTrendReport).not.toHaveBeenCalled()
  })

  it('updates the saved report on PATCH, with the same range-free body create sends', async () => {
    // The Important finding from review: `patchTrendReport` previously
    // appeared in this suite only inside a `.not.toHaveBeenCalled()`
    // assertion, so its own call site -- as opposed to the `reportBody()`
    // it shares with create -- was never actually observed. A mutation at
    // the PATCH call site alone (a leaked `range`, or the
    // `reportId != null` branch dropped or inverted) would have survived
    // the suite. This asserts the full key set the way the create test
    // does, so a leaked `range` (or a renamed `since`/`until` evasion of
    // it) fails rather than passing unnoticed.
    const client = renderAt('/trends/3')
    await waitFor(() => expect(client.stats).toHaveBeenCalled())
    await type(/name/i, 'Renamed')
    await click(/save/i)
    await waitFor(() => expect(client.patchTrendReport).toHaveBeenCalled())
    expect(client.patchTrendReport).toHaveBeenCalledWith(1, 3, {
      name: 'Renamed',
      event: 'signup',
      interval: '1d',
      group_by: null,
    })
  })

  it('saves a new report from an unsaved screen', async () => {
    const client = renderAt('/trends/new?event=signup&interval=1d')
    await type(/name/i, 'Signups by day')
    await click(/save/i)
    await waitFor(() => expect(client.createTrendReport).toHaveBeenCalled())
    expect(client.createTrendReport).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ name: 'Signups by day', event: 'signup', interval: '1d' }),
    )
  })

  // I2 from the whole-branch review: `/trends/new` -> `/trends/:id` on
  // CREATE is a full remount (`Router.tsx` gives the two routes different
  // `key`s), and the remount's load effect used to auto-run again -- the
  // exact chart already on screen, re-fetched for nothing. Asserting on the
  // CALL COUNT is the point: a version that merely waits for `stats` to
  // have been called at all would pass whether it ran once or twice.
  it('does not re-run the query a moment after Save -- the results are already on screen', async () => {
    const client = renderAt('/trends/new?event=signup&interval=1d')
    await click(/^run$/i)
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(1))
    await type(/name/i, 'Signups by day')
    await click(/save/i)
    await waitFor(() => expect(client.createTrendReport).toHaveBeenCalled())
    // Give the remount's own load effect a tick to do whatever it is going
    // to do before reading the call count -- it fetches the report's
    // metadata either way, so that fetch having resolved is the signal the
    // effect has run its course.
    await waitFor(() => expect(client.trendReport).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.stats).toHaveBeenCalledTimes(1)
  })

  it('never includes the range in a saved report’s body', async () => {
    // Mutation table: sending the range would be the first step toward
    // storing it despite decision 1 -- so this asserts the body's whole
    // key set, not just that a `range` key is absent (a mutation could add
    // it under `since`/`until` instead and slip past a narrower check).
    const client = renderAt('/trends/new?event=signup&interval=1d&range=30d')
    await type(/name/i, 'Signups by day')
    await click(/save/i)
    await waitFor(() => expect(client.createTrendReport).toHaveBeenCalled())
    const body = lastCallArg(client.createTrendReport, 1)
    expect(Object.keys(body).sort()).toEqual(['event', 'group_by', 'interval', 'name'])
  })

  it('reports a duplicate name without losing what was typed', async () => {
    renderAt('/trends/new?event=signup&interval=1d', {
      createTrendReport: vi.fn(async () => {
        throw new ApiError(409, 'name_taken')
      }),
    })
    await type(/name/i, 'Taken')
    await click(/save/i)
    expect(await screen.findByText(/already/i)).toBeInTheDocument()
    expect(screen.getByDisplayValue('Taken')).toBeInTheDocument()
  })
})

// A same-route navigation trigger for the id-change guard test below --
// clicking it changes the `:id` param WITHOUT unmounting `Trends` (same
// position in the same `<Route>`, matching `FunnelDetail.test.tsx`'s own
// `Nav`), which is what lets a confirmation opened for one report still be
// standing when a different report's id lands in the URL.
function Nav(props: { to: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(props.to)}>
      go
    </button>
  )
}

function renderWithNav(fromId: number, toId: number, over: Partial<ApiClient> = {}) {
  const client = {
    stats: vi.fn(async () => PAGE),
    schemaEvents: vi.fn(async () => ['checkout', 'signup']),
    schemaProperties: vi.fn(async () => [{ name: 'plan', kind: 'string' as const }]),
    trendReport: vi.fn(async (_projectId: number, id: number) =>
      reportFixture({ id, name: `Report ${id}` }),
    ),
    deleteTrendReport: vi.fn(async () => undefined),
    ...over,
  } as unknown as ApiClient
  render(
    <MemoryRouter initialEntries={[`/trends/${fromId}`]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route
            path="/trends/:id"
            element={
              <>
                <Trends client={client} />
                <Nav to={`/trends/${toId}`} />
              </>
            }
          />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

describe('Trends -- delete', () => {
  it('offers no Delete button on an unsaved report', async () => {
    harness({}, '/trends?event=checkout')
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull()
  })

  it('offers Delete only once the saved report has loaded', async () => {
    renderAt('/trends/3')
    expect(await screen.findByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })

  it('asks for confirmation first -- deleteTrendReport is not called before it', async () => {
    const client = renderAt('/trends/3')
    await screen.findByRole('button', { name: /^delete$/i })
    await click(/^delete$/i)
    expect(screen.getByText(/delete this trend\?/i)).toBeInTheDocument()
    expect(client.deleteTrendReport).not.toHaveBeenCalled()
  })

  it('cancelling the confirmation leaves the report in place', async () => {
    const client = renderAt('/trends/3')
    await screen.findByRole('button', { name: /^delete$/i })
    await click(/^delete$/i)
    await click(/^cancel$/i)
    expect(screen.queryByText(/delete this trend\?/i)).toBeNull()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
    expect(client.deleteTrendReport).not.toHaveBeenCalled()
  })

  it('confirming calls deleteTrendReport with the project and report id, then leaves for the list', async () => {
    const client = renderAt('/trends/3')
    await screen.findByRole('button', { name: /^delete$/i })
    await click(/^delete$/i)
    await click(/^delete trend$/i)
    await waitFor(() => expect(client.deleteTrendReport).toHaveBeenCalledWith(1, 3))
    expect(await screen.findByText('trends list')).toBeInTheDocument()
  })

  it('a failed delete shows its own error and leaves the rest of the screen intact', async () => {
    const client = renderAt('/trends/3', {
      deleteTrendReport: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await screen.findByRole('button', { name: /^delete$/i })
    // Something already true on screen, independent of the delete outcome --
    // this is what must still be there once the delete fails.
    expect(await screen.findByDisplayValue('Report')).toBeInTheDocument()
    await click(/^delete$/i)
    await click(/^delete trend$/i)
    expect(await screen.findByText(/could not delete this trend/i)).toBeInTheDocument()
    expect(screen.queryByText('trends list')).toBeNull()
    expect(screen.getByDisplayValue('Report')).toBeInTheDocument()
  })

  it('routes a 401 on delete to onUnauthorized rather than an error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = {
      stats: vi.fn(async () => PAGE),
      schemaEvents: vi.fn(async () => ['checkout', 'signup']),
      schemaProperties: vi.fn(async () => [{ name: 'plan', kind: 'string' as const }]),
      trendReport: vi.fn(async (_projectId: number, id: number) => reportFixture({ id })),
      deleteTrendReport: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    } as unknown as ApiClient
    render(
      <MemoryRouter initialEntries={['/trends/3']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path="/trends/:id"
              element={<Trends client={client} onUnauthorized={onUnauthorized} />}
            />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: /^delete$/i })
    await click(/^delete$/i)
    await click(/^delete trend$/i)
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // The trap the brief calls out by name: a confirmation opened for one
  // saved report must not survive a same-route navigation to a different
  // one, or the second click -- the one this screen treats as explicit
  // consent -- deletes whichever report is now in the URL.
  it('a delete confirmation opened for one saved report does not survive navigating to another', async () => {
    const client = renderWithNav(3, 8)
    await waitFor(() => expect(screen.getByDisplayValue('Report 3')).toBeInTheDocument())
    await click(/^delete$/i)
    expect(screen.getByText(/delete this trend\?/i)).toBeInTheDocument()

    await click(/^go$/i)
    await waitFor(() => expect(screen.getByDisplayValue('Report 8')).toBeInTheDocument())
    expect(screen.queryByText(/delete this trend\?/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^delete trend$/i })).toBeNull()
    expect(client.deleteTrendReport).not.toHaveBeenCalled()
  })
})
