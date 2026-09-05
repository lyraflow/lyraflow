import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ShareCard, shareUrl } from './ShareCard.js'

const TOKEN = 'T'.repeat(43)
const SHARE = { token: TOKEN, shared_at: '2026-09-05T10:00:00.000Z' }

describe('shareUrl', () => {
  it('joins the origin and token under /shared/', () => {
    expect(shareUrl('https://a.test', TOKEN)).toBe(`https://a.test/shared/${TOKEN}`)
  })
})

describe('ShareCard', () => {
  it('before a link exists, lists what a link exposes and offers Create link', async () => {
    const onCreate = vi.fn()
    render(
      <ShareCard
        share={null}
        busy={false}
        error={null}
        origin="https://a.test"
        onCreate={onCreate}
        onRevoke={() => {}}
        onClose={() => {}}
      />,
    )
    for (const item of [
      'the dashboard and report names',
      'event names',
      'every breakdown value',
      'every filter value',
    ]) {
      expect(screen.getByText(new RegExp(item))).toBeInTheDocument()
    }
    await userEvent.click(screen.getByRole('button', { name: 'Create link' }))
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  it('with a link, shows the URL on this origin, copies it, and revokes after confirming', async () => {
    const write = vi.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText: write } })
    const onRevoke = vi.fn()
    render(
      <ShareCard
        share={SHARE}
        busy={false}
        error={null}
        origin="https://a.test"
        onCreate={() => {}}
        onRevoke={onRevoke}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Share link' })).toHaveValue(
      `https://a.test/shared/${TOKEN}`,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(write).toHaveBeenCalledWith(`https://a.test/shared/${TOKEN}`)
    expect(await screen.findByText('Copied')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Revoke link' }))
    expect(onRevoke).not.toHaveBeenCalled()
    expect(screen.getByText(/stops working on the next request/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(onRevoke).toHaveBeenCalledTimes(1)
  })

  it('shows when the link was shared', () => {
    render(
      <ShareCard
        share={SHARE}
        busy={false}
        error={null}
        origin="https://a.test"
        onCreate={() => {}}
        onRevoke={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText(/Shared since/)).toBeInTheDocument()
  })

  // The async Clipboard API is unavailable on a non-secure origin -- plain
  // HTTP over a private network is exactly what a self-hoster without a
  // certificate hits -- so there has to be a way to copy the link that does
  // not depend on it existing at all.
  it('falls back to selecting the text when the clipboard API is absent', async () => {
    // `navigator.clipboard` is read-only in jsdom by default; delete it so
    // the fallback branch -- not a thrown TypeError from `writeText` -- is
    // what this test actually exercises.
    // biome-ignore lint/performance/noDelete: test-only removal of a jsdom global
    delete (navigator as unknown as { clipboard?: unknown }).clipboard
    render(
      <ShareCard
        share={SHARE}
        busy={false}
        error={null}
        origin="https://a.test"
        onCreate={() => {}}
        onRevoke={() => {}}
        onClose={() => {}}
      />,
    )
    const input = screen.getByRole('textbox', { name: 'Share link' }) as HTMLInputElement
    const selectSpy = vi.spyOn(input, 'select')
    await userEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(selectSpy).toHaveBeenCalled()
    expect(await screen.findByText('Select and copy')).toBeInTheDocument()
  })

  it('disables Create, Copy and Revoke while busy, and shows the error', () => {
    render(
      <ShareCard
        share={SHARE}
        busy={true}
        error="Something went wrong. Reload to try again."
        origin="https://a.test"
        onCreate={() => {}}
        onRevoke={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Revoke link' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i)
  })

  it('disables Create while busy, before a link exists', () => {
    render(
      <ShareCard
        share={null}
        busy={true}
        error={null}
        origin="https://a.test"
        onCreate={() => {}}
        onRevoke={() => {}}
        onClose={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Create link' })).toBeDisabled()
  })

  it('closes via onClose', async () => {
    const onClose = vi.fn()
    render(
      <ShareCard
        share={null}
        busy={false}
        error={null}
        origin="https://a.test"
        onCreate={() => {}}
        onRevoke={() => {}}
        onClose={onClose}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
