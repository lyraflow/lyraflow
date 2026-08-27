import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { AboutSection } from './AboutSection.js'

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    meta: vi.fn(async () => ({ version: '0.10.0' })),
    ...over,
  } as unknown as ApiClient
}

/** A promise the test resolves, so "before the answer arrives" is a real state. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('AboutSection', () => {
  it('shows the version the server reports', async () => {
    render(<AboutSection client={fakeClient()} />)
    expect(await screen.findByText('0.10.0')).toBeInTheDocument()
  })

  // The card must not render a confident-looking blank where the version
  // goes. An empty value beside the label "Version" reads as "this install
  // has no version", which is a worse answer than "not yet loaded".
  it('shows a placeholder rather than an empty value before the answer arrives', async () => {
    const d = deferred<{ version: string }>()
    render(<AboutSection client={fakeClient({ meta: vi.fn(() => d.promise) })} />)
    expect(screen.getByTestId('install-version-loading')).toBeInTheDocument()
    d.resolve({ version: '0.10.0' })
    expect(await screen.findByText('0.10.0')).toBeInTheDocument()
    expect(screen.queryByTestId('install-version-loading')).not.toBeInTheDocument()
  })

  // A 401 means the session is gone, and this screen has to route back to
  // login the way `Feed` and `ProjectsSection` do. Reporting it as the
  // generic error below instead would read as a transient hiccup forever,
  // with no way back.
  it('reports a 401 as a lost session, not as a failed fetch', async () => {
    const onUnauthorized = vi.fn()
    render(
      <AboutSection
        client={fakeClient({
          meta: vi.fn(async () => Promise.reject(new ApiError(401, 'invalid_session'))),
        })}
        onUnauthorized={onUnauthorized}
      />,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says the version could not be read rather than leaving the card blank', async () => {
    render(
      <AboutSection
        client={fakeClient({ meta: vi.fn(async () => Promise.reject(new Error('offline'))) })}
      />,
    )
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })

  // The release notes for THIS version, not the releases index -- the whole
  // reason to read the number is to find out what shipped in it.
  it('links to the release notes for the version it just showed', async () => {
    render(<AboutSection client={fakeClient()} />)
    const link = await screen.findByRole('link', { name: /release notes/i })
    expect(link).toHaveAttribute(
      'href',
      'https://github.com/lyraflow/lyraflow/releases/tag/v0.10.0',
    )
  })

  /**
   * Without `noreferrer` the outbound request carries this page's URL, which
   * on a self-hosted install is the operator's own hostname -- private
   * infrastructure, and not GitHub's to learn. `Shell.tsx`'s `StarOnGitHub`
   * makes the same argument for the same reason; a second outbound link on
   * an authenticated screen needs the same guard, pinned separately, since
   * nothing structural ties the two.
   */
  it('does not leak the install hostname to GitHub through the referrer', async () => {
    render(<AboutSection client={fakeClient()} />)
    const link = await screen.findByRole('link', { name: /release notes/i })
    expect(link.getAttribute('rel')).toContain('noreferrer')
    expect(link.getAttribute('rel')).toContain('noopener')
  })

  // Nothing about the version depends on which project is selected, and the
  // fetch is keyed accordingly. A card that refetched on every project
  // switch would be asking the server to re-confirm a constant.
  it('does not refetch when re-rendered', async () => {
    const client = fakeClient()
    const { rerender } = render(<AboutSection client={client} />)
    expect(await screen.findByText('0.10.0')).toBeInTheDocument()
    rerender(<AboutSection client={client} />)
    await waitFor(() =>
      expect((client.meta as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1),
    )
  })
})
