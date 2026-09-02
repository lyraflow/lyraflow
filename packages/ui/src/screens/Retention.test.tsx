import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { RetentionReport, RetentionReportInput, RetentionResult } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { Retention } from './Retention.js'

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

const RESULT: RetentionResult = {
  granularity: 'week',
  periods: 3,
  cohorts: [{ cohort: '2026-06-01', size: 4, retained: [4, 2, 1, null] }],
  start_event: 'signed_up',
  return_event: 'project_created',
  since: '2026-06-01T00:00:00.000Z',
  until: '2026-06-15T00:00:00.000Z',
  computed_at: '2026-06-20T00:00:00.000Z',
  warnings: [],
}

function harness(over: Partial<ApiClient> = {}, url = '/retention') {
  const client = {
    runRetention: vi.fn(async () => RESULT),
    schemaEvents: vi.fn(async () => ['signed_up', 'project_created']),
    ...over,
  } as unknown as ApiClient
  render(
    <MemoryRouter initialEntries={[url]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Retention client={client} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

const READY = '/retention?start=signed_up&return=project_created'
const runButton = () => screen.getByRole('button', { name: /^run$/i })

function reportFixture(over: Partial<RetentionReport> = {}): RetentionReport {
  return {
    id: 3,
    name: 'Report',
    definition_version: 1,
    start_event: 'signed_up',
    return_event: 'project_created',
    start_where: [],
    return_where: [],
    granularity: 'week',
    periods: 8,
    segment_id: null,
    stale: false,
    created_at: T,
    updated_at: T,
    ...over,
  }
}

/**
 * Renders `Retention` behind the SAME two routes `Router.tsx` actually
 * declares (`/retention/new`, `/retention/:id`) rather than the component
 * directly -- unlike `harness`, this screen now reads `useParams().id`, so a
 * test that wants that id populated needs a real `<Routes>` match, not just
 * a URL string sitting under a router with nothing to parse it.
 *
 * Defaults every saved-report method to something that resolves rather than
 * throws, matching whatever the URL/body implies where it reasonably can --
 * a test that does not care about the load or the save should not have to
 * mock either just to keep the screen from showing an error banner it isn't
 * testing for.
 */
function renderAt(url: string, over: Partial<ApiClient> = {}) {
  const client = {
    runRetention: vi.fn(async () => RESULT),
    schemaEvents: vi.fn(async () => ['signed_up', 'project_created']),
    retentionReport: vi.fn(async (_projectId: number, id: number) => reportFixture({ id })),
    createRetentionReport: vi.fn(async (_projectId: number, body: RetentionReportInput) =>
      reportFixture({ id: 99, ...body }),
    ),
    patchRetentionReport: vi.fn(
      async (_projectId: number, id: number, body: Partial<RetentionReportInput>) =>
        reportFixture({ id, ...body }),
    ),
    // A no-op default, matching the other saved-report methods above --
    // only the delete tests care what this actually does, and every other
    // test in this file should not have to stub it just to avoid an
    // unrelated "not a function" crash if it were ever called by accident.
    deleteRetentionReport: vi.fn(async () => undefined),
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
          <Route path="/retention" element={<p>retention list</p>} />
          <Route path="/retention/new" element={<Retention client={client} />} />
          <Route path="/retention/:id" element={<Retention client={client} />} />
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

describe('Retention', () => {
  it('does not run on render -- a grid is a real scan, so it runs when asked', async () => {
    const client = harness({}, READY)
    // Deliberately not a `waitFor`: the assertion is that nothing was ever
    // requested, and a `waitFor` on an absence passes on the first tick
    // regardless.
    await new Promise((r) => setTimeout(r, 20))
    expect(client.runRetention).not.toHaveBeenCalled()
  })

  it('cannot be run until both events are named', () => {
    harness({}, '/retention?start=signed_up')
    expect(runButton()).toBeDisabled()
  })

  it('runs the definition in the URL', async () => {
    const client = harness({}, READY)
    await userEvent.click(runButton())
    await waitFor(() => expect(client.runRetention).toHaveBeenCalled())
    expect(client.runRetention).toHaveBeenCalledWith(1, {
      start_event: 'signed_up',
      return_event: 'project_created',
      granularity: 'week',
      periods: 8,
    })
  })

  it('clears the grid when the definition changes, rather than leaving stale numbers under new controls', async () => {
    // The mistake the funnel screen documents: a result computed from one
    // definition sitting under the controls of another looks entirely normal
    // and is a wrong answer stated with confidence.
    harness({}, READY)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('retention-grid')).toBeInTheDocument())

    await userEvent.selectOptions(screen.getByRole('combobox', { name: /period/i }), 'month')
    expect(screen.queryByTestId('retention-grid')).toBeNull()
  })

  it('says how many cells are unmeasured, so a dash is not read as a collapse', async () => {
    harness({}, READY)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByTestId('retention-incomplete')).toBeInTheDocument())
    expect(screen.getByTestId('retention-incomplete')).toHaveTextContent(/1 cells? show/)
  })

  it('reports a failure instead of leaving the previous grid on screen', async () => {
    const failing = vi.fn(async () => {
      throw new Error('that grid took too long')
    })
    harness({ runRetention: failing } as unknown as Partial<ApiClient>, READY)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/took too long/))
    expect(screen.queryByTestId('retention-grid')).toBeNull()
  })

  it('surfaces a warning the server attached to an otherwise good grid', async () => {
    const warned = vi.fn(async () => ({
      ...RESULT,
      warnings: [{ path: 'segment_id', reason: 'segment 4 no longer exists' }],
    }))
    harness({ runRetention: warned } as unknown as Partial<ApiClient>, READY)
    await userEvent.click(runButton())
    await waitFor(() => expect(screen.getByText(/segment 4 no longer exists/)).toBeInTheDocument())
  })

  it('sends a where predicate held in the URL, on the side it belongs to', async () => {
    // The gap this closes: `$page where path = /` and `$page where path =
    // /register` were the same report, so the grid answered a different
    // question with total confidence.
    const where = encodeURIComponent(
      JSON.stringify([{ source: 'attribute', attribute: 'path', operator: '=', value: '/' }]),
    )
    const client = harness({}, `${READY}&start_where=${where}`)
    await userEvent.click(runButton())
    await waitFor(() => expect(client.runRetention).toHaveBeenCalled())
    const body = (client.runRetention as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as {
      start_where?: unknown[]
      return_where?: unknown[]
    }
    expect(body.start_where).toHaveLength(1)
    // The two sides are independent -- an empty list is omitted entirely
    // rather than sent as `[]`.
    expect('return_where' in body).toBe(false)
  })

  it('offers a condition editor for each event, not one shared between them', async () => {
    harness({}, READY)
    // Addressed by their own ids: one shared editor would silently apply a
    // start-side condition to the return side.
    expect(document.querySelector('[data-testid^="retention-start-where"]')).not.toBeNull()
    expect(document.querySelector('[data-testid^="retention-return-where"]')).not.toBeNull()
  })

  it('actually adds a row when Add predicate is clicked', async () => {
    // The bug Cem hit: the button appeared dead. `WherePredicates` adds a
    // BLANK row, and validating each element against the full schema on the
    // way out of the URL threw it away before it could render. End to end
    // through the real editor, because neither half was wrong on its own.
    harness({}, READY)
    const start = screen.getByTestId('retention-start-where-where')
    await userEvent.click(within(start).getByRole('button', { name: /add predicate/i }))
    expect(within(start).getAllByRole('combobox', { name: /operator/i })).toHaveLength(1)
  })

  it('adds to one side without touching the other', async () => {
    harness({}, READY)
    const start = screen.getByTestId('retention-start-where-where')
    await userEvent.click(within(start).getByRole('button', { name: /add predicate/i }))
    const ret = screen.getByTestId('retention-return-where-where')
    expect(within(ret).queryAllByRole('combobox', { name: /operator/i })).toHaveLength(0)
  })

  it('blocks the run while a condition is unfinished, and says so', async () => {
    // Not dropped silently: a half-built condition removed at request time
    // measures a wider population than the operator built.
    harness({}, READY)
    const start = screen.getByTestId('retention-start-where-where')
    await userEvent.click(within(start).getByRole('button', { name: /add predicate/i }))
    expect(screen.getByTestId('retention-unfinished')).toBeInTheDocument()
    expect(runButton()).toBeDisabled()
  })

  it('sends no bounds on the default range', async () => {
    const client = harness({}, READY)
    await userEvent.click(runButton())
    await waitFor(() => expect(client.runRetention).toHaveBeenCalled())
    const body = (client.runRetention as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as Record<string, unknown>
    expect('since' in body).toBe(false)
  })

  it('sends the chosen range', async () => {
    const client = harness({}, `${READY}&range=custom&from=2026-06-01&to=2026-06-30`)
    await userEvent.click(runButton())
    await waitFor(() => expect(client.runRetention).toHaveBeenCalled())
    const body = (client.runRetention as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[1] as Record<string, string>
    expect(body.since).toBe('2026-06-01T00:00:00.000Z')
    // Inclusive end: somebody who picks the 30th means the whole of it.
    expect(body.until).toBe('2026-06-30T23:59:59.999Z')
  })

  it('refuses a range that would exceed the cohort cap, before sending it', async () => {
    // 365 days of DAILY cohorts is 365 against a ceiling of 60. The server
    // refuses rather than truncating; saying so here is the better answer.
    harness({}, `${READY}&granularity=day&range=365d`)
    expect(screen.getByTestId('retention-too-many-cohorts')).toHaveTextContent('365')
    expect(runButton()).toBeDisabled()
  })

  it('blocks a half-filled custom range', async () => {
    harness({}, `${READY}&range=custom&from=2026-06-01`)
    expect(screen.getByTestId('retention-range-unfinished')).toBeInTheDocument()
    expect(runButton()).toBeDisabled()
  })
})

describe('Retention -- saving and reopening a saved report', () => {
  it('warns on LOAD when the stored granularity exceeds the cohort ceiling for the opened range', async () => {
    // THE POINT OF THIS TASK. The range is never stored (decision 1), so a
    // retention report saved at `granularity: 'day'` can reopen over a range
    // that asks for far more cohorts than the ceiling allows -- 365 days of
    // DAILY cohorts is 365 against a limit of 60. `range=365d` here stands
    // in for a range already sitting in the URL (a bookmark, a shared link
    // with only the range pinned).
    const client = renderAt('/retention/3?range=365d', {
      retentionReport: vi.fn(async () => reportFixture({ granularity: 'day' })),
    })
    expect(await screen.findByTestId('retention-too-many-cohorts')).toBeInTheDocument()
    expect(client.runRetention).not.toHaveBeenCalled()
  })

  it('does not silently widen the stored granularity to make the request fit', async () => {
    // Substituting `week` would show a report the operator did not save.
    // Same setup as the warn-on-load test above -- a `day` report reopened
    // over a range that overflows at that granularity -- so this is a real
    // over-cap situation, not a vacuous check against a value nothing could
    // have changed.
    renderAt('/retention/3?range=365d', {
      retentionReport: vi.fn(async () => reportFixture({ granularity: 'day' })),
    })
    await screen.findByTestId('retention-too-many-cohorts')
    expect(screen.getByRole('combobox', { name: /period/i })).toHaveValue('day')
  })

  it('seeds the URL from the stored definition', async () => {
    const client = renderAt('/retention/3', {
      retentionReport: vi.fn(async () =>
        reportFixture({ start_event: 'signed_up', return_event: 'project_created', periods: 4 }),
      ),
    })
    await waitFor(() => expect(client.runRetention).toHaveBeenCalled())
    expect(lastCallArg(client.runRetention, 1)).toMatchObject({
      start_event: 'signed_up',
      return_event: 'project_created',
      periods: 4,
    })
  })

  it('does not overwrite parameters already in the URL', async () => {
    // A shared link to a saved report at a particular granularity must win
    // over the stored definition, or the link does not mean what it says.
    // Both events are also on the URL so the run is complete enough to fire
    // and prove the value was not overwritten -- a bare URL with only a
    // range on it would prove nothing.
    const client = renderAt(
      '/retention/3?start=signed_up&return=project_created&granularity=day&range=7d',
      { retentionReport: vi.fn(async () => reportFixture({ granularity: 'week' })) },
    )
    await waitFor(() => expect(client.runRetention).toHaveBeenCalled())
    expect(lastCallArg(client.runRetention, 1)).toMatchObject({ granularity: 'day' })
  })

  it('changing the range does not modify the saved report', async () => {
    const client = renderAt('/retention/3')
    await waitFor(() => expect(client.runRetention).toHaveBeenCalled())
    await changeRange('30d')
    expect(client.patchRetentionReport).not.toHaveBeenCalled()
  })

  it('updates the saved report on PATCH, with the same range-free body create sends', async () => {
    // Task 6's review found its PATCH path was correct by inspection --
    // shared with create's body builder -- but no test ever reached it, so a
    // mutation local to that call site would have survived. This asserts the
    // full key set the way the create test does, so a leaked range (or a
    // renamed since/until evasion of it) fails rather than passing
    // unnoticed.
    const client = renderAt('/retention/3')
    await waitFor(() => expect(client.runRetention).toHaveBeenCalled())
    await type(/name/i, 'Renamed')
    await click(/save/i)
    await waitFor(() => expect(client.patchRetentionReport).toHaveBeenCalled())
    expect(client.patchRetentionReport).toHaveBeenCalledWith(1, 3, {
      name: 'Renamed',
      start_event: 'signed_up',
      return_event: 'project_created',
      start_where: [],
      return_where: [],
      granularity: 'week',
      periods: 8,
      segment_id: null,
    })
  })

  it('saves a new report from an unsaved screen', async () => {
    const client = renderAt('/retention/new?start=signed_up&return=project_created')
    await type(/name/i, 'Signup to purchase')
    await click(/save/i)
    await waitFor(() => expect(client.createRetentionReport).toHaveBeenCalled())
    expect(client.createRetentionReport).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        name: 'Signup to purchase',
        start_event: 'signed_up',
        return_event: 'project_created',
      }),
    )
  })

  // I2 from the whole-branch review: `/retention/new` -> `/retention/:id` on
  // CREATE is a full remount (`Router.tsx` gives the two routes different
  // `key`s), and the remount's load effect used to auto-run again -- a full
  // ClickHouse cohort scan, for a grid already on screen. Asserting on the
  // CALL COUNT is the point: a version that merely waits for `runRetention`
  // to have been called at all would pass whether it ran once or twice.
  it('does not re-run the scan a moment after Save -- the grid is already on screen', async () => {
    const client = renderAt('/retention/new?start=signed_up&return=project_created')
    await click(/^run$/i)
    await waitFor(() => expect(client.runRetention).toHaveBeenCalledTimes(1))
    await type(/name/i, 'Signup to purchase')
    await click(/save/i)
    await waitFor(() => expect(client.createRetentionReport).toHaveBeenCalled())
    // Give the remount's own load effect a tick to do whatever it is going
    // to do before reading the call count -- it fetches the report's
    // metadata either way, so that fetch having resolved is the signal the
    // effect has run its course.
    await waitFor(() => expect(client.retentionReport).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.runRetention).toHaveBeenCalledTimes(1)
  })

  it('never includes the range in a saved report’s body', async () => {
    // Mutation table: sending the range would be the first step toward
    // storing it despite decision 1 -- so this asserts the body's whole key
    // set, not just that a `range` key is absent (a mutation could add it
    // under `since`/`until` instead and slip past a narrower check).
    const client = renderAt('/retention/new?start=signed_up&return=project_created&range=30d')
    await type(/name/i, 'Signup to purchase')
    await click(/save/i)
    await waitFor(() => expect(client.createRetentionReport).toHaveBeenCalled())
    const body = lastCallArg(client.createRetentionReport, 1)
    expect(Object.keys(body).sort()).toEqual([
      'granularity',
      'name',
      'periods',
      'return_event',
      'return_where',
      'segment_id',
      'start_event',
      'start_where',
    ])
  })

  it('reports a duplicate name without losing what was typed', async () => {
    renderAt('/retention/new?start=signed_up&return=project_created', {
      createRetentionReport: vi.fn(async () => {
        throw new ApiError(409, 'name_taken')
      }),
    })
    await type(/name/i, 'Taken')
    await click(/save/i)
    expect(await screen.findByText(/already/i)).toBeInTheDocument()
    expect(screen.getByDisplayValue('Taken')).toBeInTheDocument()
  })

  it('sends the stored segment restriction, and says so when the segment is gone', async () => {
    // Decision 3: the id survives the segment's deletion precisely so the
    // run path can say the restriction vanished rather than silently
    // widening. The warning shape is the run endpoint's real one
    // (`reports/routes.ts`), not invented for this test.
    const client = renderAt('/retention/3', {
      retentionReport: vi.fn(async () => reportFixture({ segment_id: 42 })),
      runRetention: vi.fn(async () => ({
        ...RESULT,
        warnings: [
          {
            path: 'segment_id',
            reason:
              'segment 42 no longer exists or cannot be read, so this grid was measured over everyone rather than the population it names',
          },
        ],
      })),
    })
    expect(await screen.findByText(/no longer exists/i)).toBeInTheDocument()
    expect(client.runRetention).toHaveBeenCalledWith(1, expect.objectContaining({ segment_id: 42 }))
  })

  it('warns on a stale report instead of auto-running its unparseable predicates', async () => {
    // Fix round 1's finding: `stale` arrives on every load (`RetentionReport`
    // in `api/types.ts`) and `RetentionReports.tsx` already surfaces it on
    // the list -- this screen was the only place still ignoring it. A stale
    // report's `start_where`/`return_where` no longer parse under the
    // server's grammar, so seeding and auto-running anyway either silently
    // drops the predicates (widening the population) or sends one the
    // server itself flagged as unparseable. Same two-part assertion as the
    // cohort-ceiling warn-on-load test, for the same reason: a warning that
    // renders while the request goes out anyway fixes nothing.
    const client = renderAt('/retention/3', {
      retentionReport: vi.fn(async () => reportFixture({ stale: true })),
    })
    expect(await screen.findByTestId('retention-stale')).toBeInTheDocument()
    expect(client.runRetention).not.toHaveBeenCalled()
  })

  // M5 from the whole-branch review: a stale report's predicates fail to
  // reproduce in one of two ways, and they used to diverge. This is the
  // shape that already worked -- an element that fails core's schema but
  // still LOOKS like a predicate survives seeding as a real, editable row,
  // so `unfinished` counts it and blocks Save the same way an operator's
  // own half-built row does.
  it('disables Save when a stale predicate survives seeding as an unfinished row', async () => {
    renderAt('/retention/3', {
      retentionReport: vi.fn(async () =>
        reportFixture({
          stale: true,
          start_where: [{ property: 'plan', operator: 'not-a-real-op', value: 'x' }],
        }),
      ),
    })
    await screen.findByTestId('retention-stale')
    // `findBy`, not `getBy`: the stale banner is set by the load effect, but
    // the unfinished row is derived from `params` -- re-read after
    // `setSearch`, a SEPARATE update. The two flush together on a fast machine
    // and not on a slow one, which is how this passed every local run and
    // failed in CI.
    expect(await screen.findByTestId('retention-unfinished')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  // The shape that was broken: an element that fails `looksLikePredicate`
  // itself (no `operator` at all) is dropped by `whereFromStored` before it
  // ever becomes a row -- nothing on screen looks unfinished, so `unfinished`
  // stays 0. Before the fix, Save was enabled here, and clicking it would
  // have overwritten the report's stored `start_where` with an empty array.
  it('disables Save when a stale predicate is dropped entirely, not only when it survives as a row', async () => {
    const client = renderAt('/retention/3', {
      retentionReport: vi.fn(async () =>
        reportFixture({ stale: true, start_where: [{ nonsense: true }] }),
      ),
    })
    await screen.findByTestId('retention-stale')
    // The positive assertion first: Save is disabled by the same load effect
    // that set the banner, so it is a real signal. Asserting the absence of an
    // unfinished row before anything param-derived has rendered would pass
    // whether or not that row was ever going to appear.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    // Nothing visibly incomplete -- the predicate never became a row.
    expect(screen.queryByTestId('retention-unfinished')).not.toBeInTheDocument()
    // And Save, if it were somehow reachable, must never have been asked to
    // write over the stored predicates with the narrower list.
    expect(client.patchRetentionReport).not.toHaveBeenCalled()
  })

  // The gate must not stick forever once the operator has actually rebuilt
  // the side that lost a predicate -- editing IS rebuilding, whether or not
  // the edit happens to repair the exact element that failed to parse.
  // Add-then-Remove nets the SAME empty array `startWhere` already held,
  // but it is a deliberate edit of that side rather than the load's own
  // silent narrowing, which is the distinction the fix draws.
  it('re-enables Save once the operator edits the side that lost a predicate', async () => {
    renderAt('/retention/3', {
      retentionReport: vi.fn(async () =>
        reportFixture({ stale: true, start_where: [{ nonsense: true }] }),
      ),
    })
    await screen.findByTestId('retention-stale')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    const start = await screen.findByTestId('retention-start-where-where')
    await userEvent.click(within(start).getByRole('button', { name: /add predicate/i }))
    await userEvent.click(within(start).getByRole('button', { name: /remove/i }))
    expect(screen.queryByTestId('retention-unfinished')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })

  // Fix round 2's finding: the flag above used to be ONE boolean for the
  // whole report, cleared by editing EITHER side. Editing `startWhere` when
  // it was `returnWhere` that lost a predicate cleared it anyway, and Save
  // would then PATCH `return_where` with the still-narrowed list -- the
  // exact data loss this check exists to prevent, reached from the side
  // that was never touched. This is the broken direction: must fail before
  // the per-side fix.
  it('stays disabled when the OTHER side is edited -- return_where lost a predicate, start_where is touched', async () => {
    renderAt('/retention/3', {
      retentionReport: vi.fn(async () =>
        reportFixture({ stale: true, return_where: [{ nonsense: true }] }),
      ),
    })
    await screen.findByTestId('retention-stale')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    const start = await screen.findByTestId('retention-start-where-where')
    await userEvent.click(within(start).getByRole('button', { name: /add predicate/i }))
    await userEvent.click(within(start).getByRole('button', { name: /remove/i }))
    // start_where round-tripped back to empty and is not itself unfinished
    // -- the ONLY reason Save could still be enabled here is the shared-flag
    // bug, since nothing about start_where looks incomplete.
    expect(screen.queryByTestId('retention-unfinished')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  // #221. Every test in this block opens the report at a bare
  // `/retention/:id`, which is the FIRST visit and the only one that takes
  // the seeding branch. Seeding then writes the surviving definition into
  // the URL, so a reload -- or reopening that link -- arrives with
  // `start=...` already set, `hasRetentionDefinitionParams` is true, and
  // the screen skips seeding because it treats the URL as the operator's
  // own. The Save block was set only inside that skipped branch, while the
  // banner is read off the fetched report, so the screen warned that the
  // report was stale and permitted the overwrite in the same breath.
  it('blocks Save on a stale report reopened at a URL that already carries a definition', async () => {
    renderAt('/retention/3?start=signed_up&return=project_created', {
      retentionReport: vi.fn(async () =>
        reportFixture({ stale: true, start_where: [{ nonsense: true }] }),
      ),
    })
    await screen.findByTestId('retention-stale')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  // The per-side precision must survive the reload, not just the first
  // visit. A fix that simply blocked BOTH sides whenever the report came
  // back stale would pass the test above and fail this one -- it would
  // demand the operator take ownership of a side that never lost anything,
  // which is a different screen's behaviour on the second visit than on the
  // first, and that inconsistency is the same class of defect as #221.
  it('still blocks only the side that lost a predicate when reopened that way', async () => {
    renderAt('/retention/3?start=signed_up&return=project_created', {
      retentionReport: vi.fn(async () =>
        reportFixture({ stale: true, start_where: [{ nonsense: true }] }),
      ),
    })
    await screen.findByTestId('retention-stale')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    // Editing the side that actually lost something is enough. If the fix
    // blocked both sides, this would still be disabled.
    const start = await screen.findByTestId('retention-start-where-where')
    await userEvent.click(within(start).getByRole('button', { name: /add predicate/i }))
    await userEvent.click(within(start).getByRole('button', { name: /remove/i }))
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })

  // The conservative half. When the server calls a report stale but the
  // client can reproduce both sides, nothing on this screen says WHICH side
  // the server objected to -- so both are blocked rather than neither. A
  // guard that trusted only the client's own length comparison would leave
  // Save open here, which is the overwrite #221 is about.
  it('blocks both sides when the server calls it stale and the client lost nothing', async () => {
    renderAt('/retention/3?start=signed_up&return=project_created', {
      retentionReport: vi.fn(async () =>
        reportFixture({ stale: true, start_where: [], return_where: [] }),
      ),
    })
    await screen.findByTestId('retention-stale')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    const start = await screen.findByTestId('retention-start-where-where')
    await userEvent.click(within(start).getByRole('button', { name: /add predicate/i }))
    await userEvent.click(within(start).getByRole('button', { name: /remove/i }))
    // One side rebuilt, the other still unowned.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    const ret = await screen.findByTestId('retention-return-where-where')
    await userEvent.click(within(ret).getByRole('button', { name: /add predicate/i }))
    await userEvent.click(within(ret).getByRole('button', { name: /remove/i }))
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })

  it('does not block Save on a healthy report reopened at a definition-carrying URL', async () => {
    renderAt('/retention/3?start=signed_up&return=project_created', {
      retentionReport: vi.fn(async () =>
        reportFixture({ stale: false, start_where: [], return_where: [] }),
      ),
    })
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled())
    expect(screen.queryByTestId('retention-stale')).not.toBeInTheDocument()
  })

  // The mirror of the test above, so the fix cannot be one-directional: a
  // fix that only special-cases "start_where lost, start_where edited"
  // (or its inverse) would pass one of this pair and fail the other.
  it('stays disabled when the OTHER side is edited -- start_where lost a predicate, return_where is touched', async () => {
    renderAt('/retention/3', {
      retentionReport: vi.fn(async () =>
        reportFixture({ stale: true, start_where: [{ nonsense: true }] }),
      ),
    })
    await screen.findByTestId('retention-stale')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    const ret = await screen.findByTestId('retention-return-where-where')
    await userEvent.click(within(ret).getByRole('button', { name: /add predicate/i }))
    await userEvent.click(within(ret).getByRole('button', { name: /remove/i }))
    expect(screen.queryByTestId('retention-unfinished')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  // The other direction of "a side that lost a predicate is itself
  // edited" -- the existing test above this block covers start_where;
  // this is return_where, so both directions of the RE-enabling half are
  // pinned too, not only the disabling half.
  it('re-enables Save once the operator edits return_where, when return_where is the side that lost a predicate', async () => {
    renderAt('/retention/3', {
      retentionReport: vi.fn(async () =>
        reportFixture({ stale: true, return_where: [{ nonsense: true }] }),
      ),
    })
    await screen.findByTestId('retention-stale')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    const ret = await screen.findByTestId('retention-return-where-where')
    await userEvent.click(within(ret).getByRole('button', { name: /add predicate/i }))
    await userEvent.click(within(ret).getByRole('button', { name: /remove/i }))
    expect(screen.queryByTestId('retention-unfinished')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })

  // Both sides lost a predicate: rebuilding only one must not be enough,
  // and rebuilding both must be. A fix that tracked a single count rather
  // than which SIDES still hold a drop could pass "edit one, still
  // disabled" by coincidence (count 2 -> 1, still nonzero) while failing to
  // generalise -- this pins the actual invariant by checking both steps.
  it('with both sides dropped, only rebuilding both sides re-enables Save', async () => {
    renderAt('/retention/3', {
      retentionReport: vi.fn(async () =>
        reportFixture({
          stale: true,
          start_where: [{ nonsense: true }],
          return_where: [{ nonsense: true }],
        }),
      ),
    })
    await screen.findByTestId('retention-stale')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()

    const start = await screen.findByTestId('retention-start-where-where')
    await userEvent.click(within(start).getByRole('button', { name: /add predicate/i }))
    await userEvent.click(within(start).getByRole('button', { name: /remove/i }))
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()

    const ret = await screen.findByTestId('retention-return-where-where')
    await userEvent.click(within(ret).getByRole('button', { name: /add predicate/i }))
    await userEvent.click(within(ret).getByRole('button', { name: /remove/i }))
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })
})

// A same-route navigation trigger for the id-change guard test below --
// clicking it changes the `:id` param WITHOUT unmounting `Retention` (same
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
    runRetention: vi.fn(async () => RESULT),
    schemaEvents: vi.fn(async () => ['signed_up', 'project_created']),
    retentionReport: vi.fn(async (_projectId: number, id: number) =>
      reportFixture({ id, name: `Report ${id}` }),
    ),
    deleteRetentionReport: vi.fn(async () => undefined),
    ...over,
  } as unknown as ApiClient
  render(
    <MemoryRouter initialEntries={[`/retention/${fromId}`]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route
            path="/retention/:id"
            element={
              <>
                <Retention client={client} />
                <Nav to={`/retention/${toId}`} />
              </>
            }
          />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

describe('Retention -- delete', () => {
  it('offers no Delete button on an unsaved report', async () => {
    harness({}, READY)
    expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull()
  })

  it('offers Delete only once the saved report has loaded', async () => {
    renderAt('/retention/3')
    expect(await screen.findByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })

  it('asks for confirmation first -- deleteRetentionReport is not called before it', async () => {
    const client = renderAt('/retention/3')
    await screen.findByRole('button', { name: /^delete$/i })
    await click(/^delete$/i)
    expect(screen.getByText(/delete this retention report\?/i)).toBeInTheDocument()
    expect(client.deleteRetentionReport).not.toHaveBeenCalled()
  })

  it('cancelling the confirmation leaves the report in place', async () => {
    const client = renderAt('/retention/3')
    await screen.findByRole('button', { name: /^delete$/i })
    await click(/^delete$/i)
    await click(/^cancel$/i)
    expect(screen.queryByText(/delete this retention report\?/i)).toBeNull()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
    expect(client.deleteRetentionReport).not.toHaveBeenCalled()
  })

  it('confirming calls deleteRetentionReport with the project and report id, then leaves for the list', async () => {
    const client = renderAt('/retention/3')
    await screen.findByRole('button', { name: /^delete$/i })
    await click(/^delete$/i)
    await click(/^delete retention report$/i)
    await waitFor(() => expect(client.deleteRetentionReport).toHaveBeenCalledWith(1, 3))
    expect(await screen.findByText('retention list')).toBeInTheDocument()
  })

  it('a failed delete shows its own error and leaves the rest of the screen intact', async () => {
    const client = renderAt('/retention/3', {
      deleteRetentionReport: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await screen.findByRole('button', { name: /^delete$/i })
    // Something already true on screen, independent of the delete outcome --
    // this is what must still be there once the delete fails.
    expect(await screen.findByDisplayValue('Report')).toBeInTheDocument()
    await click(/^delete$/i)
    await click(/^delete retention report$/i)
    expect(await screen.findByText(/could not delete this retention report/i)).toBeInTheDocument()
    expect(screen.queryByText('retention list')).toBeNull()
    expect(screen.getByDisplayValue('Report')).toBeInTheDocument()
  })

  it('routes a 401 on delete to onUnauthorized rather than an error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = {
      runRetention: vi.fn(async () => RESULT),
      schemaEvents: vi.fn(async () => ['signed_up', 'project_created']),
      retentionReport: vi.fn(async (_projectId: number, id: number) => reportFixture({ id })),
      deleteRetentionReport: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    } as unknown as ApiClient
    render(
      <MemoryRouter initialEntries={['/retention/3']}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path="/retention/:id"
              element={<Retention client={client} onUnauthorized={onUnauthorized} />}
            />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('button', { name: /^delete$/i })
    await click(/^delete$/i)
    await click(/^delete retention report$/i)
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
    expect(screen.getByText(/delete this retention report\?/i)).toBeInTheDocument()

    await click(/^go$/i)
    await waitFor(() => expect(screen.getByDisplayValue('Report 8')).toBeInTheDocument())
    expect(screen.queryByText(/delete this retention report\?/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^delete retention report$/i })).toBeNull()
    expect(client.deleteRetentionReport).not.toHaveBeenCalled()
  })
})
