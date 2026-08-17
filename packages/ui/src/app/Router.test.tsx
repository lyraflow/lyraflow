import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import { ProjectProvider } from './ProjectContext.js'
import { AppRouter } from './Router.js'

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

function renderAt(path: string) {
  window.history.pushState({}, '', path)
  const client = {
    events: vi.fn(async () => ({ events: [], next_cursor: null })),
    rejections: vi.fn(async () => ({ rejections: [], has_more: false, next_offset: 0 })),
    stats: vi.fn(async () => ({ buckets: [] })),
    project: vi.fn(async () => ({ name: 'Alpha', slug: 'alpha', write_key: 'wk_test' })),
    usage: vi.fn(async () => ({
      month: '2026-08',
      events_accepted: 0,
      events_rejected: 0,
      events_throttled: 0,
      monthly_event_quota: null,
    })),
    projects: vi.fn(async () => PROJECTS),
    funnels: vi.fn(async () => []),
    segments: vi.fn(async () => []),
  } as never
  return render(
    <ProjectProvider projects={PROJECTS} initialId={1}>
      <AppRouter client={client} email="admin@localhost" onLogout={vi.fn()} />
    </ProjectProvider>,
  )
}

describe('AppRouter', () => {
  it('renders the feed at the root', async () => {
    renderAt('/')
    expect(await screen.findByRole('tab', { name: /accepted/i })).toBeInTheDocument()
  })

  // Task 3 replaced the placeholder `Settings` with the real screen (the
  // install snippet and this month's usage) -- the page-level heading is
  // still exactly "Settings", so this assertion needed no change, but it's
  // now asserting on the real screen rather than a stand-in.
  it('renders settings at /settings', async () => {
    renderAt('/settings')
    expect(await screen.findByRole('heading', { name: /^settings$/i })).toBeInTheDocument()
  })

  // A full page reload was the old behaviour and it remounts the whole app,
  // re-running the bounded session check. The router exists to stop that.
  it('navigates between screens without a page load', async () => {
    renderAt('/feed')
    await userEvent.click(screen.getByRole('link', { name: /settings/i }))
    expect(await screen.findByRole('heading', { name: /^settings$/i })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/settings')
  })

  it('marks the current destination for assistive technology', async () => {
    renderAt('/settings')
    const link = await screen.findByRole('link', { name: /settings/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // Small fix from the whole-branch review: `<Route path="/">` renders the
  // same Feed element as `/feed`, but the Feed nav link's own `to="/feed"`
  // never matched `/` -- neither nav item got `aria-current` at the one
  // path every operator lands on right after login (or right after the
  // wizard, which has no route of its own to redirect through). Every
  // other test in this file starts at `/feed` or `/settings`, so this is
  // the one that actually exercises the root.
  it('marks Feed as current at the bare root, not only at /feed', async () => {
    renderAt('/')
    const link = await screen.findByRole('link', { name: /feed/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // An unknown client-side path must not render a blank shell. The server
  // already hands any non-API GET to the SPA, so this is the app's job.
  it('renders the feed for an unknown path rather than nothing', async () => {
    renderAt('/nope')
    expect(await screen.findByRole('tab', { name: /accepted/i })).toBeInTheDocument()
  })

  // Route RESOLUTION, not ordering -- `<Routes>` ranks candidates by path
  // specificity (via `matchRoutes()`), independently of the order `<Route>`s
  // are declared in `Router.tsx`; verified directly by moving the funnel
  // routes after the "*" catch-all and confirming this still passes. What
  // this pins instead: a typo'd `ROUTES.funnels`, a missing `<Route>`, or a
  // `path`/`element` mismatch would all make `/funnels` fall through to the
  // catch-all -- checked as a negative (no Feed tab reachable) alongside the
  // positive (Funnels' own heading), so a component that renders *something*
  // at both destinations can't pass this by accident.
  it('resolves /funnels to Funnels, not the feed catch-all', async () => {
    renderAt('/funnels')
    expect(await screen.findByRole('heading', { name: /^funnels$/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /accepted/i })).not.toBeInTheDocument()
  })

  it('marks Funnels as current at /funnels', async () => {
    renderAt('/funnels')
    const link = await screen.findByRole('link', { name: /funnels/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // There is no declaration-order guarantee to pin
  // (`<Routes>` ranks by path specificity via `matchRoutes()`, verified on
  // the funnels branch by moving routes after the catch-all and watching
  // every test stay green) -- so this pins resolution instead, exactly
  // mirroring the funnels test above: the positive (Segments' own heading)
  // alongside the negative (no Feed tab reachable), so a component that
  // renders *something* at both destinations can't pass by accident.
  it('resolves /segments to Segments, not the feed catch-all', async () => {
    renderAt('/segments')
    expect(await screen.findByRole('heading', { name: /^segments$/i })).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /accepted/i })).not.toBeInTheDocument()
  })

  it('marks Segments as current at /segments', async () => {
    renderAt('/segments')
    const link = await screen.findByRole('link', { name: /segments/i })
    expect(link).toHaveAttribute('aria-current', 'page')
  })

  // IMPORTANT 3 from the whole-branch review: `onUnauthorized` used to be
  // handed only to `Feed` -- an admin on `/settings` with an expired
  // session had no unauthorized detector of its own, only `App`'s hour-long
  // session poll. This proves `AppRouter` now wires it into `Settings` too.
  it('hands onUnauthorized to Settings, not only Feed', async () => {
    window.history.pushState({}, '', '/settings')
    const onUnauthorized = vi.fn()
    const client = {
      events: vi.fn(async () => ({ events: [], next_cursor: null })),
      rejections: vi.fn(async () => ({ rejections: [], has_more: false, next_offset: 0 })),
      stats: vi.fn(async () => ({ buckets: [] })),
      project: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
      usage: vi.fn(async () => ({
        month: '2026-08',
        events_accepted: 0,
        events_rejected: 0,
        events_throttled: 0,
        monthly_event_quota: null,
      })),
      projects: vi.fn(async () => PROJECTS),
    } as never
    render(
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <AppRouter
          client={client}
          email="admin@localhost"
          onLogout={vi.fn()}
          onUnauthorized={onUnauthorized}
        />
      </ProjectProvider>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
  })
})
