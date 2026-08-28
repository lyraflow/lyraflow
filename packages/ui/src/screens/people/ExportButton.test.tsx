import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../../api/client.js'
import type { ApiClient } from '../../api/client.js'
import { EXPORT_MAX_EVENTS, ExportButton } from './ExportButton.js'

/** A partial client double -- only `personExport`, the one method this
 * component calls. Same discipline as every other screen test in this
 * package (`Segments.test.tsx`'s own doc comment). */
function makeClient(): ApiClient {
  return { personExport: vi.fn() } as unknown as ApiClient
}

function base(client: ApiClient) {
  return { client, projectId: 1, personId: 'u1' }
}

const user = userEvent.setup()

async function click(name: RegExp) {
  await user.click(screen.getByRole('button', { name }))
}

// jsdom implements neither of these -- production code needs both (create
// the object URL to download from, revoke it once the click has fired) and
// a test asserting the revoke actually happened needs a mock the assertion
// can tell apart from "never called", which a missing global cannot give
// it. Fresh `vi.fn()`s every test, not one shared across the file, so a
// call recorded by an earlier test can never be mistaken for this one's.
let createObjectURL: Mock
let revokeObjectURL: Mock
// The anchor the component builds is appended, clicked and removed in the
// same synchronous handler -- by the time an assertion runs, it is gone
// from the DOM. Spying on `click()` itself is the only point at which the
// anchor (and the `download` attribute already set on it) can still be
// read, and it doubles as the reason jsdom's own "not implemented:
// navigation" console noise never fires: the real click handler is
// replaced before jsdom ever tries to follow the `blob:` href. Individual
// tests below override this spy's implementation (e.g. to throw) --
// `vi.spyOn` on an already-spied method returns the same spy, so a later
// `mockImplementation` call inside a test body replaces only that test's
// behaviour, not the next test's fresh `beforeEach` spy.
let lastAnchor: HTMLAnchorElement | null

beforeEach(() => {
  createObjectURL = vi.fn(() => 'blob:mock-url')
  revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
  lastAnchor = null
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    lastAnchor = this
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function anchorDownloadAttr(): string | null {
  return lastAnchor?.getAttribute('download') ?? null
}

describe('ExportButton', () => {
  it('downloads the export and revokes the object url', async () => {
    const client = makeClient()
    ;(client.personExport as Mock).mockResolvedValue(new Blob(['{"type":"person"}\n']))
    render(<ExportButton eventCount={10} {...base(client)} />)
    await click(/export/i)
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  // The test above rejects nothing -- `personExport` resolves and every
  // step after it succeeds, so it cannot tell a revoke that lives in the
  // `finally` apart from one that lives only in the success branch of
  // `.then()`. This test forces the failure to happen AFTER the object URL
  // already exists (the anchor's own `click()` throwing, the natural seam),
  // which is exactly the case the `finally` -- and not a plain `.then()` --
  // is for.
  it('still revokes the object url when the download step itself fails after the fetch succeeded', async () => {
    const client = makeClient()
    ;(client.personExport as Mock).mockResolvedValue(new Blob(['x']))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('click failed')
    })
    render(<ExportButton eventCount={10} {...base(client)} />)
    await click(/export/i)
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled())
    await waitFor(() => expect(screen.getByText(/could not be exported/i)).toBeInTheDocument())
    expect(revokeObjectURL).toHaveBeenCalled()
  })

  it('names the file after the person and the format', async () => {
    const client = makeClient()
    ;(client.personExport as Mock).mockResolvedValue(new Blob(['x']))
    render(<ExportButton eventCount={10} {...base(client)} personId="cem@example.com" />)
    await click(/export/i)
    await waitFor(() => expect(anchorDownloadAttr()).not.toBeNull())
    expect(anchorDownloadAttr()).toMatch(/\.ndjson$/)
  })

  it('still shows the button at exactly the ceiling -- only past it is the download withdrawn', () => {
    const client = makeClient()
    render(<ExportButton eventCount={EXPORT_MAX_EVENTS} {...base(client)} />)
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument()
    expect(screen.queryByText(/lyraflow persons export/)).toBeNull()
  })

  it('offers the CLI command instead of a download past the ceiling', () => {
    const client = makeClient()
    render(<ExportButton eventCount={EXPORT_MAX_EVENTS + 1} {...base(client)} />)
    expect(screen.queryByRole('button', { name: /export/i })).toBeNull()
    expect(screen.getByText(/lyraflow persons export/)).toBeInTheDocument()
    // `toLocaleString` formatted, matching `IdentityHeader`/`Timeline`'s own
    // counts elsewhere on this branch -- "50,000", not "50000".
    expect(
      screen.getByText(new RegExp(EXPORT_MAX_EVENTS.toLocaleString('en-US'))),
    ).toBeInTheDocument()
    // The client is never even asked -- the ceiling is enforced before any
    // network call, not by letting a doomed request run and fail.
    expect(client.personExport).not.toHaveBeenCalled()
  })

  it('reports a failed export without clearing the profile', async () => {
    const client = makeClient()
    ;(client.personExport as Mock).mockRejectedValue(new ApiError(503, 'unavailable'))
    render(<ExportButton eventCount={10} {...base(client)} />)
    await click(/export/i)
    expect(await screen.findByText(/could not be exported/i)).toBeInTheDocument()
    // The button itself is still there and clickable again -- a failed
    // export is not a dead end.
    expect(screen.getByRole('button', { name: /export/i })).toBeInTheDocument()
  })

  it('reports a 401 through onUnauthorized instead of the generic export error', async () => {
    const client = makeClient()
    ;(client.personExport as Mock).mockRejectedValue(new ApiError(401, 'unauthorized'))
    const onUnauthorized = vi.fn()
    render(<ExportButton eventCount={10} {...base(client)} onUnauthorized={onUnauthorized} />)
    await click(/export/i)
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    // A retry cannot fix an expired session -- the generic message would be
    // actively wrong advice here, so it must not appear.
    expect(screen.queryByText(/could not be exported/i)).toBeNull()
  })
})
