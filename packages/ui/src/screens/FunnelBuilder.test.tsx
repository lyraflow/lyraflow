import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Funnel, FunnelRunResult } from '../api/types.js'
import { ProjectProvider } from '../app/ProjectContext.js'
import { ROUTES, funnelEditPath } from '../app/Router.js'
import { FunnelBuilder } from './FunnelBuilder.js'
import { FunnelDetail } from './FunnelDetail.js'

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

const FUNNEL: Funnel = {
  id: 7,
  name: 'Signup flow',
  definition_version: 1,
  steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
  window_seconds: 604800,
  segment_id: null,
  stale: false,
  last_entered: 1204,
  last_converted: 491,
  last_evaluated_at: '2026-08-15T11:58:00.000Z',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-01T00:00:00.000Z',
}

const RUN: FunnelRunResult = {
  entered: 1204,
  converted: 491,
  conversion_rate: 0.4078,
  partial_window_entrants: 312,
  range: { since: '2026-08-08T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' },
  as_of: '2026-08-15T11:58:00.000Z',
  warnings: [],
  steps: [
    { index: 1, event: 'page_view', people: 1204, from_previous: 1, from_start: 1 },
    {
      index: 2,
      event: 'signup_completed',
      people: 491,
      from_previous: 0.4078,
      from_start: 0.4078,
    },
  ],
}

function fakeBuilderClient(over: Record<string, unknown> = {}) {
  return {
    schemaEvents: vi.fn(async () => []),
    schemaProperties: vi.fn(async () => []),
    segments: vi.fn(async () => []),
    previewFunnel: vi.fn(async () => RUN),
    createFunnel: vi.fn(async () => ({ ...FUNNEL, id: 42 })),
    patchFunnel: vi.fn(async () => ({ ...FUNNEL, id: 42 })),
    funnel: vi.fn(async () => FUNNEL),
    ...over,
  } as unknown as ApiClient & {
    schemaEvents: Mock
    segments: Mock
    previewFunnel: Mock
    createFunnel: Mock
    patchFunnel: Mock
    funnel: Mock
  }
}

function renderBuilder(client: ApiClient = fakeBuilderClient(), editId?: number) {
  render(
    <MemoryRouter initialEntries={[editId != null ? funnelEditPath(editId) : ROUTES.funnelNew]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route path={ROUTES.funnelNew} element={<FunnelBuilder client={client} />} />
          <Route path="/funnels/:id/edit" element={<FunnelBuilder client={client} />} />
          {/* A successful CREATE navigates to the list route; a successful
           * EDIT navigates to this funnel's own detail route instead
           * (Task 6 fix round 1). This harness doesn't render the real
           * `Funnels`/`FunnelDetail` screens, just placeholders so React
           * Router has somewhere to land instead of logging "no routes
           * matched" -- the dedicated test below renders the real
           * `FunnelDetail` to check what an edit actually lands on. */}
          <Route path={ROUTES.funnels} element={<p>saved to list</p>} />
          <Route path="/funnels/:id" element={<p>saved to detail</p>} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
  return client
}

/** Step 1 = page_view, Step 2 = signup_completed, via the same "type, then
 * Add step, then type" sequence the brief's own first test exercises --
 * this screen starts with exactly one empty step. Deliberately touches
 * neither the name field nor the window/segment controls, so every test
 * using this keeps the default window (7 days = 604800s) and segment
 * (Everyone = null) unless it changes them itself. */
async function fillTwoSteps() {
  await userEvent.type(screen.getByLabelText('Step 1'), 'page_view')
  await userEvent.click(screen.getByRole('button', { name: /add step/i }))
  await userEvent.type(screen.getByLabelText('Step 2'), 'signup_completed')
}

describe('FunnelBuilder', () => {
  it('requires at least two steps before preview or save is possible', async () => {
    renderBuilder()
    await userEvent.type(await screen.findByLabelText(/name/i), 'Signup')
    await userEvent.type(screen.getByLabelText('Step 1'), 'page_view')
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: /add step/i }))
    await userEvent.type(screen.getByLabelText('Step 2'), 'signup_completed')
    expect(screen.getByRole('button', { name: /save/i })).toBeEnabled()
  })

  it('previews without saving', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.click(screen.getByRole('button', { name: /preview/i }))
    await screen.findByTestId('funnel-step-1')
    expect(client.previewFunnel).toHaveBeenCalledTimes(1)
    expect(client.createFunnel).not.toHaveBeenCalled()
  })

  it('sends a flat body: name alongside steps, not nested under definition', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.type(screen.getByLabelText(/name/i), 'Signup')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(client.createFunnel).toHaveBeenCalled())
    const call = client.createFunnel.mock.calls[0]
    if (!call) throw new Error('createFunnel was not called')
    const [, name, definition] = call
    expect(name).toBe('Signup')
    expect(definition).toMatchObject({
      steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
      window_seconds: 604800,
    })
  })

  it('renders every warning the PREVIEW returned, not only the detail screen', async () => {
    // The spec requires warnings on both surfaces. #21 is open in this repo
    // precisely because one entry point omitted warnings the other returned;
    // the funnel routes avoided it server-side by sharing one execute(), and
    // the UI must not reintroduce the asymmetry.
    const client = fakeBuilderClient({
      previewFunnel: vi.fn(async () => ({
        ...RUN,
        warnings: [
          { path: 'range', reason: 'alpha reason' },
          { path: 'segment', reason: 'beta reason' },
        ],
      })),
    })
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.click(screen.getByRole('button', { name: /preview/i }))
    expect(await screen.findByText('alpha reason')).toBeInTheDocument()
    expect(screen.getByText('beta reason')).toBeInTheDocument()
  })

  // I2 (whole-branch review): spec decision 2 -- "changing the range, OR
  // EDITING THE DEFINITION, does not re-run: the chart dims and a Run
  // control appears" -- applies to this screen too, and had no staleness
  // concept at all. Preview 40.8%, retype a step, and the old numbers
  // rendered undimmed as if they still answered what was on screen.
  it('dims the preview once the definition on screen no longer matches what was previewed', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.click(screen.getByRole('button', { name: /preview/i }))
    const box = await screen.findByTestId('builder-preview-result')
    expect(box).toHaveAttribute('data-stale', 'false')

    // Editing the definition -- retyping step 2 -- must dim it, without a
    // second preview call.
    await userEvent.type(screen.getByLabelText('Step 2'), '_v2')
    expect(screen.getByTestId('builder-preview-result')).toHaveAttribute('data-stale', 'true')
    expect(client.previewFunnel).toHaveBeenCalledTimes(1)

    // Re-previewing the NEW definition clears it again.
    await userEvent.click(screen.getByRole('button', { name: /preview/i }))
    await waitFor(() => expect(client.previewFunnel).toHaveBeenCalledTimes(2))
    expect(screen.getByTestId('builder-preview-result')).toHaveAttribute('data-stale', 'false')
  })

  // I3 (whole-branch review): spec §3 requires both `as_of` and the resolved
  // range on any rendered result "so a cached result can never be mistaken
  // for a live one" -- this preview showed neither.
  it('shows as_of and the resolved range on the preview, not just the numbers', async () => {
    // Stub-check gap (targeted re-review): a `formatRelative` hardcoded to
    // a constant string would still satisfy `not.toBeEmptyDOMElement()`.
    // Fake timers pin the actual value here -- deliberately a DIFFERENT
    // offset from FunnelDetail.test.tsx's "shows as_of by value" test
    // ("2 minutes ago"), so a stub hardcoded to THAT specific string
    // (plausible, since it's the value another test in this codebase pins)
    // cannot coincidentally satisfy this one too.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      vi.setSystemTime(new Date('2026-08-15T12:10:00.000Z'))
      const client = fakeBuilderClient()
      renderBuilder(client)
      await fillTwoSteps()
      await userEvent.click(screen.getByRole('button', { name: /preview/i }))
      expect(await screen.findByTestId('builder-preview-range')).toHaveTextContent('Last 7 days')
      expect(screen.getByTestId('builder-preview-as-of')).toHaveTextContent('12 minutes ago')
    } finally {
      vi.useRealTimers()
    }
  })

  // Stub-check gap (targeted re-review): every OTHER fixture in this file
  // resolves a 7-day range, which is also what a `formatRangeDays` hardcoded
  // to the constant string "Last 7 days" would print regardless of its
  // argument -- format.test.ts is the only place that would have caught it.
  // This is the one assertion in THIS file a constant-returning stub cannot
  // satisfy.
  it('labels a preview range other than the default 7 days (stub-check gap)', async () => {
    const client = fakeBuilderClient({
      previewFunnel: vi.fn(async () => ({
        ...RUN,
        range: { since: '2026-07-16T00:00:00.000Z', until: '2026-08-15T00:00:00.000Z' },
      })),
    })
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.click(screen.getByRole('button', { name: /preview/i }))
    expect(await screen.findByTestId('builder-preview-range')).toHaveTextContent('Last 30 days')
  })

  it('surfaces a 409 on the name field rather than as a page error', async () => {
    const client = fakeBuilderClient({
      createFunnel: vi.fn(async () => {
        throw new ApiError(409, 'duplicate name')
      }),
    })
    renderBuilder(client)
    await fillTwoSteps()
    // Defect 1 fix: Save is disabled without a name, so this now has to
    // type one before it can trigger the 409 the test is actually about.
    await userEvent.type(screen.getByLabelText(/name/i), 'Signup')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists/i)
  })
})

// Defect 1 from the Task 8 visual pass: `canSubmit` never checked the name
// field, so two valid steps plus an empty (or whitespace-only) name left
// Save enabled and `POST /v1/funnels` a guaranteed 400 -- every EXISTING
// test types a name before saving, which is exactly why 243 green tests and
// three reviews missed it. These assert the actual REQUEST, not only the
// button's `disabled` attribute: a mutation that removes `disabled` but
// leaves `handleSave`'s own guard in place must still fail here.
describe('FunnelBuilder — Save requires a non-empty name', () => {
  it('disables Save, and never calls createFunnel, with two valid steps and an empty name', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client)
    await fillTwoSteps()
    const save = screen.getByRole('button', { name: /^save$/i })
    expect(save).toBeDisabled()
    await userEvent.click(save)
    expect(client.createFunnel).not.toHaveBeenCalled()
  })

  it('typing a name enables Save', async () => {
    renderBuilder()
    await fillTwoSteps()
    await userEvent.type(screen.getByLabelText(/name/i), 'Signup')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })

  it('treats a whitespace-only name as empty: Save stays disabled and createFunnel is never called', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.type(screen.getByLabelText(/name/i), '   ')
    const save = screen.getByRole('button', { name: /^save$/i })
    expect(save).toBeDisabled()
    await userEvent.click(save)
    expect(client.createFunnel).not.toHaveBeenCalled()
  })

  it('sends the name trimmed, not the raw field value', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.type(screen.getByLabelText(/name/i), '  Signup  ')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.createFunnel).toHaveBeenCalled())
    const call = client.createFunnel.mock.calls[0]
    if (!call) throw new Error('createFunnel was not called')
    expect(call[1]).toBe('Signup')
  })
})

// Invented beyond the brief, from the stub check and from probing the
// builder's own logic beyond what the five given tests reach.
describe('FunnelBuilder -- invented mutations', () => {
  it('preview is disabled with only one step, independent of the name field', async () => {
    renderBuilder()
    await userEvent.type(await screen.findByLabelText(/name/i), 'Signup')
    await userEvent.type(screen.getByLabelText('Step 1'), 'page_view')
    expect(screen.getByRole('button', { name: /preview/i })).toBeDisabled()
  })

  // A hardcoded call `previewFunnel(1, definition, {})` where `definition`
  // is a literal object satisfies "was called once" -- this is the one
  // that checks the SHAPE actually reflects what was typed, with a window
  // value (604800) that cannot pass by coincidence with its input (7 days).
  it('passes the exact typed steps and the default window to preview', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client)
    await fillTwoSteps()
    await userEvent.click(screen.getByRole('button', { name: /preview/i }))
    await waitFor(() => expect(client.previewFunnel).toHaveBeenCalled())
    const call = client.previewFunnel.mock.calls[0]
    if (!call) throw new Error('previewFunnel was not called')
    const [projectId, definition, range] = call
    expect(projectId).toBe(1)
    expect(definition).toMatchObject({
      steps: [{ event: 'page_view' }, { event: 'signup_completed' }],
      window_seconds: 604800,
      segment_id: null,
    })
    expect(range).toEqual({})
  })

  it('edit mode seeds every field from the fetched funnel, not the new-funnel defaults', async () => {
    const client = fakeBuilderClient({
      funnel: vi.fn(async () => ({
        ...FUNNEL,
        window_seconds: 3600,
        segment_id: 9,
      })),
    })
    renderBuilder(client, FUNNEL.id)
    expect(await screen.findByLabelText(/name/i)).toHaveValue('Signup flow')
    expect(screen.getByLabelText('Step 1')).toHaveValue('page_view')
    expect(screen.getByLabelText('Step 2')).toHaveValue('signup_completed')
    // 3600 seconds seeds as "1 hour", not the 7-day default a fresh builder
    // would show -- the one assertion that would fail if seeding silently
    // fell back to NEW_STEPS/defaults instead of reading the response.
    expect(screen.getByRole('spinbutton')).toHaveValue(1)
    expect(screen.getByRole('combobox', { name: /window unit/i })).toHaveValue('hours')
  })

  it('edit mode saves through patchFunnel, never createFunnel', async () => {
    const client = fakeBuilderClient()
    renderBuilder(client, FUNNEL.id)
    await screen.findByLabelText(/name/i)
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.patchFunnel).toHaveBeenCalledTimes(1))
    expect(client.createFunnel).not.toHaveBeenCalled()
    const call = client.patchFunnel.mock.calls[0]
    if (!call) throw new Error('patchFunnel was not called')
    expect(call[0]).toBe(1)
    expect(call[1]).toBe(FUNNEL.id)
  })

  it('routes a 401 on save to onUnauthorized rather than an error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeBuilderClient({
      createFunnel: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    render(
      <MemoryRouter initialEntries={[ROUTES.funnelNew]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path={ROUTES.funnelNew}
              element={<FunnelBuilder client={client} onUnauthorized={onUnauthorized} />}
            />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await fillTwoSteps()
    // Defect 1 fix: Save is disabled without a name, so this now has to
    // type one before it can trigger the 401 the test is actually about.
    await userEvent.type(screen.getByLabelText(/name/i), 'Signup')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// I6 (whole-branch review): SegmentPicker and EventCombobox learned to
// route a 401 to onUnauthorized, but neither takes it any good if the
// builder never passes it down -- these confirm the SCREEN actually threads
// it to both, not just that the leaf components can accept it in isolation.
describe('FunnelBuilder — threads onUnauthorized to the segment picker and event fields', () => {
  it('routes a 401 from the segment picker to onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeBuilderClient({
      segments: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    render(
      <MemoryRouter initialEntries={[ROUTES.funnelNew]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path={ROUTES.funnelNew}
              element={<FunnelBuilder client={client} onUnauthorized={onUnauthorized} />}
            />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
  })

  it('routes a 401 from an event step field to onUnauthorized', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeBuilderClient({
      schemaEvents: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    render(
      <MemoryRouter initialEntries={[ROUTES.funnelNew]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route
              path={ROUTES.funnelNew}
              element={<FunnelBuilder client={client} onUnauthorized={onUnauthorized} />}
            />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )
    await userEvent.type(screen.getByLabelText('Step 1'), 'signup')
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
  })
})

// This screen used to REFUSE to save any funnel whose steps carried a
// `where` predicate: it could represent only a step's event name, so a save
// would silently drop the predicate array, and `PATCH /v1/funnels/:id`
// accepts a bare `steps` array -- the server would answer 200 while the
// funnel began measuring a different population. Predicates are editable
// here now, so the refusal is gone; what replaces it is the stronger claim
// that a save carries every predicate on every step, unchanged.
describe('FunnelBuilder — steps carry their own where predicates through a save', () => {
  const PREDICATED_STEPS = [
    { event: 'page_view', where: [{ property: 'path', operator: '=', value: '/changelog' }] },
    { event: 'signup_completed', where: [{ property: 'plan', operator: '=', value: 'pro' }] },
  ]

  it('saves a predicate-carrying funnel, patching every predicate through untouched', async () => {
    const client = fakeBuilderClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, steps: PREDICATED_STEPS })),
    })
    renderBuilder(client, FUNNEL.id)

    await screen.findByDisplayValue('page_view')
    const save = screen.getByRole('button', { name: /save/i })
    expect(save).toBeEnabled()
    await userEvent.click(save)

    await waitFor(() => expect(client.patchFunnel).toHaveBeenCalled())
    const call = client.patchFunnel.mock.calls[0]
    if (!call) throw new Error('patchFunnel was not called')
    const [, , patch] = call
    // BOTH steps' predicates, not just the first: a save that carried only
    // step 1's would pass a one-predicated-step fixture.
    expect(patch.steps).toStrictEqual(PREDICATED_STEPS)
  })

  it('a predicate added here reaches the request, on the step it was added to', async () => {
    const client = fakeBuilderClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, steps: PREDICATED_STEPS })),
    })
    renderBuilder(client, FUNNEL.id)
    await screen.findByDisplayValue('page_view')

    await userEvent.click(
      within(screen.getByTestId('step-2-where')).getByRole('button', { name: /add predicate/i }),
    )
    const row = within(screen.getByTestId('step-2-where-1'))
    await userEvent.type(row.getByLabelText('Property'), 'seats')
    await userEvent.type(row.getByRole('textbox', { name: /^value$/i }), '5')

    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(client.patchFunnel).toHaveBeenCalled())
    const call = client.patchFunnel.mock.calls[0]
    if (!call) throw new Error('patchFunnel was not called')
    const [, , patch] = call
    expect(patch.steps).toStrictEqual([
      PREDICATED_STEPS[0],
      {
        event: 'signup_completed',
        where: [
          { property: 'plan', operator: '=', value: 'pro' },
          { property: 'seats', operator: '=', value: '5' },
        ],
      },
    ])
  })

  it('shows each step its own predicates, with the operator the wire carries', async () => {
    const client = fakeBuilderClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, steps: PREDICATED_STEPS })),
    })
    renderBuilder(client, FUNNEL.id)
    const row = within(await screen.findByTestId('step-1-where-0'))
    expect(row.getByLabelText('Property')).toHaveValue('path')
    expect(row.getByRole('combobox', { name: /operator/i })).toHaveValue('=')
    expect(row.getByRole('textbox', { name: /^value$/i })).toHaveValue('/changelog')
  })
})

describe('FunnelBuilder — edit round-trips every field it did not change', () => {
  it('an edit of an ordinary funnel round-trips every field it did not change', async () => {
    // Window and segment deliberately differ from both the fresh-builder
    // defaults (604800s / null) AND from `FUNNEL`'s own defaults, so a bug
    // that quietly falls back to either cannot pass by coincidence.
    const client = fakeBuilderClient({
      funnel: vi.fn(async () => ({ ...FUNNEL, segment_id: 4, window_seconds: 3600 })),
    })
    renderBuilder(client, FUNNEL.id)
    await userEvent.clear(await screen.findByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'Renamed')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))
    await waitFor(() => expect(client.patchFunnel).toHaveBeenCalled())
    const call = client.patchFunnel.mock.calls[0]
    if (!call) throw new Error('patchFunnel was not called')
    const [, , patch] = call
    expect(patch).toMatchObject({ name: 'Renamed', window_seconds: 3600, segment_id: 4 })
  })
})

// Controller ruling, Task 6 fix round 1: CREATE lands on the list (proven by
// the single-source-of-truth test in `Funnels.test.tsx`, not touched here);
// EDIT lands on that funnel's own detail page instead, because the operator
// just changed something and the only question they have is what it says
// now -- the detail screen answers that by auto-running, where the list
// would only show a stale cached rate from before the edit.
describe('FunnelBuilder — a successful edit lands on the detail page, not the list', () => {
  it('lands on the detail route, which then runs the EDITED funnel exactly once', async () => {
    // A stand-in server: GET reflects whatever the last PATCH wrote, so this
    // test can tell "shows the edit" apart from "shows a stale copy fetched
    // before it". `currentFunnel` is intentionally mutated by `patchFunnel`
    // rather than the test asserting on the outgoing patch alone.
    let currentFunnel: Funnel = FUNNEL
    const client = {
      schemaEvents: vi.fn(async () => []),
      segments: vi.fn(async () => []),
      previewFunnel: vi.fn(async () => RUN),
      createFunnel: vi.fn(async () => ({ ...FUNNEL, id: 42 })),
      patchFunnel: vi.fn(async (_projectId: number, _id: number, patch: Partial<Funnel>) => {
        currentFunnel = { ...currentFunnel, ...patch }
        return currentFunnel
      }),
      funnel: vi.fn(async () => currentFunnel),
      runFunnel: vi.fn(async () => RUN),
    } as unknown as ApiClient & {
      patchFunnel: Mock
      funnel: Mock
      runFunnel: Mock
    }

    render(
      <MemoryRouter initialEntries={[funnelEditPath(FUNNEL.id)]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <Routes>
            <Route path="/funnels/:id/edit" element={<FunnelBuilder client={client} />} />
            <Route path="/funnels/:id" element={<FunnelDetail client={client} />} />
          </Routes>
        </ProjectProvider>
      </MemoryRouter>,
    )

    await userEvent.clear(await screen.findByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'Renamed')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // The detail screen's own heading is the funnel's name -- finding
    // "Renamed" here (not "Signup flow") proves this is the EDITED
    // definition, not a copy cached from before the PATCH.
    expect(await screen.findByRole('heading', { name: 'Renamed' })).toBeInTheDocument()
    // Exactly once: not run while still on the builder (which never calls
    // `runFunnel` at all), and not run twice by arriving at the detail
    // page -- a single fresh mount runs it a single time.
    await waitFor(() => expect(client.runFunnel).toHaveBeenCalledTimes(1))
  })
})
