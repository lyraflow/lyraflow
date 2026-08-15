import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import { Login } from './Login.js'

function client(over: Partial<Record<string, unknown>> = {}) {
  return {
    authState: vi.fn(async () => ({ configured: true })),
    login: vi.fn(async () => ({ email: 'admin@localhost' })),
    ...over,
  } as never
}

describe('Login', () => {
  it('signs in and reports the email', async () => {
    const onSignedIn = vi.fn()
    const c = client()
    render(<Login client={c} onSignedIn={onSignedIn} />)
    await userEvent.type(await screen.findByLabelText(/email/i), 'admin@localhost')
    await userEvent.type(screen.getByLabelText(/password/i), 'hunter2')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(onSignedIn).toHaveBeenCalledWith('admin@localhost')
  })

  it('shows an error and does not sign in on bad credentials', async () => {
    const onSignedIn = vi.fn()
    const c = client({
      login: vi.fn(async () => {
        throw new ApiError(401, 'invalid_credentials')
      }),
    })
    render(<Login client={c} onSignedIn={onSignedIn} />)
    await userEvent.type(await screen.findByLabelText(/email/i), 'a@b.c')
    await userEvent.type(screen.getByLabelText(/password/i), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  // The server deliberately answers a wrong password and an unknown email
  // identically. The UI must not undo that by guessing which one happened.
  it('does not distinguish a wrong password from an unknown account', async () => {
    const c = client({
      login: vi.fn(async () => {
        throw new ApiError(401, 'invalid_credentials')
      }),
    })
    render(<Login client={c} onSignedIn={vi.fn()} />)
    await userEvent.type(await screen.findByLabelText(/email/i), 'nobody@example.com')
    await userEvent.type(screen.getByLabelText(/password/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent?.toLowerCase()).not.toMatch(/no such|unknown|not found|exist/)
  })

  // The upgrade path: an install that predates the admin account has no
  // password in its .env, so a login form would be a dead end.
  it('shows the CLI instruction instead of a form when unconfigured', async () => {
    const c = client({ authState: vi.fn(async () => ({ configured: false })) })
    render(<Login client={c} onSignedIn={vi.fn()} />)
    expect(await screen.findByText(/set-admin-password/)).toBeInTheDocument()
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument()
  })

  it('shows a rate-limit message on 429', async () => {
    const c = client({
      login: vi.fn(async () => {
        throw new ApiError(429, 'too_many_attempts')
      }),
    })
    render(<Login client={c} onSignedIn={vi.fn()} />)
    await userEvent.type(await screen.findByLabelText(/email/i), 'a@b.c')
    await userEvent.type(screen.getByLabelText(/password/i), 'x')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
    expect((await screen.findByRole('alert')).textContent?.toLowerCase()).toMatch(
      /too many|wait|try again/,
    )
  })

  // Invented: every test above drives a `login` that resolves or rejects
  // immediately, so nothing exercises the in-flight window itself -- yet
  // that window is the whole reason to disable the button (a double-click
  // is two attempts against a rate limiter designed to make guessing
  // expensive). A `login` that never settles is the only way to observe it.
  it('disables the submit button while a request is in flight', async () => {
    let resolveLogin: (v: { email: string }) => void = () => {}
    const c = client({
      login: vi.fn(
        () =>
          new Promise<{ email: string }>((resolve) => {
            resolveLogin = resolve
          }),
      ),
    })
    render(<Login client={c} onSignedIn={vi.fn()} />)
    await userEvent.type(await screen.findByLabelText(/email/i), 'a@b.c')
    await userEvent.type(screen.getByLabelText(/password/i), 'x')
    const button = screen.getByRole('button', { name: /sign in/i })
    await userEvent.click(button)
    expect(button).toBeDisabled()
    // Wrapped in act: resolving here lets LoginForm's .then/.finally state
    // updates run and settle before the test ends, so they don't leak an
    // act() warning into whichever test runs next.
    await act(async () => {
      resolveLogin({ email: 'a@b.c' })
      await Promise.resolve()
    })
    expect(button).not.toBeDisabled()
  })

  // Invented: `authState` is always an immediately-resolving ApiError-or-not
  // stub above. A real network failure (server unreachable, DNS, etc.)
  // rejects with a plain Error, not an ApiError -- and if that rejection is
  // unhandled, `configured` never leaves its initial `null`, so the screen
  // renders nothing forever with no way to reach either the form or the
  // CLI instruction. Falling through to the form is the safe default: the
  // login attempt itself will surface its own error.
  it('still renders the sign-in form if authState() itself fails', async () => {
    const c = client({
      authState: vi.fn(async () => {
        throw new Error('network unreachable')
      }),
    })
    render(<Login client={c} onSignedIn={vi.fn()} />)
    expect(await screen.findByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument()
  })
})
