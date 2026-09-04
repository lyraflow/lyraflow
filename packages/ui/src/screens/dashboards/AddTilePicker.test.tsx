import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type { DashboardTileInput, Funnel, RetentionReport, TrendReport } from '../../api/types.js'
import { AddTilePicker } from './AddTilePicker.js'

const T = '2026-08-01T00:00:00.000Z'

const TREND: TrendReport = {
  id: 1,
  name: 'Signups by country',
  event: 'signup',
  interval: '1d',
  group_by: null,
  where: [],
  definition_version: 1,
  stale: false,
  created_at: T,
  updated_at: T,
}

const RETENTION: RetentionReport = {
  id: 2,
  name: 'Weekly return',
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
}

const FUNNEL: Funnel = {
  id: 3,
  name: 'Signup flow',
  definition_version: 1,
  steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
  window_seconds: 604800,
  segment_id: null,
  stale: false,
  last_entered: null,
  last_converted: null,
  last_evaluated_at: null,
  last_range: null,
  created_at: T,
  updated_at: T,
}

function renderPicker(
  over: Record<string, unknown> = {},
  onAdd = vi.fn(),
  onUnauthorized?: () => void,
) {
  const client = {
    trendReports: vi.fn(async () => [TREND]),
    retentionReports: vi.fn(async () => [RETENTION]),
    funnels: vi.fn(async () => [FUNNEL]),
    ...over,
  } as unknown as ApiClient
  render(
    <MemoryRouter>
      <AddTilePicker client={client} projectId={1} onAdd={onAdd} onUnauthorized={onUnauthorized} />
    </MemoryRouter>,
  )
  return { client, onAdd }
}

const select = () => screen.getByRole('combobox', { name: 'Report to add' })

describe('AddTilePicker', () => {
  it('fetches all three report lists for the project, once', async () => {
    const { client } = renderPicker()
    await waitFor(() => expect(select()).toBeInTheDocument())
    expect(client.trendReports).toHaveBeenCalledTimes(1)
    expect(client.trendReports).toHaveBeenCalledWith(1)
    expect(client.retentionReports).toHaveBeenCalledTimes(1)
    expect(client.retentionReports).toHaveBeenCalledWith(1)
    expect(client.funnels).toHaveBeenCalledTimes(1)
    expect(client.funnels).toHaveBeenCalledWith(1)
  })

  it('groups the options by kind, naming each report', async () => {
    renderPicker()
    await waitFor(() => expect(select()).toBeInTheDocument())
    const groups = select().querySelectorAll('optgroup')
    expect([...groups].map((g) => g.getAttribute('label'))).toEqual([
      'Trends',
      'Retention',
      'Funnels',
    ])
    expect(
      within(groups[0] as HTMLElement).getByRole('option', { name: 'Signups by country' }),
    ).toBeInTheDocument()
    expect(
      within(groups[1] as HTMLElement).getByRole('option', { name: 'Weekly return' }),
    ).toBeInTheDocument()
    expect(
      within(groups[2] as HTMLElement).getByRole('option', { name: 'Signup flow' }),
    ).toBeInTheDocument()
  })

  it('adds the chosen report as a half-width tile', async () => {
    const { onAdd } = renderPicker()
    await waitFor(() => expect(select()).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Add tile' })).toBeDisabled()
    await userEvent.selectOptions(select(), 'retention:2')
    await userEvent.click(screen.getByRole('button', { name: 'Add tile' }))
    expect(onAdd).toHaveBeenCalledWith({ kind: 'retention', report_id: 2, width: 'half' })
  })

  // I1 from the final whole-branch review: `Add tile` sends the WHOLE tile
  // array plus the new one, built from the layout on screen when it was
  // clicked. While a PATCH is in flight the array on screen is the pre-edit
  // one, so a second write would replace the first.
  it('shuts the Add button while the dashboard is saving, choice intact', async () => {
    render(
      <MemoryRouter>
        <AddTilePicker
          client={
            {
              trendReports: vi.fn(async () => [TREND]),
              retentionReports: vi.fn(async () => [RETENTION]),
              funnels: vi.fn(async () => [FUNNEL]),
            } as unknown as ApiClient
          }
          projectId={1}
          onAdd={vi.fn()}
          disabled
        />
      </MemoryRouter>,
    )
    await waitFor(() => expect(select()).toBeInTheDocument())
    await userEvent.selectOptions(select(), 'retention:2')
    expect(select()).toHaveValue('retention:2')
    expect(screen.getByRole('button', { name: 'Add tile' })).toBeDisabled()
  })

  it('a new onUnauthorized identity neither refetches nor discards the choice', async () => {
    // The effect resets `chosen`, so depending on this callback would wipe the
    // operator's selection mid-edit every time the parent re-rendered --
    // `App.tsx`'s handler is a plain function, so its identity changes.
    const client = {
      trendReports: vi.fn(async () => [TREND]),
      retentionReports: vi.fn(async () => [RETENTION]),
      funnels: vi.fn(async () => [FUNNEL]),
    } as unknown as ApiClient
    const onAdd = vi.fn()
    const tree = () => (
      <MemoryRouter>
        <AddTilePicker client={client} projectId={1} onAdd={onAdd} onUnauthorized={() => {}} />
      </MemoryRouter>
    )
    const { rerender } = render(tree())
    await waitFor(() => expect(select()).toBeInTheDocument())
    await userEvent.selectOptions(select(), 'retention:2')
    rerender(tree())
    rerender(tree())
    expect(client.trendReports).toHaveBeenCalledTimes(1)
    expect(select()).toHaveValue('retention:2')
    await userEvent.click(screen.getByRole('button', { name: 'Add tile' }))
    expect(onAdd).toHaveBeenCalledWith({ kind: 'retention', report_id: 2, width: 'half' })
  })

  it('marks a report already on the dashboard and refuses to offer it again', async () => {
    // The row stays LISTED, for the same reason a stale one does: a report
    // that vanished from the menu reads as "you have no such report". It
    // is disabled with the reason on it instead, so the second copy cannot
    // be chosen, and the server never sees the 400 it would have sent.
    const onAdd = vi.fn()
    render(
      <MemoryRouter>
        <AddTilePicker
          client={
            {
              trendReports: vi.fn(async () => [TREND]),
              retentionReports: vi.fn(async () => [RETENTION]),
              funnels: vi.fn(async () => [FUNNEL]),
            } as unknown as ApiClient
          }
          projectId={1}
          onAdd={onAdd}
          present={[{ kind: 'retention', report_id: 2, width: 'full' }]}
        />
      </MemoryRouter>,
    )
    await waitFor(() => expect(select()).toBeInTheDocument())
    const taken = screen.getByRole('option', { name: /Weekly return/ })
    expect(taken).toBeDisabled()
    expect(taken).toHaveTextContent(/already on this dashboard/)
    expect(screen.getByRole('option', { name: 'Signups by country' })).toBeEnabled()
    expect(screen.getByRole('option', { name: 'Signup flow' })).toBeEnabled()
  })

  it('a choice made before the report landed on the dashboard cannot be added', async () => {
    // Another tab adds it between the choice and the click: the option is
    // disabled now, but the native control keeps the value, so the button
    // has to look at the choice, not only at whether one was made.
    const client = {
      trendReports: vi.fn(async () => [TREND]),
      retentionReports: vi.fn(async () => [RETENTION]),
      funnels: vi.fn(async () => [FUNNEL]),
    } as unknown as ApiClient
    const onAdd = vi.fn()
    const tree = (present: DashboardTileInput[]) => (
      <MemoryRouter>
        <AddTilePicker client={client} projectId={1} onAdd={onAdd} present={present} />
      </MemoryRouter>
    )
    const { rerender } = render(tree([]))
    await waitFor(() => expect(select()).toBeInTheDocument())
    await userEvent.selectOptions(select(), 'retention:2')
    expect(screen.getByRole('button', { name: 'Add tile' })).toBeEnabled()
    rerender(tree([{ kind: 'retention', report_id: 2, width: 'half' }]))
    expect(select()).toHaveValue('retention:2')
    expect(screen.getByRole('button', { name: 'Add tile' })).toBeDisabled()
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('an id present under one kind does not mark the same id under another', async () => {
    // Ids are per table: trend 3 and funnel 3 are different reports.
    render(
      <MemoryRouter>
        <AddTilePicker
          client={
            {
              trendReports: vi.fn(async () => [{ ...TREND, id: 3 }]),
              retentionReports: vi.fn(async () => [RETENTION]),
              funnels: vi.fn(async () => [FUNNEL]),
            } as unknown as ApiClient
          }
          projectId={1}
          onAdd={vi.fn()}
          present={[{ kind: 'funnel', report_id: 3, width: 'half' }]}
        />
      </MemoryRouter>,
    )
    await waitFor(() => expect(select()).toBeInTheDocument())
    expect(screen.getByRole('option', { name: 'Signups by country' })).toBeEnabled()
    expect(screen.getByRole('option', { name: /Signup flow/ })).toBeDisabled()
  })

  it('with every saved report already on the dashboard, says so instead of a menu', async () => {
    render(
      <MemoryRouter>
        <AddTilePicker
          client={
            {
              trendReports: vi.fn(async () => [TREND]),
              retentionReports: vi.fn(async () => [RETENTION]),
              funnels: vi.fn(async () => [FUNNEL]),
            } as unknown as ApiClient
          }
          projectId={1}
          onAdd={vi.fn()}
          present={[
            { kind: 'trend', report_id: 1, width: 'half' },
            { kind: 'retention', report_id: 2, width: 'half' },
            { kind: 'funnel', report_id: 3, width: 'half' },
          ]}
        />
      </MemoryRouter>,
    )
    expect(
      await screen.findByText(/Every saved report is already on this dashboard\./i),
    ).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Add tile' })).not.toBeInTheDocument()
  })

  it('lists a stale report too, rather than hiding it', async () => {
    // The TILE says a stale definition cannot be reproduced. Filtering the
    // row out here instead would make a saved report simply disappear, with
    // nothing on any screen saying why.
    renderPicker({ trendReports: vi.fn(async () => [{ ...TREND, stale: true }]) })
    await waitFor(() => expect(select()).toBeInTheDocument())
    expect(screen.getByRole('option', { name: /Signups by country/ })).toBeInTheDocument()
  })

  it('with nothing saved anywhere, points at the three places to make one', async () => {
    renderPicker({
      trendReports: vi.fn(async () => []),
      retentionReports: vi.fn(async () => []),
      funnels: vi.fn(async () => []),
    })
    expect(await screen.findByText(/No saved reports to add yet\./i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /trend/i })).toHaveAttribute('href', '/trends/new')
    expect(screen.getByRole('link', { name: /retention/i })).toHaveAttribute(
      'href',
      '/retention/new',
    )
    expect(screen.getByRole('link', { name: /funnel/i })).toHaveAttribute('href', '/funnels/new')
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('says so when the lists could not be loaded', async () => {
    renderPicker({
      funnels: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    expect(await screen.findByText('Could not load saved reports.')).toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  })

  it('routes a 401 to onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    renderPicker(
      {
        trendReports: vi.fn(async () => {
          throw new ApiError(401, 'unauthorized')
        }),
      },
      vi.fn(),
      onUnauthorized,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Could not load saved reports.')).not.toBeInTheDocument()
  })
})
