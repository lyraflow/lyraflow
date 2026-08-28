import { AST_VERSION } from '@lyraflow/core/segments/ast.js'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '../../api/client.js'
import type { MemberRow, SegmentPreview } from '../../api/types.js'
import { TraitSearch } from './TraitSearch.js'
import { personPath, traitSearchPath } from './params.js'

/** Only the methods `TraitForm`/`MemberList` actually reach, cast rather
 * than stubbed whole -- same convention `TraitForm.test.tsx`'s own
 * `fakeClient` uses. Every test needs `schemaProperties` (the trait-name
 * field fetches on mount) even when it never touches the value box. */
function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    schemaProperties: vi.fn(async () => []),
    schemaTraitValues: vi.fn(async () => []),
    previewSegment: vi.fn(async (): Promise<SegmentPreview> => emptyPreview()),
    ...overrides,
  } as unknown as ApiClient
}

function emptyPreview(): SegmentPreview {
  return {
    person_count: 0,
    warnings: [],
    as_of: '2026-08-28T00:00:00.000Z',
    members: [],
    next_cursor: null,
    window_exhausted: false,
  }
}

function member(over: Partial<MemberRow> = {}): MemberRow {
  return {
    person_id: 'u1',
    first_seen: '2026-08-01T00:00:00.000Z',
    last_seen: '2026-08-10T00:00:00.000Z',
    identified: true,
    traits: {},
    traits_num: {},
    trait_total: 0,
    ...over,
  }
}

function renderSearch(client: ApiClient, path = '/people') {
  render(
    <MemoryRouter initialEntries={[path]}>
      <TraitSearch client={client} projectId={1} />
    </MemoryRouter>,
  )
}

describe('TraitSearch', () => {
  it('posts the exact one-node trait filter on submit -- not merely that a preview was requested', async () => {
    // The AST test named in the brief: asserting `previewSegment` was
    // called at all would pass for a wrong key, a wrong operator, or a
    // value that never made it into the request. This pins the whole
    // shape.
    const previewSegment = vi.fn(async (): Promise<SegmentPreview> => emptyPreview())
    const client = fakeClient({ previewSegment })
    renderSearch(client)

    const user = userEvent.setup()
    await user.type(screen.getByRole('combobox', { name: /^trait$/i }), 'internal_user_id')
    await user.type(screen.getByRole('combobox', { name: /^value$/i }), 'abc-123')
    await user.click(screen.getByRole('button', { name: /^search$/i }))

    await waitFor(() => expect(previewSegment).toHaveBeenCalled())
    expect(previewSegment).toHaveBeenCalledWith(
      1,
      {
        ast_version: AST_VERSION,
        filter: { kind: 'trait', key: 'internal_user_id', operator: '=', value: 'abc-123' },
      },
      { include: ['members'], cursor: undefined },
    )
  })

  it('does not search until Search is pressed, and the button is disabled until a key is typed', () => {
    const client = fakeClient()
    renderSearch(client)
    expect(screen.getByRole('button', { name: /^search$/i })).toBeDisabled()
    expect(client.previewSegment).not.toHaveBeenCalled()
  })

  it('renders a match as a member row linking to that person’s profile', async () => {
    const previewSegment = vi.fn(
      async (): Promise<SegmentPreview> => ({
        ...emptyPreview(),
        person_count: 1,
        members: [member({ person_id: 'cem@example.com' })],
      }),
    )
    const client = fakeClient({ previewSegment })
    const path = traitSearchPath({ kind: 'trait', key: 'plan', operator: '=', value: 'pro' })
    renderSearch(client, path)

    const link = await screen.findByRole('link', { name: /cem@example\.com/ })
    expect(link).toHaveAttribute('href', personPath('cem@example.com'))
  })

  it('says a no-match search found no one, in MemberList’s own voice, not as an error', async () => {
    const previewSegment = vi.fn(async (): Promise<SegmentPreview> => emptyPreview())
    const client = fakeClient({ previewSegment })
    const path = traitSearchPath({
      kind: 'trait',
      key: 'ghost_trait',
      operator: '=',
      value: 'nope',
    })
    renderSearch(client, path)

    expect(await screen.findByTestId('member-list-end')).toHaveTextContent(
      /that is everyone who matches/i,
    )
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('survives a reload -- a fresh mount at the search URL alone reproduces the search and its result', async () => {
    // Not "the search runs" (which a plain default state could also
    // satisfy) -- this asserts the request that a FRESH mount issues, with
    // no prior interaction, matches exactly what the URL names, and that
    // the fields on screen were populated FROM the address bar rather than
    // left at their defaults beside a result that just happens to render.
    const previewSegment = vi.fn(
      async (): Promise<SegmentPreview> => ({
        ...emptyPreview(),
        person_count: 1,
        members: [member({ person_id: 'u9' })],
      }),
    )
    const client = fakeClient({ previewSegment })
    const path = traitSearchPath({
      kind: 'trait',
      key: 'internal_user_id',
      operator: '=',
      value: 'reload-me',
    })
    renderSearch(client, path)

    expect(screen.getByRole('combobox', { name: /^trait$/i })).toHaveValue('internal_user_id')
    expect(screen.getByRole('combobox', { name: /^value$/i })).toHaveValue('reload-me')

    await waitFor(() => expect(previewSegment).toHaveBeenCalled())
    expect(previewSegment).toHaveBeenCalledWith(
      1,
      {
        ast_version: AST_VERSION,
        filter: { kind: 'trait', key: 'internal_user_id', operator: '=', value: 'reload-me' },
      },
      { include: ['members'], cursor: undefined },
    )
    expect(await screen.findByText('u9')).toBeInTheDocument()
  })
})
