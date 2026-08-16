import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { Segments } from './Segments.js'

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

const SEG = {
  id: 3,
  name: 'Paying customers',
  ast_version: 1,
  filter: { kind: 'trait', key: 'plan', operator: 'eq', value: 'paid' },
  stale: false,
  last_count: null,
  last_evaluated_at: null,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}

function renderList(segments: unknown[]) {
  const client = { segments: vi.fn(async () => segments) } as unknown as ApiClient
  render(
    <MemoryRouter>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Segments client={client} />
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

// `vi.setSystemTime()` is a no-op without `vi.useFakeTimers()` -- any test
// pinning a relative time needs both, or the assertion depends on real
// wall-clock time and passes or fails by accident. `shouldAdvanceTime: true`
// matches `Funnels.test.tsx`'s own fake-timer setup: the fake clock still
// ticks in real time from the pinned instant, which is what lets
// `findByRole`'s internal polling (built on `setTimeout`) ever resolve.
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('Segments list', () => {
  it('shows the cached count beside when it was evaluated', async () => {
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'))
    renderList([{ ...SEG, last_count: 1284, last_evaluated_at: '2026-08-16T11:58:00.000Z' }])
    const row = await screen.findByRole('link', { name: /Paying customers/ })
    // `toHaveTextContent` on `row` matches the
    // concatenated text of every descendant, so asserting both substrings
    // against `row` only proves they both appear somewhere in the row --
    // splitting them into two sibling spans left this green. Scoping to
    // the single element that actually holds both (`data-testid`) is what
    // pins "same element", which is the rule this test exists to check: a
    // cache rendered away from its timestamp is a stale number that looks
    // current.
    const countEl = within(row).getByTestId('segment-count')
    expect(countEl).toHaveTextContent('1,284')
    expect(countEl).toHaveTextContent('2 minutes ago')
  })

  it('says a never-evaluated segment has not been evaluated, rather than showing 0', async () => {
    renderList([{ ...SEG, last_count: null, last_evaluated_at: null }])
    const row = await screen.findByRole('link', { name: /Paying customers/ })
    expect(row).toHaveTextContent(/not evaluated yet/i)
    expect(row).not.toHaveTextContent(/\b0\b/)
  })

  it('marks a stale segment instead of rendering an empty tree', async () => {
    renderList([{ ...SEG, stale: true }])
    expect(await screen.findByText(/cannot be read/i)).toBeInTheDocument()
  })

  it('offers the builder when there are no segments', async () => {
    renderList([])
    // The "Create segment" link renders
    // unconditionally, outside every conditional branch -- asserting only
    // its presence passes whether the empty branch works, renders nothing,
    // or even renders a stray row. This now also pins the empty-state copy
    // and that zero rows render, so a broken empty branch fails here.
    expect(await screen.findByRole('link', { name: /create.*segment/i })).toBeInTheDocument()
    expect(await screen.findByText(/no segments yet/i)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Paying customers/ })).toBeNull()
    expect(screen.queryByRole('list')).toBeNull()
  })
})

// Mirrors `Funnels.test.tsx`'s own pair: distinguishes a genuine `activeId`
// read from a hardcoded literal by switching the active project to an id a
// hardcoded call cannot produce.
describe('Segments list — active project', () => {
  it('requests segments for the active project', async () => {
    const client = { segments: vi.fn(async () => [SEG]) } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Segments client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('link', { name: /Paying customers/ })
    expect(client.segments).toHaveBeenCalledWith(1)
  })

  it('re-requests for the newly active project, not a fixed id', async () => {
    const client = { segments: vi.fn(async () => [SEG]) } as unknown as ApiClient
    const projects = [
      ...PROJECTS,
      {
        id: 2,
        name: 'Beta',
        slug: 'beta',
        created_at: '',
        retention_months: 24,
        monthly_event_quota: null,
      },
    ]
    const view = render(
      <MemoryRouter>
        <ProjectProvider projects={projects} initialId={1}>
          <Segments client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(client.segments).toHaveBeenCalledWith(1))

    view.rerender(
      <MemoryRouter>
        <ProjectProvider projects={projects} initialId={2}>
          <Segments client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(client.segments).toHaveBeenCalledWith(2))
  })
})

describe('Segments list — unauthorized', () => {
  it('calls onUnauthorized on a 401 from the segments fetch, not the generic error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = {
      segments: vi.fn(async () => {
        throw new ApiError(401, 'invalid_session')
      }),
    } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Segments client={client} onUnauthorized={onUnauthorized} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows an error instead of hanging forever when the segments fetch fails for any other reason', async () => {
    const client = {
      segments: vi.fn(async () => {
        throw new Error('boom')
      }),
    } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Segments client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByRole('alert')).toBeInTheDocument()
  })
})

// Proves the time pin actually pins something: with `formatRelative`'s
// minute threshold widened, "2 minutes ago" would instead read "just now",
// and this test is the one that would notice.
describe('Segments list — pin proof', () => {
  it('is sensitive to the relative-time threshold, not just present', async () => {
    vi.setSystemTime(new Date('2026-08-16T12:00:00.000Z'))
    renderList([{ ...SEG, last_count: 1284, last_evaluated_at: '2026-08-16T11:58:00.000Z' }])
    const row = await screen.findByRole('link', { name: /Paying customers/ })
    const countEl = within(row).getByTestId('segment-count')
    expect(countEl).not.toHaveTextContent('just now')
    expect(countEl).toHaveTextContent('2 minutes ago')
  })
})

// Invented mutation 1: a component that never calls the client at all --
// this is the stub check's own pin, kept as a real test rather than only a
// manual run, so a future edit that quietly reintroduces a hardcoded list
// fails CI instead of only failing when someone thinks to re-run the check
// by hand.
describe('Segments list — invented mutations', () => {
  it('never calls a fetch that names any other segment endpoint to freshen a row', async () => {
    const previewSavedSegment = vi.fn()
    const client = {
      segments: vi.fn(async () => [{ ...SEG, last_evaluated_at: null, last_count: null }]),
      previewSavedSegment,
    } as unknown as ApiClient
    render(
      <MemoryRouter>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Segments client={client} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await screen.findByRole('link', { name: /Paying customers/ })
    expect(previewSavedSegment).not.toHaveBeenCalled()
  })

  // Invented mutation 2: a row summarising `filter` via `summarise` even
  // when `stale` is true would throw on a tree shaped like this fixture
  // (`context`'s `scope`/`field` are absent from a plain `trait` shape once
  // mutated), or silently render an empty string -- either way it must not
  // reach `summarise` at all once `stale` is true.
  it('does not pass a stale filter to summarise even when the tree would parse', async () => {
    renderList([
      {
        ...SEG,
        stale: true,
        filter: { kind: 'trait', key: 'plan', operator: 'eq', value: 'paid' },
      },
    ])
    const row = await screen.findByRole('link', { name: /Paying customers/ })
    expect(row).toHaveTextContent(/cannot be read/i)
    expect(row).not.toHaveTextContent('plan eq paid')
  })
})
