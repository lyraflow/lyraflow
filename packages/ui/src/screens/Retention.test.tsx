import { render, screen, waitFor } from '@testing-library/react'
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
})
