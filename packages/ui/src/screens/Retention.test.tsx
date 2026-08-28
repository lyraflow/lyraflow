import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api/client.js'
import type { RetentionResult } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { Retention } from './Retention.js'

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
