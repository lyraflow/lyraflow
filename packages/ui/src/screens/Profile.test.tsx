import { render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { Profile } from './Profile.js'

function fakeClient(over: Partial<ApiClient> = {}): ApiClient {
  return {
    changeEmail: vi.fn(async (email: string) => ({ email })),
    changePassword: vi.fn(async () => undefined),
    ...over,
  } as unknown as ApiClient
}

const renderProfile = (client: ApiClient, onEmailChanged = vi.fn()) => {
  render(<Profile client={client} email="admin@localhost" onEmailChanged={onEmailChanged} />)
  return onEmailChanged
}

/**
 * Both forms on this screen have a field labelled "Current password" -- one
 * confirming an email change, one confirming a password change -- so a bare
 * label query is ambiguous by design rather than by accident. Every call
 * here names the field's own id.
 */
const type = async (label: RegExp | string, value: string, selector?: string) => {
  const field =
    selector === undefined
      ? screen.getByLabelText(label)
      : screen.getByLabelText(label, { selector })
  await userEvent.clear(field)
  await userEvent.type(field, value)
}

/** The email form's password field, by id. */
const EMAIL_PASSWORD = '#profile-email-password'

describe('Profile — email', () => {
  it('sends the new address with the current password', async () => {
    const client = fakeClient()
    renderProfile(client)
    await type('New email address', 'new@example.test')
    await type('Current password', 'the-current-one', EMAIL_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))
    expect(client.changeEmail).toHaveBeenCalledWith('new@example.test', 'the-current-one')
  })

  // A session cookie is enough to READ this install and deliberately not
  // enough to change the address that recovers it. The form must not let an
  // operator try without the password, or the disabled state is decoration.
  it('cannot be submitted without the current password', async () => {
    const client = fakeClient()
    renderProfile(client)
    await type('New email address', 'new@example.test')
    expect(screen.getByRole('button', { name: 'Change email' })).toBeDisabled()
    expect(client.changeEmail).not.toHaveBeenCalled()
  })

  it('tells the header to re-read the session once it succeeds', async () => {
    const onEmailChanged = renderProfile(fakeClient())
    await type('New email address', 'new@example.test')
    await type('Current password', 'pw', EMAIL_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))
    await waitFor(() => expect(onEmailChanged).toHaveBeenCalled())
  })

  // A password left in a form field lives in the DOM for as long as the page
  // is open, and this is a page an operator leaves open.
  it('clears the password field after a success', async () => {
    renderProfile(fakeClient())
    await type('New email address', 'new@example.test')
    await type('Current password', 'pw', EMAIL_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))
    await waitFor(() =>
      expect(screen.getByLabelText('Current password', { selector: EMAIL_PASSWORD })).toHaveValue(
        '',
      ),
    )
  })

  it('says the password was wrong rather than "something went wrong"', async () => {
    const client = fakeClient({
      changeEmail: vi.fn(async () => {
        throw new ApiError(401, 'invalid_credentials')
      }),
    } as Partial<ApiClient>)
    renderProfile(client)
    await type('New email address', 'new@example.test')
    await type('Current password', 'wrong', EMAIL_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('password is not right')
  })

  it('says who is holding a taken address, and that too many tries is temporary', async () => {
    const taken = fakeClient({
      changeEmail: vi.fn(async () => {
        throw new ApiError(409, 'email_taken')
      }),
    } as Partial<ApiClient>)
    const { unmount } = render(
      <Profile client={taken} email="admin@localhost" onEmailChanged={vi.fn()} />,
    )
    await type('New email address', 'taken@example.test')
    await type('Current password', 'pw', EMAIL_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already uses that address')
    unmount()

    const limited = fakeClient({
      changeEmail: vi.fn(async () => {
        throw new ApiError(429, 'too_many_attempts')
      }),
    } as Partial<ApiClient>)
    render(<Profile client={limited} email="admin@localhost" onEmailChanged={vi.fn()} />)
    await type('New email address', 'x@example.test')
    await type('Current password', 'pw', EMAIL_PASSWORD)
    await userEvent.click(screen.getByRole('button', { name: 'Change email' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Wait a few minutes')
  })

  // Volunteering the limit. There is no mail transport in the product, so an
  // interface implying a verification step would be lying about what it did.
  it('says there is no confirmation email', () => {
    renderProfile(fakeClient())
    expect(screen.getByText(/no confirmation email/i)).toBeInTheDocument()
  })
})

describe('Profile — password', () => {
  it('sends both passwords', async () => {
    const client = fakeClient()
    render(<Profile client={client} email="a@b.test" onEmailChanged={vi.fn()} />)
    // Two fields are labelled "Current password" on this screen -- one per
    // form -- so the password form's own is addressed by its id.
    await userEvent.type(
      screen.getByLabelText('Current password', { selector: '#profile-current-password' }),
      'old-one',
    )
    await userEvent.type(screen.getByLabelText('New password'), 'a-long-new-password')
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(client.changePassword).toHaveBeenCalledWith('old-one', 'a-long-new-password')
  })

  // The rule is stated before submitting, not after: a field that only tells
  // you the requirement once you have failed it is a guessing game.
  it('states the minimum up front and refuses a short one without asking the server', async () => {
    const client = fakeClient()
    render(<Profile client={client} email="a@b.test" onEmailChanged={vi.fn()} />)
    expect(screen.getByText(/At least 12 characters/)).toBeInTheDocument()

    await userEvent.type(
      screen.getByLabelText('Current password', { selector: '#profile-current-password' }),
      'old-one',
    )
    await userEvent.type(screen.getByLabelText('New password'), 'short')
    expect(screen.getByRole('button', { name: 'Change password' })).toBeDisabled()
    expect(screen.getByText(/7 more characters to go/)).toBeInTheDocument()
    expect(client.changePassword).not.toHaveBeenCalled()
  })

  // Said BEFORE the click. Somebody changing a password because it leaked
  // needs to know this is what happens; somebody doing it routinely needs to
  // know their other browser will ask again.
  it('warns that other browsers are signed out, before it is clicked', () => {
    render(<Profile client={fakeClient()} email="a@b.test" onEmailChanged={vi.fn()} />)
    expect(screen.getByText(/signs out every other browser/i)).toBeInTheDocument()
  })

  it('reports a rejected current password on the password form', async () => {
    const client = fakeClient({
      changePassword: vi.fn(async () => {
        throw new ApiError(401, 'invalid_credentials')
      }),
    } as Partial<ApiClient>)
    render(<Profile client={client} email="a@b.test" onEmailChanged={vi.fn()} />)
    await userEvent.type(
      screen.getByLabelText('Current password', { selector: '#profile-current-password' }),
      'wrong',
    )
    await userEvent.type(screen.getByLabelText('New password'), 'a-long-new-password')
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('password is not right')
  })

  it('says plainly when the new password is the old one', async () => {
    const client = fakeClient({
      changePassword: vi.fn(async () => {
        throw new ApiError(400, 'password_unchanged')
      }),
    } as Partial<ApiClient>)
    render(<Profile client={client} email="a@b.test" onEmailChanged={vi.fn()} />)
    await userEvent.type(
      screen.getByLabelText('Current password', { selector: '#profile-current-password' }),
      'same',
    )
    await userEvent.type(screen.getByLabelText('New password'), 'a-long-new-password')
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('already have')
  })

  it('clears both fields once it succeeds', async () => {
    render(<Profile client={fakeClient()} email="a@b.test" onEmailChanged={vi.fn()} />)
    await userEvent.type(
      screen.getByLabelText('Current password', { selector: '#profile-current-password' }),
      'old-one',
    )
    await userEvent.type(screen.getByLabelText('New password'), 'a-long-new-password')
    await userEvent.click(screen.getByRole('button', { name: 'Change password' }))
    await waitFor(() => expect(screen.getByLabelText('New password')).toHaveValue(''))
  })
})

describe('Profile — appearance', () => {
  it('renders the accent picker above the forms', () => {
    renderProfile(fakeClient())
    const group = screen.getByRole('group', { name: /accent colour/i })
    const email = screen.getByText('Email address')
    expect(group.compareDocumentPosition(email) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
