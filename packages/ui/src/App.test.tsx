import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App.js'
import { ApiError } from './api/client.js'

const PLACEHOLDER_PROJECT = {
  id: 1,
  name: 'Cem Demo',
  slug: 'cem-demo',
  created_at: '',
  retention_months: 24,
  monthly_event_quota: null,
}

function client(over: Partial<Record<string, unknown>> = {}) {
  return {
    authState: vi.fn(async () => ({ configured: true })),
    session: vi.fn(async () => ({ email: 'admin@localhost' })),
    projects: vi.fn(async () => [PLACEHOLDER_PROJECT]),
    login: vi.fn(async () => ({ email: 'admin@localhost' })),
    logout: vi.fn(async () => {}),
    events: vi.fn(async () => ({ events: [], next_cursor: null })),
    stats: vi.fn(async () => ({ buckets: [] })),
    rejections: vi.fn(async () => ({ rejections: [], has_more: false, next_offset: 0 })),
    ...over,
  } as never
}

describe('App', () => {
  it('renders the shell around the feed for an existing session', async () => {
    render(<App client={client()} />)
    expect(await screen.findByRole('link', { name: /feed/i })).toBeInTheDocument()
    expect(await screen.findByRole('tab', { name: /accepted/i })).toBeInTheDocument()
  })

  // The other side of the same decision: no cookie (or an expired one)
  // means `session()` 401s, and App must hand off to the login screen
  // rather than rendering the shell with nothing behind it.
  it('renders the login screen when there is no session', async () => {
    const c = client({
      session: vi.fn(async () => {
        throw new ApiError(401, 'not_authenticated')
      }),
    })
    render(<App client={c} />)
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /feed/i })).not.toBeInTheDocument()
  })
})
