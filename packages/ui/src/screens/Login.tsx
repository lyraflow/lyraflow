import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import type { ApiClient } from '../api/client.js'
import { ApiError } from '../api/client.js'
import { Button } from '../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'

/**
 * The server answers a wrong password and an unknown email IDENTICALLY, on
 * purpose -- otherwise the endpoint is an account-enumeration oracle. The UI
 * must not undo that by guessing which one happened, so
 * `invalid_credentials` gets one message covering both and never says
 * whether the account exists.
 */
function messageFor(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'That email and password did not match.'
    if (err.status === 429) return 'Too many attempts. Wait a few minutes and try again.'
    if (err.status === 403) return 'The request was rejected. Reload the page and try again.'
    if (err.status >= 500) return 'Lyraflow is not responding. Check that the server is running.'
  }
  return 'Could not sign in.'
}

/** The command this screen tells an operator to run.
 *
 * IT MUST BE RUNNABLE ON THE INSTALL PATH THE README RECOMMENDS, which is
 * `install.sh` -- and that brings up containers without putting a `lyraflow`
 * binary anywhere on the host's PATH. This screen used to print
 * `lyraflow set-admin-password <email>`, which on a real deployment answered
 * `lyraflow: command not found` (#129). It is the first screen a new install
 * shows, so it was the first thing a new operator could not do.
 *
 * Three details here are load-bearing, and all three are easy to lose to a
 * later tidy-up:
 *
 *   `-T`   -- `docker compose exec` allocates a TTY by default, which
 *             silently discards piped stdin. Without it the obvious
 *             `printf ... | docker compose exec` delivers nothing and the
 *             command hangs or fails with no useful message.
 *   `read -rs` rather than putting the password in the command -- the whole
 *             point of the exercise is a credential, and an argument or an
 *             `echo` lands it in shell history and in `ps` output for every
 *             user on the box.
 *   `unset P` -- so it does not sit in the shell's environment afterwards.
 *
 * The screen cannot know how it was installed, so it shows the Docker form
 * (what `install.sh` produces) and names the other one in a single line
 * rather than guessing or printing two blocks of equal weight.
 */
const SET_PASSWORD_DOCKER = `read -rsp 'password: ' P; echo
printf '%s' "$P" | docker compose exec -T lyraflow \\
  node packages/cli/dist/index.js set-admin-password you@example.com
unset P`

/**
 * The upgrade path for an install that predates the admin account: no
 * password is set in `.env`, so there is nothing a login form could check
 * against. Rendering a form here would be a dead end with no way out, so
 * this state renders the CLI instruction instead and no form at all.
 */
function Unconfigured() {
  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <CardTitle>Set up the admin account</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          No admin password is set yet. From the server, in the directory holding your{' '}
          <code className="text-foreground">docker-compose.yml</code>, run:
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-foreground">
          {SET_PASSWORD_DOCKER}
        </pre>
        <p>
          Replace <code className="text-foreground">you@example.com</code> with the address you want
          to sign in as. The password is typed rather than passed as an argument, so it stays out of
          your shell history.
        </p>
        <p>
          Not running under Docker? Run{' '}
          <code className="text-foreground">lyraflow set-admin-password &lt;email&gt;</code>{' '}
          instead, with the password on stdin.
        </p>
        <p>Then reload this page and sign in.</p>
      </CardContent>
    </Card>
  )
}

function LoginForm(props: { client: ApiClient; onSignedIn(email: string): void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const result = await props.client.login(email, password)
      props.onSignedIn(result.email)
    } catch (err) {
      setError(messageFor(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="login-email">Email</Label>
            <Input
              id="login-email"
              name="email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error !== null && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={submitting}>
            Sign in
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * Bounds the `authState()` check below. By the time `Login` mounts, `App`'s
 * own `session()` check has already gotten SOME response from the server
 * (that is how `App` decided to show this screen at all -- see its own
 * `SESSION_CHECK_TIMEOUT_MS`), so a hang here is a narrower failure than
 * the one `App` guards against, and a shorter bound is appropriate. Without
 * this, a server that accepts the connection and never answers leaves
 * `configured` at its initial `null` forever, and this screen renders
 * nothing -- not the form, not the CLI instruction -- with no indication
 * anything is happening.
 */
export const AUTH_STATE_TIMEOUT_MS = 5000

export function Login(props: { client: ApiClient; onSignedIn(email: string): void }) {
  const [configured, setConfigured] = useState<boolean | null>(null)

  const { client } = props
  useEffect(() => {
    let cancelled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // Same fallback as an outright failure below, and for the same
      // reason: a transient hang is not "unconfigured", and defaulting to
      // the form is the safe choice either way -- the login attempt itself
      // will surface its own error if the server truly is not answering.
      if (!cancelled) setConfigured(true)
    }, AUTH_STATE_TIMEOUT_MS)

    client
      .authState()
      .then((state) => {
        if (!cancelled && !timedOut) setConfigured(state.configured)
      })
      .catch(() => {
        // A failed state check is not "unconfigured" -- default to the form
        // so a transient error doesn't hide the CLI instruction behind a
        // login box that can never succeed, nor hide sign-in behind a
        // blank screen. The login attempt itself will surface its own error.
        if (!cancelled && !timedOut) setConfigured(true)
      })
      .finally(() => clearTimeout(timer))
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [client])

  return (
    <div className="flex h-dvh items-center justify-center bg-background p-4 text-foreground">
      {configured === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : configured ? (
        <LoginForm client={props.client} onSignedIn={props.onSignedIn} />
      ) : (
        <Unconfigured />
      )}
    </div>
  )
}
