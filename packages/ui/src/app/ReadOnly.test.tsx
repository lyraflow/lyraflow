import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../api/client.js'
import { ReadOnlyProvider, useReadOnly } from './ReadOnly.js'

function Probe() {
  return <p>{useReadOnly() ? 'read-only' : 'writable'}</p>
}

const client = (meta: () => Promise<unknown>) => ({ meta: vi.fn(meta) }) as unknown as ApiClient

describe('ReadOnlyProvider', () => {
  it('reports read-only when /v1/meta says so', async () => {
    render(
      <ReadOnlyProvider client={client(async () => ({ version: '0.14.0', read_only: true }))}>
        <Probe />
      </ReadOnlyProvider>,
    )
    expect(await screen.findByText('read-only')).toBeInTheDocument()
  })

  it('reports writable when /v1/meta says read_only: false', async () => {
    const meta = vi.fn(async () => ({ version: '0.14.0', read_only: false }))
    render(
      <ReadOnlyProvider client={{ meta } as unknown as ApiClient}>
        <Probe />
      </ReadOnlyProvider>,
    )
    // Settle the read and the state update it causes before asserting.
    // Asserting as soon as `meta` was called would pass on the context's
    // writable default without the answer ever having been read.
    await act(async () => {
      await meta.mock.results[0]?.value
    })
    expect(screen.getByText('writable')).toBeInTheDocument()
  })

  // Only `read_only: true` hides anything. A body without the field -- a
  // server from before it existed -- is an ordinary writable install.
  it('stays writable when /v1/meta has no read_only field', async () => {
    const meta = vi.fn(async () => ({ version: '0.13.0' }))
    render(
      <ReadOnlyProvider client={{ meta } as unknown as ApiClient}>
        <Probe />
      </ReadOnlyProvider>,
    )
    await act(async () => {
      await meta.mock.results[0]?.value
    })
    expect(screen.getByText('writable')).toBeInTheDocument()
  })

  // A failed read leaves every control visible. The server still refuses a
  // write on a read-only install, so the cost of guessing wrong this way is a
  // 403 with its own message -- guessing the other way would hide every
  // control on an ordinary install whenever one request failed.
  it('stays writable when /v1/meta fails', async () => {
    const meta = vi.fn(async () => {
      throw new Error('network down')
    })
    render(
      <ReadOnlyProvider client={{ meta } as unknown as ApiClient}>
        <Probe />
      </ReadOnlyProvider>,
    )
    await act(async () => {
      await meta.mock.results[0]?.value.catch(() => {})
    })
    expect(screen.getByText('writable')).toBeInTheDocument()
  })

  it('is writable with no provider at all', () => {
    render(<Probe />)
    expect(screen.getByText('writable')).toBeInTheDocument()
  })
})
