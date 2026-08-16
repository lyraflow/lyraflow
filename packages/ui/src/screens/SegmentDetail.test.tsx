import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Segment, SegmentPreview } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { ROUTES, segmentPath } from '../app/Router.js'
import { SegmentDetail } from './SegmentDetail.js'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
  },
]

const TREE: FilterNode = {
  kind: 'group',
  op: 'and',
  children: [{ kind: 'trait', key: 'plan', operator: '=', value: 'pro' }],
}

const EVER_BEHAVIOUR: FilterNode = {
  kind: 'group',
  op: 'and',
  children: [
    {
      kind: 'behavior',
      event: 'import_started',
      aggregate: 'count',
      window: { kind: 'ever' },
      operator: '>=',
      value: 1,
    },
  ],
}

const SEGMENT: Segment = {
  id: 7,
  name: 'Paying customers',
  ast_version: 1,
  filter: TREE,
  stale: false,
  last_count: 12,
  last_evaluated_at: '2026-08-15T00:00:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}

const PREVIEW: SegmentPreview = {
  person_count: 42,
  warnings: [],
  as_of: '2026-08-16T00:00:00.000Z',
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    segment: vi.fn(async () => SEGMENT),
    previewSavedSegment: vi.fn(async () => PREVIEW),
    ...over,
  } as unknown as ApiClient & { segment: Mock; previewSavedSegment: Mock }
}

function renderDetail(client: ApiClient = fakeClient(), id: number = SEGMENT.id) {
  return render(
    <MemoryRouter initialEntries={[segmentPath(id)]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route path="/segments/:id" element={<SegmentDetail client={client} />} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
}

/** A deferred promise a test can settle on its own schedule (mirrors
 * `FunnelDetail.test.tsx`'s own `deferred`). */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('SegmentDetail', () => {
  it('shows the segment name and filter summary', async () => {
    renderDetail()
    expect(await screen.findByText('Paying customers')).toBeInTheDocument()
    expect(screen.getByText(/plan = pro/i)).toBeInTheDocument()
  })

  it('a stale segment shows the read-only error and never previews', async () => {
    const client = fakeClient({ segment: vi.fn(async () => ({ ...SEGMENT, stale: true })) })
    renderDetail(client)
    expect(await screen.findByText(/cannot be read/i)).toBeInTheDocument()
    expect(client.previewSavedSegment).not.toHaveBeenCalled()
  })

  it('routes a 401 on the segment fetch to onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      segment: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    render(
      <MemoryRouter initialEntries={[segmentPath(SEGMENT.id)]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path="/segments/:id"
              element={<SegmentDetail client={client} onUnauthorized={onUnauthorized} />}
            />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // --- Task 7: live counts, the read-only side. Cheap auto-previews the
  // instant the segment is known; a cost warning waits for an explicit Run.

  it('auto-previews a cheap saved segment on open', async () => {
    const client = fakeClient()
    renderDetail(client)
    await waitFor(() => expect(client.previewSavedSegment).toHaveBeenCalledTimes(1))
    expect(client.previewSavedSegment).toHaveBeenCalledWith(1, SEGMENT.id)
    expect(await screen.findByTestId('segment-detail-count')).toHaveTextContent('42')
  })

  it('does not auto-preview a segment carrying a cost warning, and says why', async () => {
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: EVER_BEHAVIOUR })),
    })
    renderDetail(client)
    expect(await screen.findByText(/scans all history/i)).toBeInTheDocument()
    expect(client.previewSavedSegment).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
    expect(screen.queryByTestId('segment-detail-count')).toBeNull()
  })

  it('clicking Run on a costly segment fetches the count explicitly', async () => {
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: EVER_BEHAVIOUR })),
    })
    renderDetail(client)
    await screen.findByText(/scans all history/i)
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await waitFor(() => expect(client.previewSavedSegment).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('segment-detail-count')).toHaveTextContent('42')
  })

  // Step 5's invariant on the read-only screen: switching to a different
  // segment mid-flight (the mount effect firing again for a new `:id`, the
  // exact same shape `FunnelDetail.test.tsx` exercises for funnels) must
  // discard a still-open response for the segment navigated away from, and
  // must not leave Run stuck disabled.
  it('discards a stale preview for a segment navigated away from, and Run stays usable', async () => {
    const p7 = deferred<SegmentPreview>()
    const p9 = deferred<SegmentPreview>()
    const previewSavedSegment = vi.fn((_projectId: number, id: number) =>
      id === 7 ? p7.promise : p9.promise,
    )
    const client = fakeClient({
      segment: vi.fn(async (_projectId: number, id: number) => ({ ...SEGMENT, id })),
      previewSavedSegment,
    })

    function Nav(props: { to: string }) {
      const navigate = useNavigate()
      return (
        <button type="button" onClick={() => navigate(props.to)}>
          go
        </button>
      )
    }

    render(
      <MemoryRouter initialEntries={[segmentPath(7)]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path="/segments/:id"
              element={
                <>
                  <SegmentDetail client={client} />
                  <Nav to="/segments/9" />
                </>
              }
            />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(previewSavedSegment).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByText('go'))
    await waitFor(() => expect(previewSavedSegment).toHaveBeenCalledTimes(2))

    // The NEWER segment's own auto-preview lands first.
    await act(async () => {
      p9.resolve({ ...PREVIEW, person_count: 999 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(await screen.findByTestId('segment-detail-count')).toHaveTextContent('999')

    // The OLDER segment's response lands late -- discarded outright, and
    // Run must not be stuck disabled by a `.finally` that thinks it was the
    // most recent call.
    await act(async () => {
      p7.resolve({ ...PREVIEW, person_count: 111 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId('segment-detail-count')).toHaveTextContent('999')
    expect(screen.queryByText('111')).toBeNull()
    expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
  })
})
