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

/**
 * The upgrade path for an install that predates the admin account: no
 * password is set in `.env`, so there is nothing a login form could check
 * against. Rendering a form here would be a dead end with no way out, so
 * this state renders the CLI instruction instead and no form at all.
 */
function Unconfigured() {
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Set up the admin account</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>No admin password is set yet. From the server, run:</p>
        <pre className="overflow-x-auto rounded-md border border-border bg-muted px-3 py-2 text-foreground">
          lyraflow set-admin-password &lt;email&gt;
        </pre>
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

export function Login(props: { client: ApiClient; onSignedIn(email: string): void }) {
  const [configured, setConfigured] = useState<boolean | null>(null)

  const { client } = props
  useEffect(() => {
    let cancelled = false
    client
      .authState()
      .then((state) => {
        if (!cancelled) setConfigured(state.configured)
      })
      .catch(() => {
        // A failed state check is not "unconfigured" -- default to the form
        // so a transient error doesn't hide the CLI instruction behind a
        // login box that can never succeed, nor hide sign-in behind a
        // blank screen. The login attempt itself will surface its own error.
        if (!cancelled) setConfigured(true)
      })
    return () => {
      cancelled = true
    }
  }, [client])

  return (
    <div className="flex h-dvh items-center justify-center bg-background p-4 text-foreground">
      {configured === null ? null : configured ? (
        <LoginForm client={props.client} onSignedIn={props.onSignedIn} />
      ) : (
        <Unconfigured />
      )}
    </div>
  )
}
