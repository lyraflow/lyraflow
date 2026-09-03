import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import type {
  Funnel,
  FunnelRunResult,
  ResolvedTile,
  RetentionReport,
  RetentionResult,
  TrendReport,
} from '../../api/types.js'
import type { RangeChoice } from '../shared/range.js'
import { DashboardTile, type TileEditActions } from './DashboardTile.js'
import { type RunQueue, createRunQueue } from './runQueue.js'

const T = '2026-08-01T00:00:00.000Z'
const preset = (id: RangeChoice['preset']): RangeChoice => ({ preset: id, from: '', to: '' })

const TREND: TrendReport = {
  id: 1,
  name: 'Signups by country',
  event: 'signup',
  interval: '1d',
  group_by: 'attribute:country',
  where: [{ property: 'plan', operator: '=', value: 'pro' }],
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
  segment_id: 5,
  stale: false,
  created_at: T,
  updated_at: T,
}

// Copied from `FunnelDetail.test.tsx` -- the same row shape the funnel
// screen's own tests run against, so a tile and that screen cannot be
// exercised against two different ideas of what `GET /v1/funnels/:id`
// returns.
const FUNNEL: Funnel = {
  id: 3,
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
  created_at: T,
  updated_at: T,
}

const FUNNEL_RUN: FunnelRunResult = {
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

const RETENTION_RUN: RetentionResult = {
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

const trendTile = (over: Partial<Extract<ResolvedTile, { kind: 'trend' }>> = {}): ResolvedTile => ({
  kind: 'trend',
  report_id: 1,
  width: 'half',
  report: TREND,
  ...over,
})
const retentionTile = (
  over: Partial<Extract<ResolvedTile, { kind: 'retention' }>> = {},
): ResolvedTile => ({
  kind: 'retention',
  report_id: 2,
  width: 'half',
  report: RETENTION,
  ...over,
})
const funnelTile = (
  over: Partial<Extract<ResolvedTile, { kind: 'funnel' }>> = {},
): ResolvedTile => ({ kind: 'funnel', report_id: 3, width: 'half', report: FUNNEL, ...over })

/** A promise that never settles -- "the run is still in flight". */
const pending = <T,>(): Promise<T> => new Promise<T>(() => {})

function stubClient(over: Record<string, unknown> = {}): ApiClient {
  return {
    stats: vi.fn(() => pending()),
    runRetention: vi.fn(() => pending()),
    runFunnel: vi.fn(() => pending()),
    funnelPeople: vi.fn(async () => ({
      members: [],
      next_cursor: null,
      window_exhausted: true,
      person_count: 0,
      as_of: T,
    })),
    ...over,
  } as unknown as ApiClient
}

function renderTile(opts: {
  tile: ResolvedTile
  client?: ApiClient
  range?: RangeChoice
  queue?: RunQueue
  editing?: boolean
  actions?: TileEditActions
  onUnauthorized?: () => void
}) {
  const client = opts.client ?? stubClient()
  const view = render(
    <MemoryRouter>
      <DashboardTile
        client={client}
        projectId={1}
        tile={opts.tile}
        range={opts.range ?? preset('7d')}
        queue={opts.queue ?? createRunQueue()}
        editing={opts.editing ?? false}
        actions={opts.actions}
        onUnauthorized={opts.onUnauthorized}
      />
    </MemoryRouter>,
  )
  return { client, ...view }
}

describe('DashboardTile', () => {
  it('loading: a skeleton while the run is in flight', async () => {
    const { client } = renderTile({ tile: trendTile() })
    expect(await screen.findByTestId('tile-loading')).toBeInTheDocument()
    expect(client.stats).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('tile-result')).not.toBeInTheDocument()
  })

  it('result: renders the trend panels for a stats result', async () => {
    const client = stubClient({
      stats: vi.fn(async () => ({
        buckets: [{ bucket: '2026-09-01T00:00:00.000Z', series: 'pro', events: 3 }],
      })),
    })
    renderTile({ tile: trendTile(), client })
    // Queried the way `TrendPanels.test.tsx` does.
    expect(await screen.findByTestId('trend-panels')).toBeInTheDocument()
    expect(screen.getByTestId('trend-panel-pro')).toBeInTheDocument()
    expect(screen.getByTestId('tile-result')).toBeInTheDocument()
  })

  it('result: renders the retention grid', async () => {
    const client = stubClient({ runRetention: vi.fn(async () => RETENTION_RUN) })
    renderTile({ tile: retentionTile(), client })
    // Queried the way `RetentionGrid.test.tsx` does.
    expect(await screen.findByTestId('retention-grid')).toBeInTheDocument()
    expect(screen.getByTestId('tile-result')).toBeInTheDocument()
  })

  it('result: renders the funnel inert -- no step is selectable and no people call is made', async () => {
    const client = stubClient({ runFunnel: vi.fn(async () => FUNNEL_RUN) })
    renderTile({ tile: funnelTile(), client })
    // `useIsWide` is false under jsdom, so this is `StepBars`.
    const step = await screen.findByTestId('funnel-step-1')
    expect(step.tagName).not.toBe('BUTTON')
    await userEvent.click(step)
    expect(client.funnelPeople).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Show people at step/ })).not.toBeInTheDocument()
  })

  it('deleted: says the report is gone, names kind and id, sends nothing', async () => {
    const { client } = renderTile({ tile: trendTile({ report_id: 7, report: null }) })
    expect(await screen.findByTestId('tile-deleted')).toHaveTextContent(
      /this trend report \(id 7\) has been deleted/i,
    )
    expect(client.stats).not.toHaveBeenCalled()
    expect(screen.queryByTestId('tile-loading')).not.toBeInTheDocument()
    // No link: the report's own screen is a 404 now, and offering it is a
    // dead end presented as a way forward.
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('deleted: offers Remove only in edit mode', async () => {
    const actions: TileEditActions = {
      onToggleWidth: vi.fn(),
      onRemove: vi.fn(),
    }
    const { unmount } = renderTile({ tile: trendTile({ report: null }), editing: false, actions })
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    unmount()

    renderTile({ tile: trendTile({ report: null }), editing: true, actions })
    await userEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(actions.onRemove).toHaveBeenCalledTimes(1)
  })

  it('edit mode: names every control, and disables the moves it cannot make', async () => {
    // These four names are the dashboard screen's contract with this tile.
    const actions: TileEditActions = { onToggleWidth: vi.fn(), onRemove: vi.fn() }
    renderTile({ tile: trendTile({ width: 'half' }), editing: true, actions })
    expect(screen.getByRole('button', { name: 'Move up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move down' })).toBeDisabled()
    // The toggle names the width it would switch TO.
    await userEvent.click(screen.getByRole('button', { name: 'Full width' }))
    expect(actions.onToggleWidth).toHaveBeenCalledTimes(1)
  })

  it('edit mode: a full-width tile offers Half width, and an enabled move calls back', async () => {
    const actions: TileEditActions = {
      onMoveUp: vi.fn(),
      onMoveDown: vi.fn(),
      onToggleWidth: vi.fn(),
      onRemove: vi.fn(),
    }
    renderTile({ tile: trendTile({ width: 'full' }), editing: true, actions })
    expect(screen.getByRole('button', { name: 'Half width' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Move up' }))
    expect(actions.onMoveUp).toHaveBeenCalledTimes(1)
  })

  it('stale: says the definition cannot be reproduced, links to the report, sends nothing', async () => {
    const client = stubClient()
    renderTile({ tile: trendTile({ report: { ...TREND, stale: true } }), client })
    expect(await screen.findByTestId('tile-stale')).toHaveTextContent(/cannot be reproduced/i)
    expect(client.stats).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /Open it/i })).toHaveAttribute('href', '/trends/1')
  })

  it('ceiling: a trend at 1m under 30d warns on first render and NEVER calls stats', async () => {
    const client = stubClient()
    renderTile({
      tile: trendTile({ report: { ...TREND, interval: '1m' } }),
      range: preset('30d'),
      client,
    })
    expect(await screen.findByTestId('tile-ceiling')).toBeInTheDocument()
    expect(client.stats).not.toHaveBeenCalled()
    expect(screen.queryByTestId('tile-loading')).not.toBeInTheDocument()
    // 30 days of minutes against a ceiling of 1000.
    expect(screen.getByTestId('tile-ceiling')).toHaveTextContent('43,200')
    expect(screen.getByTestId('tile-ceiling')).toHaveTextContent('1,000')
  })

  it('ceiling: a funnel under 180d warns and never calls runFunnel', async () => {
    const client = stubClient()
    renderTile({ tile: funnelTile(), range: preset('180d'), client })
    expect(await screen.findByTestId('tile-ceiling')).toHaveTextContent(/at most 90 days/i)
    expect(client.runFunnel).not.toHaveBeenCalled()
  })

  it('ceiling: a retention grid over more cohorts than the server allows warns and sends nothing', async () => {
    // The third ceiling. Daily cohorts over a year is 365 against a limit of
    // 60 -- the same refusal the Retention screen makes before sending.
    const client = stubClient()
    renderTile({
      tile: retentionTile({ report: { ...RETENTION, granularity: 'day' } }),
      range: preset('365d'),
      client,
    })
    expect(await screen.findByTestId('tile-ceiling')).toHaveTextContent(/cohorts/i)
    expect(screen.getByTestId('tile-ceiling')).toHaveTextContent('day')
    expect(client.runRetention).not.toHaveBeenCalled()
  })

  it('ceiling: the stored interval is still displayed, never substituted', async () => {
    // The warning must name the resolution the report was SAVED at. Printing
    // a coarser one that would fit is how a reader is told their report is
    // something it is not.
    renderTile({
      tile: trendTile({ report: { ...TREND, interval: '1m' } }),
      range: preset('30d'),
    })
    const warning = await screen.findByTestId('tile-ceiling')
    expect(warning).toHaveTextContent('1m')
    expect(warning).not.toHaveTextContent('1d')
  })

  it('failed: shows the error and a Retry that runs again', async () => {
    const stats = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
      .mockResolvedValueOnce({ buckets: [{ bucket: T, series: 'pro', events: 1 }] })
    renderTile({ tile: trendTile(), client: stubClient({ stats }) })
    expect(await screen.findByTestId('tile-error')).toHaveTextContent(/temporarily unavailable/i)
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('trend-panels')).toBeInTheDocument()
    expect(stats).toHaveBeenCalledTimes(2)
  })

  it("failed: a 404 names the tile's OWN report kind, never a funnel", async () => {
    // `describeError` is the funnel screen's, and its 400/404 branches name a
    // funnel in as many words. A trend tile rendering "This funnel no longer
    // exists." tells the operator about a report that is not on the screen.
    const client = stubClient({
      stats: vi.fn(async () => {
        throw new ApiError(404, 'not_found')
      }),
    })
    renderTile({ tile: trendTile(), client })
    const box = await screen.findByTestId('tile-error')
    expect(box).toHaveTextContent('This trend report no longer exists.')
    expect(box).not.toHaveTextContent(/funnel/i)
  })

  it('failed: a 400 on a retention tile names the offending field and the right kind', async () => {
    const client = stubClient({
      runRetention: vi.fn(async () => {
        throw new ApiError(400, 'bad_definition', [
          { path: 'granularity', message: 'Expected day, week or month' },
        ])
      }),
    })
    renderTile({ tile: retentionTile(), client })
    const box = await screen.findByTestId('tile-error')
    expect(box).toHaveTextContent('This retention report could not be read:')
    expect(box).toHaveTextContent('granularity')
    expect(box).toHaveTextContent('Expected day, week or month')
    expect(box).not.toHaveTextContent(/funnel/i)
  })

  it('failed: a 404 on a funnel tile still says funnel', async () => {
    const client = stubClient({
      runFunnel: vi.fn(async () => {
        throw new ApiError(404, 'not_found')
      }),
    })
    renderTile({ tile: funnelTile(), client })
    expect(await screen.findByTestId('tile-error')).toHaveTextContent(
      'This funnel no longer exists.',
    )
  })

  it("header links to the report's own screen", async () => {
    const { unmount } = renderTile({ tile: trendTile() })
    expect(screen.getByRole('link', { name: 'Signups by country' })).toHaveAttribute(
      'href',
      '/trends/1',
    )
    unmount()

    const second = renderTile({ tile: retentionTile() })
    expect(screen.getByRole('link', { name: 'Weekly return' })).toHaveAttribute(
      'href',
      '/retention/2',
    )
    second.unmount()

    renderTile({ tile: funnelTile() })
    expect(screen.getByRole('link', { name: 'Signup flow' })).toHaveAttribute('href', '/funnels/3')
  })

  it('sends the query Trends would send for the stored definition and the range', async () => {
    const { client } = renderTile({ tile: trendTile(), range: preset('7d') })
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(1))
    const [projectId, query] = (client.stats as Mock).mock.calls[0] as [
      number,
      Record<string, unknown>,
    ]
    expect(projectId).toBe(1)
    // Field-by-field rather than a whole-object equality: `since`/`until` are
    // resolved against the clock at render time and cannot be restated here.
    expect(query.interval).toBe('1d')
    expect(query.event).toBe('signup')
    expect(query.group_by).toBe('attribute:country')
    expect(query.where).toBe(JSON.stringify(TREND.where))
    expect(typeof query.since).toBe('string')
    expect(typeof query.until).toBe('string')
    expect(Object.keys(query).sort()).toEqual(
      ['event', 'group_by', 'interval', 'since', 'until', 'where'].sort(),
    )
  })

  it('sends toRequest for retention, and days for a funnel preset', async () => {
    const retentionClient = stubClient()
    const { unmount } = renderTile({
      tile: retentionTile(),
      range: preset('30d'),
      client: retentionClient,
    })
    await waitFor(() => expect(retentionClient.runRetention).toHaveBeenCalledTimes(1))
    const [projectId, body] = (retentionClient.runRetention as Mock).mock.calls[0] as [
      number,
      Record<string, unknown>,
    ]
    expect(projectId).toBe(1)
    expect(body).toMatchObject({
      start_event: 'signed_up',
      return_event: 'project_created',
      granularity: 'week',
      periods: 8,
      segment_id: 5,
    })
    expect(typeof body.since).toBe('string')
    expect(typeof body.until).toBe('string')
    unmount()

    const funnelClient = stubClient()
    renderTile({ tile: funnelTile(), range: preset('7d'), client: funnelClient })
    await waitFor(() => expect(funnelClient.runFunnel).toHaveBeenCalledTimes(1))
    // `{ days }`, not a client-computed `since` -- see `funnelRangeOf`.
    expect(funnelClient.runFunnel).toHaveBeenCalledWith(1, 3, { days: 7 })
  })

  it('re-runs when the range changes', async () => {
    const client = stubClient()
    const tile = trendTile()
    // ONE queue across both renders, and one `tile`. A fresh `createRunQueue()`
    // per render would re-run the effect on its own and this test would pass
    // with `range` missing from the dependency list entirely -- which it did,
    // until a mutation that dropped `range` left all twenty tests green.
    const queue = createRunQueue()
    const tree = (range: RangeChoice) => (
      <MemoryRouter>
        <DashboardTile
          client={client}
          projectId={1}
          tile={tile}
          range={range}
          queue={queue}
          editing={false}
        />
      </MemoryRouter>
    )
    const { rerender } = render(tree(preset('7d')))
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(1))
    rerender(tree(preset('30d')))
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(2))
  })

  it('does not re-run when re-rendered with the same tile and range', async () => {
    // The other half of the test above: an effect keyed on something that
    // changes every render would re-issue every tile's query on any parent
    // state change -- an edit-mode toggle, a name edit -- which is the way a
    // dashboard quietly turns one page view into dozens of queries.
    const client = stubClient()
    const tile = trendTile()
    const range = preset('7d')
    const queue = createRunQueue()
    // A FRESH element each time, carrying the same prop objects. Re-rendering
    // the identical element makes React bail out of the subtree entirely, so
    // the component never renders again and this test would pass against an
    // effect with no dependency array at all -- which it did.
    const tree = () => (
      <MemoryRouter>
        <DashboardTile
          client={client}
          projectId={1}
          tile={tile}
          range={range}
          queue={queue}
          editing={false}
        />
      </MemoryRouter>
    )
    const { rerender } = render(tree())
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(1))
    rerender(tree())
    rerender(tree())
    await Promise.resolve()
    expect(client.stats).toHaveBeenCalledTimes(1)
  })

  it('a new onUnauthorized identity alone does not re-run the query', async () => {
    // A dashboard renders many tiles against one queue. If the effect
    // depended on this callback, a parent writing the ordinary
    // `onUnauthorized={() => navigate('/login')}` would re-issue every
    // tile's query on every render of the dashboard.
    const client = stubClient()
    const tile = trendTile()
    const range = preset('7d')
    const queue = createRunQueue()
    const tree = () => (
      <MemoryRouter>
        <DashboardTile
          client={client}
          projectId={1}
          tile={tile}
          range={range}
          queue={queue}
          editing={false}
          onUnauthorized={() => {}}
        />
      </MemoryRouter>
    )
    const { rerender } = render(tree())
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(1))
    rerender(tree())
    rerender(tree())
    await Promise.resolve()
    expect(client.stats).toHaveBeenCalledTimes(1)
  })

  it('routes a 401 to onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    const client = stubClient({
      stats: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    renderTile({ tile: trendTile(), client, onUnauthorized })
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('tile-error')).not.toBeInTheDocument()
  })

  it('runs through the queue: three tiles start, the fourth waits', async () => {
    const client = stubClient()
    const queue = createRunQueue()
    render(
      <MemoryRouter>
        {[1, 2, 3, 4].map((id) => (
          <DashboardTile
            key={id}
            client={client}
            projectId={1}
            tile={trendTile({ report_id: id, report: { ...TREND, id } })}
            range={preset('7d')}
            queue={queue}
            editing={false}
          />
        ))}
      </MemoryRouter>,
    )
    await waitFor(() => expect(client.stats).toHaveBeenCalledTimes(3))
    // And it stays three: nothing settles, so no slot ever frees.
    await Promise.resolve()
    expect(client.stats).toHaveBeenCalledTimes(3)
    expect(screen.getAllByTestId('tile-loading')).toHaveLength(4)
  })
})
