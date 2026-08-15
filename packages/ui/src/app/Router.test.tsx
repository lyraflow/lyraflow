import { render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
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

  // An unknown client-side path must not render a blank shell. The server
  // already hands any non-API GET to the SPA, so this is the app's job.
  it('renders the feed for an unknown path rather than nothing', async () => {
    renderAt('/nope')
    expect(await screen.findByRole('tab', { name: /accepted/i })).toBeInTheDocument()
  })
})
