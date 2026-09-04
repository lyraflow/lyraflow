import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

/** Where the router ended up, so a click can be shown to have navigated --
 *  and, in edit mode, shown not to have. */
function UrlProbe() {
  const location = useLocation()
  return <p data-testid="tile-url">{`${location.pathname}${location.search}`}</p>
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
    <MemoryRouter initialEntries={['/dashboards/1']}>
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
      <UrlProbe />
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
    // Under the wide stub the tile renders the FLOW, so the thing a reader
    // would click is a node on the plot rather than a bar. `StepBars` had
    // its own version of this test and passing it there proved nothing
    // about the rendering a dashboard actually shows now.
    stubWideMatchMedia()
    const client = stubClient({ runFunnel: vi.fn(async () => FUNNEL_RUN) })
    // Full width deliberately: the half-width tile's rendering has a test of
    // its own below, and this one must fail for its OWN reason (a step became
    // clickable) rather than for that one's.
    renderTile({ tile: funnelTile({ width: 'full' }), client })
    await screen.findByTestId('funnel-flow')
    await act(async () => {})
    const node = screen.getByTestId('flow-node-1')
    expect(node.tagName).not.toBe('BUTTON')
    await userEvent.click(node)
    expect(client.funnelPeople).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Show people at step/ })).not.toBeInTheDocument()
  })

  // A half-width tile is sized by its grid column, not the viewport: at a
  // normal viewport width it is well under the 768px `FunnelFlowOrBars`
  // treats as room for the flow, but a media query has no way to know that.
  // `matchMedia` here reports wide on purpose, so a failure to special-case
  // `tile.width` shows up even though the viewport itself would pass.
  function stubWideMatchMedia() {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    )
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('result: a half-width funnel tile shows the flow, not the bars', async () => {
    stubWideMatchMedia()
    const client = stubClient({ runFunnel: vi.fn(async () => FUNNEL_RUN) })
    renderTile({ tile: funnelTile({ width: 'half' }), client })
    await screen.findByTestId('tile-result')
    // `StepBars` renders on FIRST paint regardless (it is what
    // `FunnelFlowOrBars` shows before its own `useIsWide` effect has run),
    // so seeing it there is not yet proof of anything -- an extra flush lets
    // that effect settle to its final rendering before either assertion
    // below is taken as the answer.
    await act(async () => {})
    expect(screen.getByTestId('funnel-flow')).toBeInTheDocument()
    expect(screen.queryByTestId('funnel-step-1')).not.toBeInTheDocument()
  })

  it('result: a full-width funnel tile shows the flow too', async () => {
    stubWideMatchMedia()
    const client = stubClient({ runFunnel: vi.fn(async () => FUNNEL_RUN) })
    renderTile({ tile: funnelTile({ width: 'full' }), client })
    await screen.findByTestId('tile-result')
    await act(async () => {})
    expect(screen.getByTestId('funnel-flow')).toBeInTheDocument()
    expect(screen.queryByTestId('funnel-step-1')).not.toBeInTheDocument()
  })

  // The flow is wider than half a grid column and scrolls INSIDE the card
  // (`FunnelFlow`'s own container is `overflow-x-auto`). jsdom does no
  // layout, so this is a tripwire on the classes and NOT a proof: the
  // measurement was a browser at 1180px, where a half tile holding a
  // 1120px plot stays 582px wide with the plot scrolling. That measurement
  // also showed the `min-w-0`s are not what makes it work today -- the
  // scroll container's own automatic minimum size is zero -- so what this
  // pins is that they do not silently disappear before something without
  // an `overflow` rule of its own is added between the card and the plot.
  // The `overflow-hidden` half is the one that would break it outright.
  it('result: nothing above the flow stops it scrolling inside the card', async () => {
    stubWideMatchMedia()
    const client = stubClient({ runFunnel: vi.fn(async () => FUNNEL_RUN) })
    renderTile({ tile: funnelTile({ width: 'half' }), client })
    const result = await screen.findByTestId('tile-result')
    expect(result.className).toContain('min-w-0')
    const content = result.parentElement as HTMLElement
    expect(content.dataset.slot).toBe('card-content')
    expect(content.className).toContain('min-w-0')
    const card = content.parentElement as HTMLElement
    expect(card.dataset.slot).toBe('card')
    expect(card.className).toContain('min-w-0')
    for (const el of [result, content, card]) {
      expect(el.className).not.toContain('overflow-hidden')
    }
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

  // I1 from the final whole-branch review: every one of these buttons sends
  // the WHOLE tile array, built from the layout on screen when it was
  // clicked. Two clicks before the first response lands both carry the
  // pre-edit array, and the second write replaces the first -- so the screen
  // holds them shut while a PATCH is in flight, and says so here.
  it('edit mode: `disabled` shuts every action, including the moves it could make', async () => {
    const actions: TileEditActions = {
      onMoveUp: vi.fn(),
      onMoveDown: vi.fn(),
      onToggleWidth: vi.fn(),
      onRemove: vi.fn(),
      disabled: true,
    }
    renderTile({ tile: trendTile({ width: 'half' }), editing: true, actions })
    expect(screen.getByRole('button', { name: 'Move up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move down' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Full width' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled()
  })

  it('stale: says the definition cannot be reproduced, links to the report, sends nothing', async () => {
    const client = stubClient()
    renderTile({ tile: trendTile({ report: { ...TREND, stale: true } }), client })
    expect(await screen.findByTestId('tile-stale')).toHaveTextContent(/cannot be reproduced/i)
    expect(client.stats).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /Open it/i })).toHaveAttribute(
      'href',
      '/trends/1?range=7d',
    )
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

  it("header links to the report's own screen, over the dashboard's range", async () => {
    // The range travels with the link: opening a report from a dashboard and
    // landing on the report's own default window shows different numbers
    // from the tile that was just clicked, with nothing saying why.
    const { unmount } = renderTile({ tile: trendTile(), range: preset('30d') })
    expect(screen.getByRole('link', { name: 'Signups by country' })).toHaveAttribute(
      'href',
      '/trends/1?range=30d',
    )
    unmount()

    const second = renderTile({ tile: retentionTile(), range: preset('30d') })
    expect(screen.getByRole('link', { name: 'Weekly return' })).toHaveAttribute(
      'href',
      '/retention/2?range=30d',
    )
    second.unmount()

    // A funnel screen spells a range as a day count, and only offers four.
    const third = renderTile({ tile: funnelTile(), range: preset('30d') })
    expect(screen.getByRole('link', { name: 'Signup flow' })).toHaveAttribute(
      'href',
      '/funnels/3?days=30',
    )
    third.unmount()

    // 180d is not one of them, and `auto` is not a range at all -- both open
    // the report on its own default rather than on an invented one.
    const fourth = renderTile({ tile: funnelTile(), range: preset('180d') })
    expect(screen.getByRole('link', { name: 'Signup flow' })).toHaveAttribute('href', '/funnels/3')
    fourth.unmount()

    renderTile({ tile: trendTile(), range: preset('auto') })
    expect(screen.getByRole('link', { name: 'Signups by country' })).toHaveAttribute(
      'href',
      '/trends/1',
    )
  })

  // Cem, testing the feature: "when I click on any dashboard section, I must
  // be redirected to that report with the same time frame so that I can deep
  // dive." The header link is the accessible route to the same place; this is
  // the rest of the card agreeing with it.
  it('view mode: a click anywhere on the body opens the report over the range', async () => {
    const client = stubClient({ runRetention: vi.fn(async () => RETENTION_RUN) })
    renderTile({ tile: retentionTile(), range: preset('30d'), client })
    await screen.findByTestId('retention-grid')
    await userEvent.click(screen.getByTestId('tile-result'))
    expect(screen.getByTestId('tile-url')).toHaveTextContent('/retention/2?range=30d')
  })

  it('edit mode: a click on the body moves nowhere', async () => {
    // Edit mode is where a tile is dragged, widened and removed. A body that
    // navigates out of the screen mid-edit loses whatever was unsaved.
    const client = stubClient({ runRetention: vi.fn(async () => RETENTION_RUN) })
    renderTile({
      tile: retentionTile(),
      range: preset('30d'),
      client,
      editing: true,
      actions: { onToggleWidth: vi.fn(), onRemove: vi.fn() },
    })
    await screen.findByTestId('retention-grid')
    await userEvent.click(screen.getByTestId('tile-result'))
    expect(screen.getByTestId('tile-url')).toHaveTextContent('/dashboards/1')
  })

  it('view mode: Retry retries, and does not navigate away from the dashboard', async () => {
    // The two controls inside the body that already mean something else:
    // this button, and the stale state's "Open it" link. A blanket body
    // handler swallows them into a navigation, and Retry becomes unreachable.
    const stats = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
      .mockResolvedValueOnce({ buckets: [{ bucket: T, series: 'pro', events: 1 }] })
    renderTile({ tile: trendTile(), range: preset('30d'), client: stubClient({ stats }) })
    await screen.findByTestId('tile-error')
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('trend-panels')).toBeInTheDocument()
    expect(stats).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId('tile-url')).toHaveTextContent('/dashboards/1')
  })

  it('deleted: the body is not clickable, because there is nowhere to go', async () => {
    renderTile({ tile: trendTile({ report: null }), range: preset('30d') })
    await userEvent.click(await screen.findByTestId('tile-deleted'))
    expect(screen.getByTestId('tile-url')).toHaveTextContent('/dashboards/1')
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
