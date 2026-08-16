import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App, { SESSION_CHECK_TIMEOUT_MS, SESSION_POLL_INTERVAL_MS } from './App.js'
import { ApiError } from './api/client.js'
import { DEFAULT_POLL_INTERVAL_MS } from './screens/Feed.js'

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
  beforeEach(() => {
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme')
    localStorage.clear()
  })

  it('renders the shell around the feed for an existing session', async () => {
    render(<App client={client()} />)
    expect(await screen.findByText('Feed')).toBeInTheDocument()
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
    expect(screen.queryByText('Feed')).not.toBeInTheDocument()
  })

  // Fix round 1, Finding 2 (Important): a 401 is "no session" -- the only
  // case that should ever reach the login form. Anything else means the
  // server itself could not be confirmed reachable, and bouncing to Login
  // in that state teaches the user nothing until they've already typed a
  // password and watched it fail too.
  it('shows an unavailable state, not the login form, when the session check 5xxs', async () => {
    const c = client({
      session: vi.fn(async () => {
        throw new ApiError(503, 'unavailable')
      }),
    })
    render(<App client={c} />)
    expect(await screen.findByText(/not responding/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Feed')).not.toBeInTheDocument()
  })

  // The other failure shape a 401 must not be confused with: a request that
  // never got an HTTP response at all rejects with a plain `Error`, not an
  // `ApiError`. Must be treated the same as a 5xx, not as "no session".
  it('shows an unavailable state, not the login form, on a network failure', async () => {
    const c = client({
      session: vi.fn(async () => {
        throw new Error('network unreachable')
      }),
    })
    render(<App client={c} />)
    expect(await screen.findByText(/not responding/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
  })

  // Fix round 1, Finding 3 (Important): a server that accepts the
  // connection and never answers is distinct from one that answers with an
  // error, and must not leave the screen blank forever. First it must show
  // it is doing something; after the bound, it must give up and say so.
  it('shows a loading state, then unavailable, if the session check never responds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const c = client({ session: vi.fn(() => new Promise<never>(() => {})) })
      render(<App client={c} />)
      expect(await screen.findByText(/loading/i)).toBeInTheDocument()
      expect(screen.queryByText(/not responding/i)).not.toBeInTheDocument()
      await vi.advanceTimersByTimeAsync(SESSION_CHECK_TIMEOUT_MS)
      await waitFor(() => expect(screen.getByText(/not responding/i)).toBeInTheDocument())
      expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  // The unavailable state's retry affordance must actually retry, not just
  // sit there -- a dead button here is worse than no button, since it reads
  // as "you can fix this" when nothing happens.
  it('retrying the unavailable state re-checks the session', async () => {
    const session = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, 'unavailable'))
      .mockResolvedValueOnce({ email: 'admin@localhost' })
    const c = client({ session })
    render(<App client={c} />)
    await userEvent.click(await screen.findByRole('button', { name: /try again/i }))
    expect(await screen.findByText('Feed')).toBeInTheDocument()
    expect(session).toHaveBeenCalledTimes(2)
  })

  // CI fix: this test used to advance fake time across the real 1-hour
  // production default (`SESSION_POLL_INTERVAL_MS`). `shouldAdvanceTime:
  // true` keeps the fake clock moving in REAL time too, so simulating an
  // hour meant a large number of timer callbacks and microtask flushes --
  // cheap on a fast machine, not cheap on a constrained CI runner, and
  // vitest's test timeout is real time regardless of what the fake clock
  // says. It passed locally and timed out on the GitHub runner. Fixed the
  // same way `Feed`'s `pollIntervalMs` was: `sessionPollIntervalMs` is now
  // a prop, and this test drives a small value instead of simulating a
  // large span of time. The production default itself is pinned separately
  // below, as a plain constant assertion no timer has to prove.
  //
  // Critical 2 from the whole-branch review. Before this, nothing in
  // packages/ui ever called session() again after mount -- a direct
  // violation of the design spec ("The SPA must poll it"), and the entire
  // server-side renewal mechanism (sessions.ts) was dead code from the
  // UI's side: an admin who only ever touched project-scoped routes was
  // logged out at 30 days regardless of activity.
  it('polls the session on its own interval once authenticated', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const session = vi.fn(async () => ({ email: 'admin@localhost' }))
      const c = client({ session })
      render(<App client={c} sessionPollIntervalMs={50} />)
      await screen.findByText('Feed')
      expect(session).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(50)
      await waitFor(() => expect(session).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })

  // The whole-branch review's own observation, acted on in this round:
  // the session poll used to be a bare `setInterval`, which keeps firing
  // on the wall clock regardless of how long the previous `session()` call
  // is taking -- a call that outran its interval could in principle stack.
  // Rebuilt as a settle-then-reschedule chain matching `usePolling`'s own
  // discipline (`screens/feed/usePolling.ts`'s "does not start a second
  // call while one is in flight" test is the sibling of this one).
  it('does not start a second session poll while one is in flight', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let n = 0
      let release: () => void = () => {}
      const session = vi.fn(() => {
        n++
        if (n === 1) return Promise.resolve({ email: 'admin@localhost' })
        return new Promise<{ email: string }>((r) => {
          release = () => r({ email: 'admin@localhost' })
        })
      })
      const c = client({ session })
      render(<App client={c} sessionPollIntervalMs={50} />)
      await screen.findByText('Feed')
      expect(session).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(50)
      await waitFor(() => expect(session).toHaveBeenCalledTimes(2))
      // The second call is now in flight (unresolved). Advancing well past
      // several more intervals must not start a third call while it hangs.
      await vi.advanceTimersByTimeAsync(500)
      expect(session).toHaveBeenCalledTimes(2)
      release()
      await vi.advanceTimersByTimeAsync(50)
      await waitFor(() => expect(session).toHaveBeenCalledTimes(3))
    } finally {
      vi.useRealTimers()
    }
  })

  // The production default itself, pinned as a plain value -- not
  // exercised by a timer, so the real interval cannot be quietly changed
  // without this failing, and no test ever has to simulate an hour of
  // fake time to prove it.
  it('defaults the session poll interval to one hour', () => {
    expect(SESSION_POLL_INTERVAL_MS).toBe(60 * 60 * 1000)
  })

  // The other half: a 401 from that same interval poll means the session
  // is gone, and must return the SPA to the login screen exactly as an
  // expired-session 401 from the feed's own polls does below.
  it('returns to login when the session poll comes back 401', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let n = 0
      const session = vi.fn(async () => {
        if (n++ > 0) throw new ApiError(401, 'no_session')
        return { email: 'admin@localhost' }
      })
      const c = client({ session })
      render(<App client={c} sessionPollIntervalMs={50} />)
      await screen.findByText('Feed')
      await vi.advanceTimersByTimeAsync(50)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument(),
      )
      expect(screen.queryByText('Feed')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  // The third trigger for the same transition: a 401 from any of the
  // feed's own polled endpoints (not the session poll) -- this is the seam
  // between three otherwise-correct modules the review's Critical 2 names:
  // App checks the session once at mount, usePolling never clears data on
  // error, and Feed collapsed every poll's error into one generic message.
  // Together an operator sat behind a "transient hiccup" banner forever,
  // at roughly one request per second, with no route back to login.
  it('returns to login when a feed poll comes back 401', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let n = 0
      const events = vi.fn(async () => {
        if (n++ > 0) throw new ApiError(401, 'invalid_session')
        return { events: [], next_cursor: null }
      })
      const c = client({ events })
      render(<App client={c} />)
      await screen.findByText('Feed')
      await vi.advanceTimersByTimeAsync(DEFAULT_POLL_INTERVAL_MS)
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument(),
      )
      expect(screen.queryByText('Feed')).not.toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  // The wizard replaces the shell entirely for a fresh install -- rendered
  // as a phase, not a route, so it can't be reached once a project exists
  // (see App.tsx's own comment). `onReady` re-fetches the project list and
  // falls through to the normal app once one does.
  it('renders the first-run wizard instead of the shell when there are no projects yet', async () => {
    const projects = vi.fn().mockResolvedValueOnce([])
    const c = client({ projects })
    render(<App client={c} />)
    expect(await screen.findByLabelText(/name/i)).toBeInTheDocument()
    expect(screen.queryByText('Feed')).not.toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /accepted/i })).not.toBeInTheDocument()
  })

  it('falls through to the normal app once the wizard reports a project is ready', async () => {
    const projects = vi
      .fn()
      // App's initial session load: no project yet.
      .mockResolvedValueOnce([])
      // App's own re-fetch after `onReady`, and anything after. Fix round 1
      // on #89: `createProject`'s response now carries the id directly
      // (`CreatedProject` extends `Project`), so the wizard itself no
      // longer calls `projects()` at all -- this is the only other queued
      // response, not a third one for a lookup that no longer happens.
      .mockResolvedValue([PLACEHOLDER_PROJECT])
    const createProject = vi.fn(async () => ({
      ...PLACEHOLDER_PROJECT,
      write_key: 'wk_new',
      server_key: 'sk_new',
    }))
    const c = client({ projects, createProject })
    render(<App client={c} />)
    await userEvent.type(await screen.findByLabelText(/name/i), 'Cem Demo')
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    await userEvent.click(await screen.findByRole('button', { name: /skip|later|dashboard/i }))
    expect(await screen.findByText('Feed')).toBeInTheDocument()
    expect(screen.queryByLabelText(/project name/i)).not.toBeInTheDocument()
    // Exactly two: App's initial load and its post-`onReady` re-fetch --
    // pins against the wizard reintroducing its own `projects()` call.
    expect(projects).toHaveBeenCalledTimes(2)
  })

  // MINOR from the whole-branch review: ThemeToggle only ever mounted
  // inside Shell, so an explicit stored choice was ignored on every screen
  // before authentication -- login, boot, unavailable. This pins the boot
  // screen specifically, since it is reachable with no server response at
  // all (the session check never resolves).
  it('applies a stored theme choice before authentication, not only inside Shell', async () => {
    localStorage.setItem('lf-theme', 'dark')
    const c = client({ session: vi.fn(() => new Promise<never>(() => {})) })
    render(<App client={c} />)
    expect(await screen.findByText(/loading/i)).toBeInTheDocument()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
