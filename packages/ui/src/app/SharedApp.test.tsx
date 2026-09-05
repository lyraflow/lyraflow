import { render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api/client.js'
import { SharedApp } from './SharedApp.js'

const TOKEN = 'A'.repeat(43)

function stubClient(over: Record<string, unknown> = {}): ApiClient {
  return {
    // The whole point of this entry point. A viewer holding a share link has
    // no session, so asking for one gets a 401 and `App` would show the login
    // form -- which is why the pathname decides between the two BEFORE React
    // mounts (`app/entry.ts`) rather than a check inside `App` deciding after
    // the request has already gone out.
    session: vi.fn(() => {
      throw new Error('must not be called')
    }),
    projects: vi.fn(() => {
      throw new Error('must not be called')
    }),
    sharedDashboard: vi.fn(async () => ({
      name: 'Overview',
      updated_at: '2026-08-01T00:00:00.000Z',
      stale: false,
      tiles: [],
    })),
    runSharedTile: vi.fn(() => new Promise<never>(() => {})),
    ...over,
  } as unknown as ApiClient
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-palette')
  localStorage.clear()
  window.history.replaceState(null, '', `/shared/${TOKEN}`)
})

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('SharedApp', () => {
  it('renders the dashboard by token and never asks for a session', async () => {
    const client = stubClient()
    render(<SharedApp token={TOKEN} client={client} />)

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument()
    expect(client.sharedDashboard).toHaveBeenCalledWith(TOKEN)
    expect(client.session).not.toHaveBeenCalled()
    expect(client.projects).not.toHaveBeenCalled()
  })

  // The stored theme and palette are this browser's, chosen on some other
  // page of this install. `App` applies both before authentication for the
  // same reason -- a login screen drawn in the wrong appearance is the bug
  // that taught it -- and a shared page has no `Shell`, so nothing else
  // would ever apply them here.
  it('applies the stored theme and palette', async () => {
    localStorage.setItem('lf-theme', 'dark')
    localStorage.setItem('lf-palette', 'moss')
    render(<SharedApp token={TOKEN} client={stubClient()} />)

    await screen.findByRole('heading', { name: 'Overview' })
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.getAttribute('data-palette')).toBe('moss')
  })
})
