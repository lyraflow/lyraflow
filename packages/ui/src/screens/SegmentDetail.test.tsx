import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { MemberRow, Segment, SegmentPreview } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { ROUTES, segmentEditPath, segmentPath } from '../app/Router.js'
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

const MEMBER: MemberRow = {
  person_id: 'person-1',
  first_seen: '2026-08-01T00:00:00.000Z',
  last_seen: '2026-08-10T00:00:00.000Z',
}

const MEMBER_2: MemberRow = {
  person_id: 'person-2',
  first_seen: '2026-08-02T00:00:00.000Z',
  last_seen: '2026-08-11T00:00:00.000Z',
}

function fakeClient(over: Record<string, unknown> = {}) {
  return {
    segment: vi.fn(async () => SEGMENT),
    previewSavedSegment: vi.fn(async () => PREVIEW),
    deleteSegment: vi.fn(async () => undefined),
    ...over,
  } as unknown as ApiClient & { segment: Mock; previewSavedSegment: Mock; deleteSegment: Mock }
}

function renderDetail(client: ApiClient = fakeClient(), id: number = SEGMENT.id) {
  return render(
    <MemoryRouter initialEntries={[segmentPath(id)]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route path="/segments/:id" element={<SegmentDetail client={client} />} />
          {/* Placeholders so a successful edit-link click or delete's own
           * navigation has somewhere to land, matching FunnelDetail.test.tsx's
           * own harness. */}
          <Route path="/segments/:id/edit" element={<p>segment edit</p>} />
          <Route path={ROUTES.segments} element={<p>segments list</p>} />
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

/** Navigates to another segment while the detail screen stays mounted --
 * the shape no fixture in this file had, since each renders one segment and
 * never leaves it. */
function GoToSegment(props: { id: number }) {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(segmentPath(props.id))}>
      go to segment {props.id}
    </button>
  )
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

  // Important 2 (fix round 1): the test above navigates to a segment that
  // ITSELF issues a replacement request (its own auto-preview) -- collapsing
  // `answerIdRef` and `requestIdRef` into one shared ref still passes it,
  // since the newer call's own `.finally` clears `previewing` regardless.
  // The case that distinguishes two counters from one is navigating to a
  // COSTLY segment: the fetch effect's `answerIdRef` bump still invalidates
  // the abandoned request's answer, but the auto-preview effect's own
  // `warnings.length > 0` guard means NO replacement request is ever
  // issued. Under a single shared ref, that abandoned request's `.finally`
  // would never fire (its captured id no longer matches), leaving Run
  // stuck disabled forever with nothing left in flight to clear it.
  it('re-enables Run when an abandoned request lands late after navigating to a costly segment that never auto-previews', async () => {
    const p7 = deferred<SegmentPreview>()
    const previewSavedSegment = vi.fn(() => p7.promise)
    const client = fakeClient({
      segment: vi.fn(async (_projectId: number, id: number) =>
        id === 7 ? { ...SEGMENT, id: 7 } : { ...SEGMENT, id: 9, filter: EVER_BEHAVIOUR },
      ),
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
    expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

    // Navigate to a COSTLY segment -- its own fetch resolves and its
    // warnings block the auto-preview effect, so no second request is ever
    // issued.
    await userEvent.click(screen.getByText('go'))
    await screen.findByText(/scans all history/i)
    expect(previewSavedSegment).toHaveBeenCalledTimes(1)

    // The abandoned request for segment 7 lands late -- discarded (it
    // answers a segment no longer on screen), but Run must re-enable.
    await act(async () => {
      p7.resolve({ ...PREVIEW, person_count: 111 })
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
    expect(screen.queryByTestId('segment-detail-count')).toBeNull()
  })

  // --- Task 8 fix round 1 (Important 1): the wiring between this screen and
  // `MemberList` -- the real `fetchPage` closure that actually calls
  // `previewSavedSegment` with `include`/`cursor`, defaults its optional
  // response fields, and routes a 401 -- had NO coverage. `MemberList.test.tsx`
  // only ever drives an injected fake `fetchPage`; nothing here ever clicked
  // "Show people". These three exercise the real client fake through the real
  // closure, which is the only thing that can catch a defect in the JOIN
  // between the two components rather than in either one alone.

  it('clicking "Show people" calls previewSavedSegment with the project/segment ids and include:[members]', async () => {
    const previewSavedSegment = vi.fn(
      async (
        _projectId: number,
        _id: number,
        options?: { include?: string[]; cursor?: string },
      ) => {
        if (options?.include == null) return PREVIEW
        return { ...PREVIEW, members: [MEMBER], next_cursor: null, window_exhausted: false }
      },
    )
    const client = fakeClient({ previewSavedSegment })
    renderDetail(client)
    // Wait for the auto-preview (the count-only call) to land first, so the
    // second call below is unambiguously the member fetch.
    await screen.findByTestId('segment-detail-count')

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    await waitFor(() => expect(previewSavedSegment).toHaveBeenCalledTimes(2))
    expect(previewSavedSegment).toHaveBeenNthCalledWith(2, 1, SEGMENT.id, {
      include: ['members'],
      cursor: undefined,
    })
    expect(await screen.findByText(/that is everyone/i)).toBeInTheDocument()
  })

  it('clicking "Load more" sends the PREVIOUS page\'s cursor -- not undefined, and not the first page repeated', async () => {
    const page1 = {
      ...PREVIEW,
      members: [MEMBER],
      next_cursor: 'cursor-1',
      window_exhausted: false,
    }
    const page2 = { ...PREVIEW, members: [MEMBER_2], next_cursor: null, window_exhausted: false }
    const previewSavedSegment = vi.fn(
      async (
        _projectId: number,
        _id: number,
        options?: { include?: string[]; cursor?: string },
      ) => {
        if (options?.include == null) return PREVIEW
        return options.cursor == null ? page1 : page2
      },
    )
    const client = fakeClient({ previewSavedSegment })
    renderDetail(client)
    await screen.findByTestId('segment-detail-count')

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    const loadMore = await screen.findByRole('button', { name: /load more/i })
    await waitFor(() => expect(previewSavedSegment).toHaveBeenCalledTimes(2))

    await userEvent.click(loadMore)
    await waitFor(() => expect(previewSavedSegment).toHaveBeenCalledTimes(3))
    expect(previewSavedSegment).toHaveBeenNthCalledWith(3, 1, SEGMENT.id, {
      include: ['members'],
      cursor: 'cursor-1',
    })
    // Both pages' rows are on screen -- the second call actually resumed the
    // walk rather than re-fetching (or fetching nothing at) the first page.
    expect(await screen.findByText('person-2')).toBeInTheDocument()
    expect(screen.getByText('person-1')).toBeInTheDocument()
  })

  it("routes a 401 on a member page fetch to onUnauthorized, same as the screen's other fetches", async () => {
    const onUnauthorized = vi.fn()
    const previewSavedSegment = vi.fn(
      async (
        _projectId: number,
        _id: number,
        options?: { include?: string[]; cursor?: string },
      ) => {
        if (options?.include == null) return PREVIEW
        throw new ApiError(401, 'unauthorized')
      },
    )
    const client = fakeClient({ previewSavedSegment })
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
    await screen.findByTestId('segment-detail-count')

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
  })
})

// --- Task 9: Edit link and delete-behind-confirmation. Rename/tree-update
// themselves live on `SegmentBuilder` (its own "Task 9" describe block in
// `SegmentBuilder.test.tsx`) -- this file only covers what THIS screen owns:
// linking to the edit route, and never calling `deleteSegment` before an
// explicit second click confirms it.

describe('SegmentDetail -- Task 9: edit link and delete', () => {
  it('links Edit to the segment edit route', async () => {
    renderDetail()
    const edit = await screen.findByRole('link', { name: /^edit$/i })
    expect(edit).toHaveAttribute('href', segmentEditPath(SEGMENT.id))
  })

  it('a stale segment gets no Edit link, but is still deletable', async () => {
    const client = fakeClient({ segment: vi.fn(async () => ({ ...SEGMENT, stale: true })) })
    renderDetail(client)
    await screen.findByText(/cannot be read/i)
    expect(screen.queryByRole('link', { name: /^edit$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })

  it('clicking Delete asks for confirmation first -- deleteSegment is not called before it', async () => {
    const client = fakeClient()
    renderDetail(client)
    await screen.findByText('Paying customers')
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(screen.getByText(/delete this segment/i)).toBeInTheDocument()
    // The assertion that matters is on the REQUEST -- a screen that shows
    // the confirmation panel but fires the delete anyway must still fail
    // this.
    expect(client.deleteSegment).not.toHaveBeenCalled()
  })

  it('Cancel dismisses the confirmation without ever calling deleteSegment', async () => {
    const client = fakeClient()
    renderDetail(client)
    await screen.findByText('Paying customers')
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByText(/delete this segment/i)).toBeNull()
    expect(client.deleteSegment).not.toHaveBeenCalled()
    // The original Delete button is back, not stuck hidden behind a
    // confirmation state that never resets.
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
  })

  it('confirming calls deleteSegment with the project/segment ids and navigates to the list', async () => {
    const client = fakeClient()
    renderDetail(client)
    await screen.findByText('Paying customers')
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^delete segment$/i }))
    await waitFor(() => expect(client.deleteSegment).toHaveBeenCalledWith(1, SEGMENT.id))
    expect(await screen.findByText('segments list')).toBeInTheDocument()
  })

  it('a failed delete shows its own error, distinct from the count/warning banner, and does not navigate', async () => {
    const client = fakeClient({
      deleteSegment: vi.fn(async () => {
        throw new ApiError(500, 'server_error')
      }),
    })
    renderDetail(client)
    await screen.findByText('Paying customers')
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^delete segment$/i }))
    expect(await screen.findByText(/could not delete this segment/i)).toBeInTheDocument()
    expect(screen.queryByText('segments list')).toBeNull()
  })

  it('routes a 401 on delete to onUnauthorized rather than an error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      deleteSegment: vi.fn(async () => {
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
    await screen.findByText('Paying customers')
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^delete segment$/i }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// --- The count's own instant, and the people underneath it. Both are about
// the same thing: this screen showing two facts from two different moments
// with nothing saying so.

describe('SegmentDetail -- what instant the number is from', () => {
  it('renders the instant the count was computed at, beside the count', async () => {
    // A preview can be served from the server's cache up to its TTL, and
    // the response deliberately reports the STORED `as_of` on a hit so a
    // client can say so -- a bare number cannot be told apart from a live
    // one. Pinned by VALUE, two hours after `PREVIEW.as_of`, so a render
    // that reached for `new Date()` instead of the response's own field
    // reads "just now" and fails here.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.setSystemTime(new Date('2026-08-16T02:00:00.000Z'))
      renderDetail()
      expect(await screen.findByTestId('segment-detail-count')).toHaveTextContent('42')
      const asOf = screen.getByTestId('segment-detail-as-of')
      expect(asOf).toHaveTextContent('2 hours ago')
      expect(asOf).not.toHaveTextContent('just now')
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-running the count clears the people below it, rather than leaving the previous run on screen', async () => {
    // `MemberList` keyed on the segment id alone did not remount when Run
    // replaced the count, so the count above and the people below came from
    // different runs with nothing distinguishing them. Each member fetch
    // below is tagged with the run it belongs to, which is the only way to
    // tell "the previous run's rows are still here" from "the same rows
    // were legitimately fetched again".
    let run = 0
    const previewSavedSegment = vi.fn(
      async (
        _projectId: number,
        _id: number,
        options?: { include?: string[]; cursor?: string },
      ) => {
        if (options?.include == null) {
          run += 1
          return { ...PREVIEW, person_count: 40 + run }
        }
        return {
          ...PREVIEW,
          members: [{ ...MEMBER, person_id: `person-from-run-${run}` }],
          next_cursor: null,
          window_exhausted: false,
        }
      },
    )
    const client = fakeClient({ previewSavedSegment })
    renderDetail(client)
    expect(await screen.findByTestId('segment-detail-count')).toHaveTextContent('41')

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    expect(await screen.findByText('person-from-run-1')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    await waitFor(() => expect(screen.getByTestId('segment-detail-count')).toHaveTextContent('42'))
    // Run 1's people are gone the instant run 2's count lands -- they are
    // not silently relabelled as belonging to it.
    expect(screen.queryByText('person-from-run-1')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /show people/i }))
    expect(await screen.findByText('person-from-run-2')).toBeInTheDocument()
  })
})

describe('SegmentDetail -- the segment an action belongs to', () => {
  it('a delete confirmation opened for one segment does not survive a navigation to another', async () => {
    // Deletion is the one action on this screen with no undo, which is why
    // it takes two clicks. Left standing across a navigation the panel
    // stayed open and simply re-aimed: the second click, the one treated as
    // the operator's explicit consent, deleted whichever segment was now in
    // the URL. Asserted on the REQUEST as well as the panel, because a
    // screen that hides the panel but keeps the state would pass a
    // presence-only test.
    const client = fakeClient({
      segment: vi.fn(async (_projectId: number, id: number) => ({
        ...SEGMENT,
        id,
        name: `Segment ${id}`,
      })),
    })
    render(
      <MemoryRouter initialEntries={[segmentPath(SEGMENT.id)]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <GoToSegment id={8} />
          <Routes>
            <Route path="/segments/:id" element={<SegmentDetail client={client} />} />
            <Route path={ROUTES.segments} element={<p>segments list</p>} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByText('Segment 7')
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))
    expect(screen.getByText(/delete this segment\?/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /go to segment 8/i }))
    await screen.findByText('Segment 8')
    expect(screen.queryByText(/delete this segment\?/i)).toBeNull()
    expect(screen.queryByRole('button', { name: /^delete segment$/i })).toBeNull()
    expect(client.deleteSegment).not.toHaveBeenCalled()
  })
})
