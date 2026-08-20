import { useState } from 'react'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { Button } from '../components/ui/button.js'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.js'
import { Input } from '../components/ui/input.js'
import { Label } from '../components/ui/label.js'

/** Mirrors `MIN_PASSWORD_LENGTH` in the server's `auth/routes.ts`, which is
 * what actually refuses a short one. Stated here so the form can say the
 * rule BEFORE a round trip -- a field that only tells you the requirement
 * after you have submitted twice is a guessing game. The server remains the
 * enforcer; this is the copy of the number that is allowed to be wrong. */
const MIN_PASSWORD_LENGTH = 12

/**
 * What the server said, in the operator's words.
 *
 * `invalid_credentials` deliberately does NOT become "wrong password" for the
 * email form and something else for the password form: both mean the same
 * thing, and one sentence for one cause is what keeps the two forms from
 * drifting into two vocabularies for one error.
 */
function messageFor(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  if (err.status === 401) return 'That password is not right.'
  if (err.status === 429) {
    return 'Too many attempts. Wait a few minutes and try again.'
  }
  if (err.status === 409) return 'Another account already uses that address.'
  // Read off the CODE, not the server's prose. `ApiError` carries the code
  // and a structured `detail[]` for validation failures; the server's
  // human-readable `detail` string on the password route is there for API
  // and CLI callers, and duplicating it here would give one requirement two
  // wordings that drift.
  if (err.code === 'password_unchanged') return 'That is the password you already have.'
  if (err.code === 'invalid_body') {
    return `Check the fields: a new password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return fallback
}

function EmailForm(props: { client: ApiClient; email: string | null; onChanged: () => void }) {
  const [email, setEmail] = useState(props.email ?? '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      await props.client.changeEmail(email.trim(), password)
      // Cleared on success, never kept "for convenience": a password left
      // in a form field survives in the DOM for as long as the page is
      // open, and this page is one an operator leaves open.
      setPassword('')
      setDone(true)
      props.onChanged()
    } catch (err) {
      setError(messageFor(err, 'Could not change the address. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email address</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex max-w-md flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="profile-email">New email address</Label>
            <Input
              id="profile-email"
              type="email"
              autoComplete="username"
              value={email}
              disabled={busy}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="profile-email-password">Current password</Label>
            <Input
              id="profile-email-password"
              type="password"
              autoComplete="current-password"
              value={password}
              disabled={busy}
              onChange={(e) => setPassword(e.target.value)}
            />
            {/* Says why it is being asked. A password prompt with no reason
             * reads as friction; this one is the whole reason an unattended
             * browser is not an account takeover. */}
            <p className="text-muted-foreground text-xs">
              Confirming your password is what stops an unattended browser from being used to change
              the address that recovers this account.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy || email.trim() === '' || password === ''}>
              Change email
            </Button>
            {done && <span className="text-muted-foreground text-sm">Saved.</span>}
          </div>
          {/* Volunteering the limit: there is no mail transport in the
           * product, so nothing is sent anywhere and the change is
           * immediate. An interface implying a verification step would be
           * lying about what it just did. */}
          <p className="text-muted-foreground text-xs">
            There is no confirmation email — Lyraflow sends no mail. The new address takes effect
            immediately and is what you sign in with next time.
          </p>
          {error != null && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  )
}

function PasswordForm(props: { client: ApiClient }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const tooShort = next !== '' && next.length < MIN_PASSWORD_LENGTH

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setDone(false)
    try {
      await props.client.changePassword(current, next)
      setCurrent('')
      setNext('')
      setDone(true)
    } catch (err) {
      setError(messageFor(err, 'Could not change the password. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Password</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex max-w-md flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor="profile-current-password">Current password</Label>
            <Input
              id="profile-current-password"
              type="password"
              autoComplete="current-password"
              value={current}
              disabled={busy}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="profile-new-password">New password</Label>
            <Input
              id="profile-new-password"
              type="password"
              autoComplete="new-password"
              value={next}
              disabled={busy}
              onChange={(e) => setNext(e.target.value)}
            />
            {/* The rule, stated up front and only in terms of length.
             * Composition rules produce worse passwords, so there are none
             * to explain. */}
            <p className="text-muted-foreground text-xs">
              At least {MIN_PASSWORD_LENGTH} characters. Nothing else is required — length is what
              makes a password hard to guess.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              disabled={busy || current === '' || next.length < MIN_PASSWORD_LENGTH}
            >
              Change password
            </Button>
            {done && <span className="text-muted-foreground text-sm">Saved.</span>}
          </div>
          {/* Said BEFORE the click, not after. Somebody changing a password
           * because it leaked needs to know this is what happens; somebody
           * doing it routinely needs to know their other browser will ask
           * again. */}
          <p className="text-muted-foreground text-xs">
            Changing your password signs out every other browser. This one stays signed in.
          </p>
          {tooShort && (
            <p className="text-muted-foreground text-xs">
              {`${MIN_PASSWORD_LENGTH - next.length} more character${
                MIN_PASSWORD_LENGTH - next.length === 1 ? '' : 's'
              } to go.`}
            </p>
          )}
          {error != null && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  )
}

/**
 * The admin account's own screen: the address it signs in with, and the
 * password behind it.
 *
 * Both forms take the CURRENT password and neither is a formality. A session
 * cookie is enough to read everything this install holds; it is deliberately
 * not enough to change what recovers the account, because those are different
 * risks — one needs the browser, the other needs the secret.
 *
 * `onEmailChanged` exists because the header renders the email from `App`'s
 * session state, which this screen has just made stale. Re-reading the
 * session is one request and keeps one source of truth, rather than
 * threading a setter for a value the server already returns.
 */
export function Profile(props: {
  client: ApiClient
  email: string | null
  onEmailChanged: () => void
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <h1 className="font-semibold text-xl">Profile</h1>
      <EmailForm client={props.client} email={props.email} onChanged={props.onEmailChanged} />
      <PasswordForm client={props.client} />
    </div>
  )
}
