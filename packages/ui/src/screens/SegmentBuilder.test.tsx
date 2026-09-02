import type { FilterNode } from '@lyraflow/core/segments/ast.js'
import {
  MAX_BEHAVIOR_NODES,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
} from '@lyraflow/core/segments/validate.js'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import { ApiError } from '../api/client.js'
import type { ApiClient } from '../api/client.js'
import type { Segment, SegmentPreview } from '../api/types.js'
import { ProjectProvider, useProject } from '../app/ProjectContext.js'
import { ROUTES, segmentEditPath, segmentPath } from '../app/Router.js'
import { DEBOUNCE_MS, SegmentBuilder } from './SegmentBuilder.js'

const PROJECTS = [
  {
    id: 1,
    name: 'Alpha',
    slug: 'alpha',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
  },
]

const TREE: FilterNode = {
  kind: 'group',
  op: 'and',
  children: [{ kind: 'trait', key: 'plan', operator: '=', value: 'pro' }],
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
    createSegment: vi.fn(async () => ({ ...SEGMENT, id: 42 })),
    // Rename ONLY (never carries a tree) vs tree update ONLY
    // (never carries a name) -- two methods, deliberately, so a caller
    // cannot send the wrong one by accident (this file's own "the sharpest
    // rule in this plan" tests, below).
    renameSegment: vi.fn(async () => SEGMENT),
    updateSegmentTree: vi.fn(async () => SEGMENT),
    // The cap fixtures render REAL `behavior` leaves -- each one
    // mounts a `BehaviourForm` -> `EventCombobox`, whose debounced effect
    // calls `schemaEvents` even with a non-empty seeded value. Without
    // this, that fires as an uncaught async exception once
    // any fixture in this file reaches a behavior leaf, since no earlier
    // test ever did.
    schemaEvents: vi.fn(async () => []),
    schemaProperties: vi.fn(async () => []),
    // EVERY dirtying edit in this file now starts a real
    // `debounceMs` timer that, once it fires, calls this -- on real timers
    // (every test above this point) that is a genuine 600ms wall-clock
    // wait, not a no-op, so a fixture that dirties the tree but finishes
    // its own assertions slower than that (this machine's own documented
    // contention) would otherwise hit an unmocked `previewSegment` and
    // throw inside a timer callback. Same defensive shape as
    // `schemaEvents`/`schemaProperties` above.
    previewSegment: vi.fn(async () => PREVIEW),
    ...over,
  } as unknown as ApiClient & {
    segment: Mock
    createSegment: Mock
    renameSegment: Mock
    updateSegmentTree: Mock
  }
}

function renderBuilder(
  client: ApiClient = fakeClient(),
  editId?: number,
  onUnauthorized?: () => void,
) {
  render(
    <MemoryRouter initialEntries={[editId != null ? segmentEditPath(editId) : ROUTES.segmentNew]}>
      <ProjectProvider projects={PROJECTS} initialId={1}>
        <Routes>
          <Route
            path={ROUTES.segmentNew}
            element={<SegmentBuilder client={client} onUnauthorized={onUnauthorized} />}
          />
          <Route
            path="/segments/:id/edit"
            element={<SegmentBuilder client={client} onUnauthorized={onUnauthorized} />}
          />
          {/* Placeholders so a successful save's navigation has somewhere
           * to land, matching FunnelBuilder.test.tsx's own harness. */}
          <Route path={ROUTES.segments} element={<p>segments list</p>} />
          <Route path="/segments/:id" element={<p>segment detail</p>} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
}

const saveButton = () => screen.getByRole('button', { name: /^save$/i })

/** The trait-key field of the row at `path` -- `condition-<path>` scoped,
 * because an unscoped `getByRole` is ambiguous the moment there is more
 * than one condition. */
const traitKeyOf = (path = '0') =>
  within(screen.getByTestId(`condition-${path}`)).getByRole('combobox', { name: /^trait$/i })

/**
 * Adds a condition AND fills in the one field a fresh one leaves blank.
 *
 * An empty field means "not filled in yet", so a freshly added condition is
 * an incomplete DRAFT and Save stays disabled until it is filled in --
 * pinned on its own, immediately below. Every fixture in this file that
 * needs a SAVEABLE tree goes through here rather than repeating the two
 * steps, so a change to what a fresh condition looks like lands in one
 * place instead of eleven.
 */
async function addAFilledCondition(key = 'plan') {
  await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
  await userEvent.type(traitKeyOf(), key)
}

/** Renders in EDIT mode against a segment shaped by `overrides`
 * (`{ ...SEGMENT, ...overrides }`) -- mutates the given `fakeClient`'s own
 * `segment` mock in place rather than building a fresh client, so a test
 * can still assert on the SAME client object's `renameSegment`/
 * `updateSegmentTree` mocks it already holds a reference to. */
function renderEdit(
  client: ApiClient & { segment: Mock },
  overrides: Partial<Segment> & { id: number },
  onUnauthorized?: () => void,
) {
  client.segment.mockResolvedValue({ ...SEGMENT, ...overrides })
  renderBuilder(client, overrides.id, onUnauthorized)
}

describe('SegmentBuilder -- create', () => {
  it('starts at an empty root, save disabled, and shows the empty state', async () => {
    renderBuilder()
    expect(await screen.findByTestId('group-')).toBeInTheDocument()
    expect(screen.getByText(/no conditions yet/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('a freshly added condition leaves Save disabled until it is filled in', async () => {
    // The live defect, stated as the operator hits it: click "Add
    // condition", click Save. `newCondition()` produces `key: ''`, which
    // `ast.ts` declares `z.string().min(1)`, so the server refused the tree
    // and the operator got a save error for a form this screen had let them
    // build. Every other fixture in this suite fills the fields in first,
    // which is why nothing here ever went red for it.
    const client = fakeClient()
    renderBuilder(client)
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))

    // Asserted on the CONTROL, not on some validation function's return:
    // the promise this keeps is about what the Save button offers.
    expect(saveButton()).toBeDisabled()
    // ...and on the REQUEST as well, because a screen that disables the
    // wrong control and still fires the call would pass a control-only
    // test.
    await userEvent.click(saveButton())
    expect(client.createSegment).not.toHaveBeenCalled()
    // ...and the row itself says why, rather than leaving a dead button
    // with no explanation anywhere on the page.
    expect(within(screen.getByTestId('condition-0')).getByText(/not finished/i)).toBeInTheDocument()

    await userEvent.type(traitKeyOf(), 'plan')
    expect(saveButton()).toBeEnabled()
    expect(within(screen.getByTestId('condition-0')).queryByText(/not finished/i)).toBeNull()
  })

  it('enables save once a name is set and a complete condition exists, disabled again if either is missing', async () => {
    renderBuilder()
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    expect(saveButton()).toBeDisabled()
    await addAFilledCondition()
    expect(saveButton()).toBeEnabled()
  })

  it('save creates the segment with the typed name and current tree, then navigates to the list', async () => {
    const client = fakeClient()
    renderBuilder(client)
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await addAFilledCondition()
    await userEvent.click(saveButton())
    await waitFor(() => expect(client.createSegment).toHaveBeenCalledTimes(1))
    const call = client.createSegment.mock.calls[0]
    if (!call) throw new Error('createSegment was not called')
    expect(call[0]).toBe(1)
    expect(call[1]).toBe('VIPs')
    expect(call[2]).toEqual({
      ast_version: 1,
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'trait', key: 'plan', operator: '=', value: '' }],
      },
    })
    expect(await screen.findByText('segments list')).toBeInTheDocument()
  })

  it('routes a 401 on save to onUnauthorized rather than an error banner', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      createSegment: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    render(
      <MemoryRouter initialEntries={[ROUTES.segmentNew]}>
        <ProjectProvider projects={PROJECTS} initialId={1}>
          <SegmentBuilder client={client} onUnauthorized={onUnauthorized} />
        </ProjectProvider>
      </MemoryRouter>,
    )
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await addAFilledCondition()
    await userEvent.click(saveButton())
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

// --- An empty field means "not filled in yet". The AST is a STORAGE
// schema, so a half-typed condition is a legitimate editing state and an
// illegitimate storage state: the builder holds the draft, Save is refused
// while any condition is incomplete, and the incomplete condition says so
// on its own row rather than in a page-level banner. These drive the whole
// screen -- the tree, the real Zod schema, the path mapping and the button
// -- rather than any one of those in isolation.
describe('SegmentBuilder -- an incomplete draft', () => {
  const INCOMPLETE_AT_DEPTH: FilterNode = {
    kind: 'group',
    op: 'and',
    children: [
      { kind: 'trait', key: 'plan', operator: '=', value: 'pro' },
      {
        kind: 'group',
        op: 'or',
        children: [
          { kind: 'trait', key: '', operator: '=', value: '' },
          { kind: 'trait', key: 'tier', operator: '=', value: 'free' },
        ],
      },
    ],
  }

  it('lands the message on the incomplete row at depth, and on neither of its complete siblings', async () => {
    // A fixture with exactly one condition cannot tell "renders on the
    // incomplete row" apart from "renders on every row", and this codebase
    // has produced that coincidence six times. Two complete siblings here,
    // one in the same group as the incomplete row and one at the root, so a
    // message on the wrong row is a distinct assertable failure.
    const client = fakeClient()
    renderEdit(client, { id: 7, filter: INCOMPLETE_AT_DEPTH })
    await screen.findByTestId('condition-1-0')

    expect(
      within(screen.getByTestId('condition-1-0')).getByText(/not finished/i),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('condition-1-1')).queryByText(/not finished/i)).toBeNull()
    expect(within(screen.getByTestId('condition-0')).queryByText(/not finished/i)).toBeNull()
    expect(saveButton()).toBeDisabled()
  })

  it('filling in the incomplete row at depth clears its message and enables Save', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, filter: INCOMPLETE_AT_DEPTH })
    await screen.findByTestId('condition-1-0')

    await userEvent.type(traitKeyOf('1-0'), 'region')
    expect(within(screen.getByTestId('condition-1-0')).queryByText(/not finished/i)).toBeNull()
    expect(saveButton()).toBeEnabled()
  })

  // --- Three DIFFERENT incomplete shapes, so the check cannot be
  // accidentally trait-specific: a blank `key` on a trait, a blank `event`
  // on a behaviour, and an `absolute` window with neither bound filled in.

  it('catches a behaviour whose event has not been named', async () => {
    renderBuilder()
    await screen.findByTestId('group-')
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await addAFilledCondition()
    expect(saveButton()).toBeEnabled()

    const row = () => within(screen.getByTestId('condition-0'))
    await userEvent.selectOptions(
      row().getByRole('combobox', { name: 'Match on' }),
      'what they did',
    )
    expect(row().getByText(/not finished/i)).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()

    await userEvent.type(row().getByRole('combobox', { name: /event/i }), 'checkout')
    expect(row().queryByText(/not finished/i)).toBeNull()
    expect(saveButton()).toBeEnabled()
  })

  it('catches an absolute window with neither bound filled in', async () => {
    renderBuilder()
    await screen.findByTestId('group-')
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await addAFilledCondition()
    const row = () => within(screen.getByTestId('condition-0'))
    await userEvent.selectOptions(
      row().getByRole('combobox', { name: 'Match on' }),
      'what they did',
    )
    await userEvent.type(row().getByRole('combobox', { name: /event/i }), 'checkout')
    expect(saveButton()).toBeEnabled()

    // The incompleteness is now two levels INSIDE the leaf
    // (`window.from`/`window.to`), not a field of the node itself -- a path
    // mapping that only looked at the last segment, or that treated every
    // number in the path as a child index, would lose it or move it.
    await userEvent.selectOptions(row().getByRole('combobox', { name: 'Window' }), 'absolute')
    expect(row().getByText(/not finished/i)).toBeInTheDocument()
    expect(saveButton()).toBeDisabled()
    // Said once, though the window raises an issue for each of its two
    // bounds -- the row has one thing to say.
    expect(row().getAllByText(/not finished/i)).toHaveLength(1)
  })

  // The consequence of the window fix, and the one place the row-level
  // messaging used to say something untrue: an operator who chose an
  // absolute range and filled in BOTH fields was told the condition was not
  // finished, because the tree the picker produced was one the schema
  // refused. Driven through the real control -- every other fixture in this
  // suite builds a window object directly, which is exactly why nothing
  // here ever went red for it.
  //
  // In a zone that is not UTC, because the container this runs in defaults
  // to UTC and a missing conversion is invisible there.
  describe('an absolute window filled in through the picker', () => {
    const LOCAL_FROM = '2026-08-01T10:00'
    const LOCAL_TO = '2026-09-01T02:00'
    const INSTANT_FROM = '2026-08-01T04:30:00.000Z'
    const INSTANT_TO = '2026-08-31T20:30:00.000Z'

    // Via `vi.stubEnv`, not a direct `process.env` write: this package
    // carries no `@types/node`, and CI typechecks before it runs anything.
    beforeAll(() => {
      vi.stubEnv('TZ', 'Asia/Kolkata')
    })
    afterAll(() => {
      vi.unstubAllEnvs()
    })

    it('is running in a zone that is not UTC, so a missing conversion is observable', () => {
      expect(new Date(LOCAL_FROM).toISOString()).toBe(INSTANT_FROM)
    })

    /** Gets a behaviour condition on screen with an `absolute` window
     * selected and neither bound filled in. */
    async function anAbsoluteWindow() {
      await screen.findByTestId('group-')
      await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
      await addAFilledCondition()
      const row = within(screen.getByTestId('condition-0'))
      await userEvent.selectOptions(
        row.getByRole('combobox', { name: 'Match on' }),
        'what they did',
      )
      await userEvent.type(row.getByRole('combobox', { name: /event/i }), 'checkout')
      await userEvent.selectOptions(row.getByRole('combobox', { name: 'Window' }), 'absolute')
    }

    it('is finished once both bounds are filled in, and Save is offered', async () => {
      renderBuilder()
      await anAbsoluteWindow()
      const row = () => within(screen.getByTestId('condition-0'))
      expect(row().getByText(/not finished/i)).toBeInTheDocument()
      expect(saveButton()).toBeDisabled()

      fireEvent.change(row().getByLabelText('From'), { target: { value: LOCAL_FROM } })
      // Still unfinished with only ONE bound -- so "finished" cannot be
      // passing merely because the message stopped being computed.
      expect(row().getByText(/not finished/i)).toBeInTheDocument()
      fireEvent.change(row().getByLabelText('To'), { target: { value: LOCAL_TO } })

      expect(row().queryByText(/not finished/i)).toBeNull()
      expect(saveButton()).toBeEnabled()
    })

    it('saves the bounds as UTC instants, and shows the operator’s own wall-clock back', async () => {
      const client = fakeClient()
      renderBuilder(client)
      await anAbsoluteWindow()
      const row = () => within(screen.getByTestId('condition-0'))
      fireEvent.change(row().getByLabelText('From'), { target: { value: LOCAL_FROM } })
      fireEvent.change(row().getByLabelText('To'), { target: { value: LOCAL_TO } })

      // What the picker shows is what was typed -- the read direction,
      // which a conversion applied only on write would break.
      expect(row().getByLabelText('From')).toHaveValue(LOCAL_FROM)
      expect(row().getByLabelText('To')).toHaveValue(LOCAL_TO)

      await userEvent.click(saveButton())
      await waitFor(() => expect(client.createSegment).toHaveBeenCalledTimes(1))
      const sent = client.createSegment.mock.calls[0]?.[2] as { filter: FilterNode }
      const leaf = (sent.filter as { children: FilterNode[] }).children[0] as {
        window: { from: string; to: string }
      }
      expect(leaf.window).toEqual({ kind: 'absolute', from: INSTANT_FROM, to: INSTANT_TO })
    })
  })

  it('a kind switch leaves no stale message from the kind it switched away from', async () => {
    // The message is derived from the tree on every render, never
    // remembered -- so switching an incomplete condition to a kind whose
    // own default is complete must clear it in the same commit. A cached
    // flag would leave the sentence standing over a condition that no
    // longer has that problem, with Save enabled beside it.
    renderBuilder()
    await screen.findByTestId('group-')
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    const row = () => within(screen.getByTestId('condition-0'))
    expect(row().getByText(/not finished/i)).toBeInTheDocument()

    await userEvent.selectOptions(
      row().getByRole('combobox', { name: 'Match on' }),
      'where they came from',
    )
    expect(row().queryByText(/not finished/i)).toBeNull()
    expect(saveButton()).toBeEnabled()
  })
})

describe('SegmentBuilder -- edit', () => {
  it('seeds the name and tree from the fetched segment', async () => {
    renderBuilder(fakeClient(), SEGMENT.id)
    expect(await screen.findByLabelText(/name/i)).toHaveValue('Paying customers')
    // The placeholder leaf (plain `summarise` text) was replaced with a
    // real `TraitForm` -- an `<input>`'s `value` is never DOM text content,
    // so the fetched trait's data is pinned through its own fields instead.
    const condition = within(screen.getByTestId('condition-0'))
    expect(condition.getByRole('combobox', { name: /^trait$/i })).toHaveValue('plan')
    expect(condition.getByRole('combobox', { name: /operator/i })).toHaveValue('=')
    expect(condition.getByRole('combobox', { name: /^value$/i })).toHaveValue('pro')
  })

  // An UNCHANGED save sends nothing to the server at all (see
  // SegmentBuilder's own doc comment), so this fixture makes a real tree
  // edit (appending to the existing trait's value) before saving, to keep
  // pinning "edit mode goes through updateSegmentTree, not createSegment"
  // as a distinct fact from the three tests below.
  it('save sends the current tree through updateSegmentTree, never createSegment', async () => {
    const client = fakeClient()
    renderBuilder(client, SEGMENT.id)
    await screen.findByLabelText(/name/i)
    await userEvent.type(
      within(screen.getByTestId('condition-0')).getByRole('combobox', { name: /^value$/i }),
      'X',
    )
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    expect(client.createSegment).not.toHaveBeenCalled()
    expect(client.renameSegment).not.toHaveBeenCalled()
    const call = client.updateSegmentTree.mock.calls[0]
    if (!call) throw new Error('updateSegmentTree was not called')
    expect(call[0]).toBe(1)
    expect(call[1]).toBe(SEGMENT.id)
    expect(call[2]).toEqual({
      ast_version: 1,
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'trait', key: 'plan', operator: '=', value: 'proX' }],
      },
    })
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
  })

  it('a save with no name or tree change reaches neither renameSegment nor updateSegmentTree, and still navigates to detail', async () => {
    // The other half of the coincidence: a
    // fixture where NOTHING changed must not be indistinguishable from one
    // where the tree happens to round-trip back to its original shape --
    // this pins that clicking Save on an untouched segment issues no
    // request at all, matching "never send the tree along a rename" taken
    // to its limit.
    const client = fakeClient()
    renderBuilder(client, SEGMENT.id)
    await screen.findByLabelText(/name/i)
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
    expect(client.renameSegment).not.toHaveBeenCalled()
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
    expect(client.createSegment).not.toHaveBeenCalled()
  })

  it('removing the only condition disables save and shows the empty state again', async () => {
    renderBuilder(fakeClient(), SEGMENT.id)
    await screen.findByLabelText(/name/i)
    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /remove/i }),
    )
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    expect(screen.getByText(/no conditions yet/i)).toBeInTheDocument()
  })

  it('a stale segment cannot be edited here, and save is disabled', async () => {
    renderBuilder(
      fakeClient({ segment: vi.fn(async () => ({ ...SEGMENT, stale: true })) }),
      SEGMENT.id,
    )
    expect(await screen.findByText(/cannot be read/i)).toBeInTheDocument()
    expect(screen.queryByTestId('group-')).toBeNull()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })
})

// --- The sharpest rule in this plan. `PATCH /v1/segments/:id`
// decides whether to touch the filter tree by whether the body carries one
// AT ALL, not by comparing old against new -- so a rename that ships the
// whole definition resets the segment's cached count snapshot and returns
// `200`, silently. `renameSegment` (name only) and `updateSegmentTree`
// (tree only) are separate `ApiClient` methods for exactly this reason.
// Every assertion below is on the REQUEST, never merely on a control's
// enabled/disabled state -- a screen that disables the wrong button but
// still fires the wrong call would pass a control-only test.

describe('SegmentBuilder -- the rename rule', () => {
  /** A single click on condition-0's own Negate button -- a real,
   * content-changing edit (wraps the leaf in a `not`, `ConditionRow`'s own
   * doc comment), unlike the cap fixtures' negate-TWICE helper, which
   * dirties the tree without changing its final shape. One click is what
   * this file needs: a tree edit that `originalRoot` comparison actually
   * sees as changed. */
  async function negateTheFirstCondition() {
    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
    )
  }

  it('a rename sends the name alone, never the tree', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // The assertion that matters is about the REQUEST, not the control.
    await waitFor(() => expect(client.renameSegment).toHaveBeenCalledWith(1, 7, 'New'))
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
  })

  it('a tree edit sends the tree', async () => {
    // So the guard above cannot be satisfied by never sending one.
    const client = fakeClient()
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalled())
  })

  it('a name and tree change together sends both, and neither call is malformed', async () => {
    // Two PATCHes is fine; one carrying both is not, because the rename
    // path is the only one that preserves the snapshot and it must stay
    // tree-free.
    const client = fakeClient()
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalled())
    expect(client.renameSegment).toHaveBeenCalledWith(1, 7, 'New')
    // The tree call carries no name, and the rename carries no tree.
    const treeCall = client.updateSegmentTree.mock.calls[0]
    const renameCall = client.renameSegment.mock.calls[0]
    if (!treeCall || !renameCall) throw new Error('both calls were expected')
    expect(treeCall[2]).not.toHaveProperty('name')
    expect(renameCall[2]).toBe('New')
  })

  // Mutation 1: a save with ONLY a name change must not
  // merely skip `updateSegmentTree` -- it must not navigate before the
  // rename's own promise settles, and it must navigate to DETAIL (edit's
  // own destination), never the list (create's).
  it('a rename-only save navigates to the segment detail route, not the list', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
    expect(screen.queryByText('segments list')).toBeNull()
  })

  // Mutation 2: a tree that is edited and then edited BACK
  // to its exact original shape (negate, negate again) must read as
  // UNCHANGED -- content equality against `originalRoot`, not the `dirty`
  // flag, which is set once and never cleared. A rename alongside a
  // round-tripped tree edit must still take the rename-only path.
  it('a tree edited back to its original shape is not treated as a tree change, even alongside a rename', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await negateTheFirstCondition()
    await negateTheFirstCondition() // back to the original shape
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.renameSegment).toHaveBeenCalledWith(1, 7, 'New'))
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
  })

  // An edit save can issue TWO PATCHes (rename + tree update), and either can
  // fail after the other committed. The copy used to say "nothing was changed
  // on the server", which is false in exactly this shape; then it said only
  // "could not save this segment. Try again", which is true but leaves the
  // operator to discover a rename they did not know had landed.
  //
  // `Promise.allSettled` means the screen can now name which half landed, so
  // this pins the specific claim rather than only the absence of a wrong one
  // (#118).
  it('a failed edit save (rename succeeds, tree update fails) says the name was saved and the conditions were not', async () => {
    const client = fakeClient({
      updateSegmentTree: vi.fn(async () => {
        throw new ApiError(500, 'server_error')
      }),
    })
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(client.renameSegment).toHaveBeenCalledWith(1, 7, 'New'))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/the name was saved, but the conditions were not/i)
    // The original claim this test was written against, still excluded: the
    // rename DID commit, so any form of "nothing changed" is false here.
    expect(alert).not.toHaveTextContent(/nothing was changed/i)
    expect(alert).not.toHaveTextContent(/nothing changed/i)
  })

  // --- After a PARTIAL save, the fetch-time snapshot describes a server
  // state that no longer exists. The retry advice above is only honest if
  // each request advances its own baseline the moment it commits: the
  // operator's natural response to a save error is to change something and
  // save again, and against a stale baseline that second save silently
  // drops whichever field they reverted. Two tests, one per side, because
  // either baseline can be the one that committed.

  // The claim the old copy could not safely make, and therefore never made
  // even when it held. With both requests failing, "nothing was changed" is
  // simply true, and saying it spares the operator going to check.
  it('a failed edit save where BOTH requests fail says nothing was changed', async () => {
    const client = fakeClient({
      renameSegment: vi.fn(async () => {
        throw new ApiError(500, 'server_error')
      }),
      updateSegmentTree: vi.fn(async () => {
        throw new ApiError(500, 'server_error')
      }),
    })
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/nothing was changed on the server/i)
    // And it must NOT name a half, since neither landed.
    expect(alert).not.toHaveTextContent(/but the conditions were not/i)
    expect(alert).not.toHaveTextContent(/but the name was not/i)
  })

  // `Promise.all` surfaced only the FIRST rejection, so a 401 arriving on the
  // second request could be missed while the first request's ordinary failure
  // was reported instead -- leaving the operator with a retry prompt on a
  // session that is already dead. `allSettled` sees every rejection, and this
  // pins that the dead session still wins over the error banner.
  it('reports a dead session even when the 401 is not the first request to fail', async () => {
    const onUnauthorized = vi.fn()
    const client = fakeClient({
      renameSegment: vi.fn(async () => {
        throw new ApiError(500, 'server_error')
      }),
      updateSegmentTree: vi.fn(async () => {
        throw new ApiError(401, 'unauthorized')
      }),
    })
    renderEdit(client, { id: 7, name: 'Old', filter: TREE }, onUnauthorized)
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled())
    // A dead session is the whole story; a retry prompt beside it is noise
    // that sends the operator round a loop every request will fail.
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('after a partial save, reverting the name still sends the rename -- the committed side is the new baseline', async () => {
    const client = fakeClient({
      updateSegmentTree: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(500, 'server_error'))
        .mockResolvedValue(SEGMENT),
    })
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // The rename committed; the tree update did not. The server now holds
    // `New`, which is not what `originalName` was fetched as.
    await waitFor(() => expect(client.renameSegment).toHaveBeenCalledWith(1, 7, 'New'))
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /the name was saved, but the conditions were not/i,
    )

    // The operator abandons the rename and saves again.
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'Old')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(2))
    // The assertion that matters is the REQUEST: without this the screen
    // navigates away reporting success while the segment is still called
    // `New` on the server.
    expect(client.renameSegment).toHaveBeenCalledTimes(2)
    expect(client.renameSegment).toHaveBeenLastCalledWith(1, 7, 'Old')
  })

  it('after a partial save, reverting the tree still sends the tree -- the committed side is the new baseline', async () => {
    // The mirror: this time the TREE update is the side that lands.
    const client = fakeClient({
      renameSegment: vi
        .fn()
        .mockRejectedValueOnce(new ApiError(500, 'server_error'))
        .mockResolvedValue(SEGMENT),
    })
    renderEdit(client, { id: 7, name: 'Old', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'New')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    // The mirror message: this time the TREE is the side that landed.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /the conditions were saved, but the name was not/i,
    )

    // The operator un-negates, restoring the tree the segment was FETCHED
    // with -- which the successful first request means is no longer the
    // tree the server holds.
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(2))
    const second = client.updateSegmentTree.mock.calls[1]
    if (!second) throw new Error('a second tree update was expected')
    expect(second[2]).toEqual({ ast_version: 1, filter: TREE })
  })

  // --- A stored name is compared TRIMMED on both sides. Otherwise a
  // segment named with surrounding whitespace issues a rename nobody asked
  // for on every save, and "a save with neither changed issues no request
  // at all" stops being true of exactly those segments.

  it('a stored name with surrounding whitespace is not a rename: a tree-only edit sends only the tree', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, name: '  Paying customers  ', filter: TREE })
    await screen.findByTestId('condition-0')
    await negateTheFirstCondition()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    expect(client.renameSegment).not.toHaveBeenCalled()
  })

  it('a save with nothing changed issues no request at all, for a whitespace-padded name too', async () => {
    const client = fakeClient()
    renderEdit(client, { id: 7, name: '  Paying customers  ', filter: TREE })
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
    expect(client.renameSegment).not.toHaveBeenCalled()
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
  })
})

// --- The three server-side tree caps, enforced end to end through
// SegmentBuilder -- GroupCard computes them from the SAME `root` this
// screen owns (see SegmentBuilder's own doc comment on why the wiring
// lives here), so these pin the whole chain rather than GroupCard in
// isolation (already covered directly by GroupCard.test.tsx). Each fixture
// is deliberately seeded via EDIT mode (a fetched segment already at, or
// one below, its cap) rather than reached by clicking through 100 times.

describe('SegmentBuilder -- the three server-side tree caps', () => {
  const trait = (key: string): FilterNode => ({ kind: 'trait', key, operator: '=', value: 'x' })
  const behaviorLeaf = (event: string): FilterNode => ({
    kind: 'behavior',
    event,
    aggregate: 'count',
    window: { kind: 'last', n: 1, unit: 'days' },
    operator: '>=',
    value: 1,
  })

  /** A flat root with `n` leaves -- countNodes = n + 1 (the root group
   * counts too). Flat and single-level so exactly one "Add condition"
   * button exists on the whole page -- no `within(...)` scoping needed. */
  function flatRoot(n: number, leaf: (key: string) => FilterNode): FilterNode {
    return {
      kind: 'group',
      op: 'and',
      children: Array.from({ length: n }, (_, i) => leaf(`k${i}`)),
    }
  }

  // 180s, not 60s, and every number here is measured rather than guessed
  // (#150, then #228).
  //
  // These two fixtures render MAX_TREE_NODES - 1 real trait forms, and that
  // render is SUPERLINEAR in row count. Same test, only the fixture size
  // changed, measured on one machine at two points in the repo's history:
  //
  //                  at 7b379e0 (2026-08-22)   at main (2026-09-02)
  //     99 rows                     13687ms                 31424ms
  //     49 rows                      1612ms                  3933ms
  //     24 rows                       234ms                   729ms
  //
  // Two things follow, and the second one corrects this comment's own
  // earlier explanation.
  //
  // FIRST: the cost roughly DOUBLED, and it is the code that changed, not
  // the machine. `7b379e0` re-measured on the machine that produced the
  // right-hand column gives 14827ms -- reproducing its own recorded 13687ms.
  // Two commits account for it, found by `git bisect run` over the 269
  // commits between them, and both add per-row DOM to the trait condition:
  //   - `23ad892` (predicate operator families): 15148ms -> 22436ms. The
  //     operator <select> went from 7 options to 19 in optgroups; forcing it
  //     back to `['comparison']` today measures 31424ms -> 20353ms, so this
  //     is about a third of the total.
  //   - `05f9f2e` (trait field alignment and value label): 22638ms -> 30278ms.
  // Neither is wrong as a change. They are per-row costs that were invisible
  // at one row and are not at ninety-nine. Tracked in #228.
  //
  // SECOND, and this is a CORRECTION: the superlinearity is NOT "the tree
  // re-rendering as it mounts", which is what this comment used to say.
  // Counting renders directly (a counter in `ConditionRow`) gives exactly
  // 99 for a 99-row fixture -- every row renders ONCE. So memoising the row,
  // or stabilising the callbacks it receives, cannot help, and the plausible
  // shape of that explanation is exactly what makes it worth writing down as
  // ruled out. What actually grows is the cost of ONE row's render as the
  // document gets bigger, which points at jsdom rather than at React.
  //
  // Also RULED OUT, from the earlier round, so nobody re-tests them:
  //   - the ~99 suggestion effects resolving and setting state. Making those
  //     promises never settle changed nothing (13.7s -> 13.9s).
  //   - Testing Library's `getByRole`/`getByText` computing accessible names
  //     across a large DOM on every poll. Replacing both with raw DOM queries
  //     changed nothing (13.7s -> 15.0s).
  //
  // Why raise the number rather than trim the fixture: the test needs a tree
  // AT the cap, and the cap is where the cost lives. CI measured 61117ms and
  // timed out at 60000ms, against ~31s on this machine -- a runner is about
  // twice as slow, so 60s was budgeting for a cost that no longer fits.
  // 180s restores roughly the headroom 60s bought when it was set.
  //
  // What is NOT concluded: that the product is slow for a user. jsdom is far
  // slower than a browser and these absolute numbers do not transfer; the cap
  // bounds the worst case at 100 nodes and nobody has reported a slow builder.
  // What DOES transfer is that the same tree now costs about twice the render
  // work it did, which is why #228 exists and why the browser profile it asks
  // for is the measurement that would settle it.
  it('disables add-condition at the node cap, says which cap, and never requests a preview or a save', async () => {
    const client = fakeClient({
      segment: vi.fn(async () => ({
        ...SEGMENT,
        filter: flatRoot(MAX_TREE_NODES - 1, trait), // countNodes === MAX_TREE_NODES
      })),
      previewSegment: vi.fn(),
    })
    renderBuilder(client, SEGMENT.id)
    const add = await screen.findByRole('button', { name: /^add condition$/i })
    expect(add).toBeDisabled()
    expect(screen.getByText(new RegExp(String(MAX_TREE_NODES)))).toBeInTheDocument()
    // Letting the server reject a tree the operator spent five minutes
    // building is the failure being prevented -- so nothing this screen
    // can send (today, or once previewSegment is wired in) fires.
    expect(client.previewSegment).not.toHaveBeenCalled()
    expect(client.createSegment).not.toHaveBeenCalled()
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
  }, 180000)

  it('disables add-condition at the depth cap, and says which cap', async () => {
    // A chain of MAX_TREE_DEPTH - 1 nested single-child groups, bottoming
    // out in a group at depth MAX_TREE_DEPTH - 1 whose own child is a leaf
    // at depth MAX_TREE_DEPTH -- ONE PAST the deepest node validateTree
    // accepts (it rejects on `depth >= MAX_TREE_DEPTH`, so MAX_TREE_DEPTH -
    // 1 is the deepest LEGAL depth, matching GroupCard.test.tsx's own
    // fixture at the same boundary). Every level along the chain renders
    // its OWN Add-condition
    // (all but the deepest stay enabled), so this scopes to the deepest
    // group's own testid rather than an unscoped query, which would be
    // ambiguous the moment the tree has more than one group in it.
    let filter: FilterNode = { kind: 'group', op: 'and', children: [trait('leaf')] }
    for (let i = 0; i < MAX_TREE_DEPTH - 1; i++) {
      filter = { kind: 'group', op: 'and', children: [filter] }
    }
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter })),
      previewSegment: vi.fn(),
    })
    renderBuilder(client, SEGMENT.id)
    const deepPath = Array.from({ length: MAX_TREE_DEPTH - 1 }, () => 0)
    const deepGroup = await screen.findByTestId(`group-${deepPath.join('-')}`)
    const add = within(deepGroup).getByRole('button', { name: /^add condition$/i })
    expect(add).toBeDisabled()
    expect(within(deepGroup).getByText(new RegExp(String(MAX_TREE_DEPTH)))).toBeInTheDocument()
    expect(client.previewSegment).not.toHaveBeenCalled()
  })

  // A tree already at the
  // behaviour cap must NOT block Add-condition -- `newCondition()` always
  // inserts a `trait`, never a `behavior`, and there is no kind-switcher
  // anywhere in this plan to change that. The server would accept the
  // trait; refusing it in the UI is the caps' own failure mode inverted --
  // rejecting a tree the server would take, with no route around it short
  // of the CLI.
  it('does not disable add-condition at the behaviour cap, since it can only ever add a trait', async () => {
    const client = fakeClient({
      segment: vi.fn(async () => ({
        ...SEGMENT,
        filter: flatRoot(MAX_BEHAVIOR_NODES, behaviorLeaf),
      })),
      previewSegment: vi.fn(),
    })
    renderBuilder(client, SEGMENT.id)
    const add = await screen.findByRole('button', { name: /^add condition$/i })
    expect(add).toBeEnabled()
  })

  it('one condition below the node cap, save is still reachable: Add condition is enabled', async () => {
    // The inverse check -- a cap test that only ever asserts the disabled
    // side could pass against code that disables Add-condition
    // unconditionally.
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: flatRoot(MAX_TREE_NODES - 2, trait) })),
    })
    renderBuilder(client, SEGMENT.id)
    const add = await screen.findByRole('button', { name: /^add condition$/i })
    expect(add).toBeEnabled()
  }, 180000)
})

// --- Live counts -- cheap automatically, costly on request. Fake
// timers are scoped to `withFakeTimers`, per test, never file- or
// describe-wide -- every test above this point relies on real timers, and
// `shouldAdvanceTime: true` (Feed.test.tsx's own `withFakeTimers`, mirrored
// here) keeps `userEvent`'s own internal delays working while this file's
// own `vi.advanceTimersByTimeAsync` calls stay exact.

describe('SegmentBuilder -- live counts', () => {
  async function withFakeTimers(run: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await run()
    } finally {
      vi.useRealTimers()
    }
  }

  /** A deferred promise a test can settle on its own schedule -- the only
   * way to provoke "landing order does not track issue order" rather than
   * merely assert it (mirrors `FunnelDetail.test.tsx`'s own `deferred`). */
  function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((res) => {
      resolve = res
    })
    return { promise, resolve }
  }

  /** Adds one condition and types into its key field -- a real edit through
   * `TreeEditor`'s own `onChange`, which is what marks the tree dirty
   * (`SegmentBuilder`'s own doc comment on why merely opening a segment
   * must not). */
  async function typeATrait() {
    await addAFilledCondition()
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

  // `EVER_BEHAVIOUR` above has exactly
  // ONE condition -- "the warning appears inside condition-0" was true
  // whether path association worked or not, and a mutation rendering EVERY
  // warning on EVERY row (`const ownWarnings = warnings`, dropping
  // `warningsAt`'s own path filter) passed every test built on it. This
  // fixture has TWO conditions, only one costly, specifically to make that
  // mutation observable: a warning showing up on the WRONG row is now a
  // distinct, assertable failure, not merely absent evidence.
  const MIXED_TREE: FilterNode = {
    kind: 'group',
    op: 'and',
    children: [
      { kind: 'trait', key: 'plan', operator: '=', value: 'pro' },
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

  /** Renders in EDIT mode against a segment already carrying a `behavior`
   * leaf with an `ever` window -- there is no kind-switcher anywhere in
   * this plan (`GroupCard`'s own doc comment: `newCondition()` always
   * inserts a `trait`), so a behaviour leaf can only ever be reached by
   * fetching one already shaped that way, never by clicking through the
   * create-mode UI. Also performs one real edit (Negate, twice, which
   * restores the original tree) so `dirty` is true going in -- proving the
   * COST WARNING itself blocks the preview, not merely the `dirty` gate
   * never having fired at all. */
  async function addBehaviourWithEverWindow(client: ApiClient) {
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-0')
    const negate = within(screen.getByTestId('condition-0')).getByRole('button', {
      name: /negate/i,
    })
    await userEvent.click(negate)
    await userEvent.click(negate)
  }

  it('previews a cheap tree automatically after editing stops', async () => {
    await withFakeTimers(async () => {
      const client = fakeClient()
      renderBuilder(client)
      await typeATrait()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(client.previewSegment).toHaveBeenCalledTimes(1))
      expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')
    })
  })

  it('does not preview a tree carrying a cost warning, and says why', async () => {
    await withFakeTimers(async () => {
      const client = fakeClient({
        segment: vi.fn(async () => ({ ...SEGMENT, filter: EVER_BEHAVIOUR })),
      })
      await addBehaviourWithEverWindow(client)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4)
      })
      expect(client.previewSegment).not.toHaveBeenCalled()
      expect(screen.getByText(/scans all history/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
    })
  })

  it('renders each warning against the condition it names, via its path -- and not against the one it does not', async () => {
    // costWarnings returns { path, reason }. A warning rendered only as
    // prose in a page-level panel makes the operator hunt for which of 40
    // conditions is meant -- this pins that it renders INSIDE the
    // offending condition's own testid instead, using a tree with a CHEAP
    // trait beside the costly behaviour so a warning leaking onto the wrong
    // row is a distinct, catchable failure (see MIXED_TREE's own comment).
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: MIXED_TREE })),
    })
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-1')
    expect(
      within(screen.getByTestId('condition-1')).getByText(/scans all history/i),
    ).toBeInTheDocument()
    expect(within(screen.getByTestId('condition-0')).queryByText(/scans all history/i)).toBeNull()
  })

  // The `dirty` gate, pinned directly: every cap fixture above already
  // shows a fetched, cheap, non-empty tree never calling `previewSegment`,
  // but each of those ALSO happens to sit at a cap that blocks editing --
  // this fixture sits one full trait below any cap, purely to isolate
  // "opening a segment reaches no server preview" from "a capped tree
  // cannot be edited into firing one" as two different reasons for the
  // same assertion.
  it('does not auto-preview merely from opening an existing (cheap) segment for editing', async () => {
    await withFakeTimers(async () => {
      const client = fakeClient()
      renderBuilder(client, SEGMENT.id)
      await screen.findByTestId('condition-0')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4)
      })
      expect(client.previewSegment).not.toHaveBeenCalled()
    })
  })

  // Step 5's invariant, both halves: a response may be applied only if it
  // belongs to the MOST RECENT request this screen issued. Two counters,
  // not one -- a single counter that only gated `previewing` would leave
  // Run stuck disabled forever the moment an abandoned request's `.finally`
  // fired after a newer one already cleared it; a single counter that only
  // gated the result would apply a same-tree-shape coincidence. This test
  // resolves the NEWER request first (pinning the apply-guard) and then the
  // OLDER one late (pinning that a late, discarded landing changes nothing
  // -- not the count, not the Run button).
  it('discards a stale preview response that lands after the tree has changed again', async () => {
    await withFakeTimers(async () => {
      const p1 = deferred<SegmentPreview>()
      const p2 = deferred<SegmentPreview>()
      const previewSegment = vi.fn().mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise)
      const client = fakeClient({ previewSegment })
      renderBuilder(client)

      await typeATrait()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(previewSegment).toHaveBeenCalledTimes(1))
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

      // A further edit before the first request has landed -- this is the
      // "tree has changed again" the invariant names. `answerIdRef` moves
      // right here, before request 2 is even issued.
      await userEvent.type(
        within(screen.getByTestId('condition-0')).getByRole('combobox', { name: /^trait$/i }),
        'X',
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(previewSegment).toHaveBeenCalledTimes(2))

      // Landing order does not track issue order -- resolve the NEWER
      // request first.
      await act(async () => {
        p2.resolve({ ...PREVIEW, person_count: 999 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('999')
      expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()

      // The OLDER response lands late -- discarded outright: no count
      // change, and Run stays usable rather than getting stuck by a
      // `.finally` that thinks IT was the most recent call.
      await act(async () => {
        p1.resolve({ ...PREVIEW, person_count: 111 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByTestId('segment-preview-count')).toHaveTextContent('999')
      expect(screen.queryByText('111')).toBeNull()
      expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
    })
  })

  // Pins `runPreview`'s `.finally` guard in ISOLATION from the test above --
  // that one always resolves the NEWER call first, so `previewing` would
  // already read false by the time the older call's own `.finally` runs
  // even WITHOUT this guard (verified: a mutation dropping the `.finally`
  // guard alone passed the test above unnoticed). Here the OLDER call
  // settles FIRST, while the newer one is still open, which is the only
  // ordering that actually exercises it.
  it('does not re-enable Run when an older call settles before a still-open newer call', async () => {
    await withFakeTimers(async () => {
      const p1 = deferred<SegmentPreview>()
      const p2 = deferred<SegmentPreview>()
      const previewSegment = vi.fn().mockReturnValueOnce(p1.promise).mockReturnValueOnce(p2.promise)
      const client = fakeClient({ previewSegment })
      renderBuilder(client)

      await typeATrait()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(previewSegment).toHaveBeenCalledTimes(1))
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

      await userEvent.type(
        within(screen.getByTestId('condition-0')).getByRole('combobox', { name: /^trait$/i }),
        'X',
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(previewSegment).toHaveBeenCalledTimes(2))
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

      // The OLDER call (request 1) settles first, while request 2 is still
      // open.
      await act(async () => {
        p1.resolve({ ...PREVIEW, person_count: 111 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

      // Only now, with the truly most recent call settled, may Run re-enable.
      await act(async () => {
        p2.resolve({ ...PREVIEW, person_count: 999 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
      expect(screen.getByTestId('segment-preview-count')).toHaveTextContent('999')
    })
  })

  const BEHAVIOUR_LAST: FilterNode = {
    kind: 'group',
    op: 'and',
    children: [
      {
        kind: 'behavior',
        event: 'import_started',
        aggregate: 'count',
        window: { kind: 'last', n: 7, unit: 'days' },
        operator: '>=',
        value: 1,
      },
    ],
  }

  // Every stale-response test above issues a
  // REPLACEMENT request for the newer state (a second edit, or navigating
  // to a segment that itself auto-previews) -- collapsing `answerIdRef` and
  // `requestIdRef` into a single shared ref still passed every one of them.
  // The case that actually distinguishes two counters from one is a
  // request ABANDONED by an edit that issues NO replacement at all: a
  // cheap tree's debounced preview is still in flight when the operator
  // flips a behaviour's window to `ever`, making the tree costly -- the
  // debounce effect's own early return (`hasCostWarning`) means no second
  // request is ever issued. Under a single shared ref, that edit would
  // invalidate the FIRST request's own identity too, so its `.finally`
  // never fires and Run is stuck disabled forever, with no later call ever
  // coming along to clear it -- the exact funnels defect this design
  // exists to prevent (this component's own doc comment).
  it('re-enables Run when an abandoned request lands late, even though no replacement request was ever issued', async () => {
    await withFakeTimers(async () => {
      const p1 = deferred<SegmentPreview>()
      const previewSegment = vi.fn().mockReturnValueOnce(p1.promise)
      const client = fakeClient({
        segment: vi.fn(async () => ({ ...SEGMENT, filter: BEHAVIOUR_LAST })),
        previewSegment,
      })
      renderBuilder(client, SEGMENT.id)
      await screen.findByTestId('condition-0')

      // One real edit to a still-cheap tree -- dirties it and starts the
      // debounce without changing what makes it cheap.
      const negate = within(screen.getByTestId('condition-0')).getByRole('button', {
        name: /negate/i,
      })
      await userEvent.click(negate)
      await userEvent.click(negate)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(previewSegment).toHaveBeenCalledTimes(1))
      expect(screen.getByRole('button', { name: /run/i })).toBeDisabled()

      // The tree becomes COSTLY before the first request lands -- a real
      // edit that issues no replacement request of its own.
      const windowSelect = within(screen.getByTestId('condition-0')).getByRole('combobox', {
        name: /^window$/i,
      })
      await userEvent.selectOptions(windowSelect, 'ever')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4)
      })
      expect(previewSegment).toHaveBeenCalledTimes(1)
      expect(screen.getByText(/scans all history/i)).toBeInTheDocument()

      // The abandoned request lands late -- discarded (it answers a tree
      // that no longer exists), but Run must re-enable.
      await act(async () => {
        p1.resolve({ ...PREVIEW, person_count: 111 })
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(screen.getByRole('button', { name: /run/i })).toBeEnabled()
      expect(screen.queryByTestId('segment-preview-count')).toBeNull()
    })
  })

  it('an explicit Run previews a tree carrying a cost warning', async () => {
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: EVER_BEHAVIOUR })),
    })
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    await waitFor(() => expect(client.previewSegment).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')
  })

  // --- The count's own instant. A preview can be served from the server's
  // cache up to its TTL, and the response deliberately carries the STORED
  // `as_of` on a hit so a client can say so -- a bare number cannot be told
  // apart from a live one. `FunnelBuilder`/`FunnelDetail` already render
  // exactly this field through `formatRelative`; this screen discarded it.

  it('renders the instant a count was computed at, beside the count', async () => {
    await withFakeTimers(async () => {
      // Pinned by VALUE, not by shape: two hours after `PREVIEW.as_of`, so
      // a render that reached for `new Date()` (or for the moment the
      // request was issued) instead of the response's own `as_of` reads
      // "just now" and fails here.
      vi.setSystemTime(new Date('2026-08-16T02:00:00.000Z'))
      const client = fakeClient()
      renderBuilder(client, SEGMENT.id)
      await screen.findByTestId('condition-0')
      await userEvent.click(screen.getByRole('button', { name: /run/i }))
      expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')
      const asOf = screen.getByTestId('segment-preview-as-of')
      expect(asOf).toHaveTextContent('2 hours ago')
      expect(asOf).not.toHaveTextContent('just now')
    })
  })

  it('a count left standing for a tree that has since changed says so, rather than only dimming', async () => {
    // The transition the "click Run to see a count" sentence can never
    // cover, because it renders only when there has NEVER been a result: a
    // count lands, the tree is then edited, and the number stays on screen
    // at half opacity answering a tree the operator can no longer see. A
    // costly tree is used throughout so no auto-preview can race in and
    // replace the result while the assertion runs.
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: EVER_BEHAVIOUR })),
    })
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /run/i }))
    expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')
    expect(screen.queryByTestId('segment-preview-stale-note')).toBeNull()

    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
    )
    expect(screen.getByTestId('segment-preview')).toHaveAttribute('data-stale', 'true')
    // The count is still there -- this is not "hide it", it is "say what it
    // is". A dimmed number with no words is the thing being fixed.
    expect(screen.getByTestId('segment-preview-count')).toHaveTextContent('42')
    expect(screen.getByTestId('segment-preview-stale-note')).toHaveTextContent(/earlier version/i)
  })

  // --- A tree the server cannot parse is never previewed, on either path.
  //
  // Adding a condition marks the tree dirty, so the debounce fired
  // `previewSegment` on a tree carrying `newCondition()`'s empty `key` and
  // the operator got an error banner about a condition they had not started
  // filling in. The gate is `draft.complete` -- the SAME `safeParse` Save is
  // already refused on, never a second notion of "filled in".
  //
  // The two halves are pinned SEPARATELY and cannot stand in for each other:
  // the guard inside `runPreview` is the only thing on the automatic path
  // (which has no button and therefore no attribute), and the button's own
  // `disabled` is the only thing an assertion on the control can see.

  it('does not auto-preview a condition that has not been filled in', async () => {
    await withFakeTimers(async () => {
      const client = fakeClient()
      renderBuilder(client)
      await screen.findByTestId('group-')
      // Deliberately NOT `addAFilledCondition` -- the whole point is the
      // tree between the click and the first keystroke.
      await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4)
      })
      expect(client.previewSegment).not.toHaveBeenCalled()
      // ...and no banner about it either: the row already says what is
      // wrong, and a preview error would be about the wrong thing entirely.
      expect(screen.queryByText(/could not preview/i)).toBeNull()
      expect(
        within(screen.getByTestId('condition-0')).getByText(/not finished/i),
      ).toBeInTheDocument()
    })
  })

  it('auto-previews the same tree the moment it becomes complete', async () => {
    // The other side of the gate, so "never previews" cannot pass for
    // "previews only complete trees". Same fixture, one keystroke apart.
    await withFakeTimers(async () => {
      const client = fakeClient()
      renderBuilder(client)
      await screen.findByTestId('group-')
      await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 4)
      })
      expect(client.previewSegment).not.toHaveBeenCalled()

      await userEvent.type(traitKeyOf(), 'plan')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
      })
      await waitFor(() => expect(client.previewSegment).toHaveBeenCalledTimes(1))
    })
  })

  it('disables Run while a condition is unfinished, and re-enables it once filled in', async () => {
    const client = fakeClient()
    renderBuilder(client)
    await screen.findByTestId('group-')
    await userEvent.click(screen.getByRole('button', { name: /add condition/i }))
    const run = () => screen.getByRole('button', { name: /^run$/i })
    expect(run()).toBeDisabled()
    // ...and on the REQUEST too, because a screen that disables the wrong
    // control and still fires the call would pass a control-only test.
    await userEvent.click(run())
    expect(client.previewSegment).not.toHaveBeenCalled()

    await userEvent.type(traitKeyOf(), 'plan')
    expect(run()).toBeEnabled()
  })

  it('refuses Run for an incompleteness nested inside a leaf, not only for a blank top-level field', async () => {
    // An `absolute` window with neither bound filled in raises its issues at
    // `window.from`/`window.to`, two levels inside the leaf. A gate that
    // looked at the node's own fields rather than at the whole-tree parse
    // would let this one through.
    const client = fakeClient()
    renderBuilder(client)
    await screen.findByTestId('group-')
    await addAFilledCondition()
    const row = () => within(screen.getByTestId('condition-0'))
    await userEvent.selectOptions(
      row().getByRole('combobox', { name: 'Match on' }),
      'what they did',
    )
    await userEvent.type(row().getByRole('combobox', { name: /event/i }), 'checkout')
    expect(screen.getByRole('button', { name: /^run$/i })).toBeEnabled()

    await userEvent.selectOptions(row().getByRole('combobox', { name: 'Window' }), 'absolute')
    expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled()
  })
})

// --- Every tree fixture above has a `group` at its root, and that is the
// shape being broken here. `SegmentQuery.filter` is the whole `FilterNode`
// union, so a segment authored by the CLI can legally carry a bare leaf, or
// a `not`, at its root. The editor wraps such a root in a one-child `and`
// group to render it -- and while that wrapping happened invisibly inside
// `TreeEditor`, this screen computed `costWarnings` against the UN-wrapped
// tree it still held, so every warning path was exactly one segment shorter
// than the `ConditionRow` it named and `warningsAt`'s exact-length match
// dropped all of them. The operator was told the segment was expensive and
// shown nothing about which condition. The fix is one tree: `normaliseRoot`
// is applied where a tree ENTERS this screen's state, and `TreeEditor` takes
// a `Group`, so there is no second tree to disagree with.

describe('SegmentBuilder -- a root that is not a group', () => {
  const everBehaviour: FilterNode = {
    kind: 'behavior',
    event: 'purchase',
    aggregate: 'count',
    window: { kind: 'ever' },
    operator: '>=',
    value: 1,
  }
  const bareTrait: FilterNode = { kind: 'trait', key: 'plan', operator: '=', value: 'pro' }

  it('renders a bare-leaf root cost warning against the condition row that names it', async () => {
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: everBehaviour })),
    })
    renderBuilder(client, SEGMENT.id)
    const row = await screen.findByTestId('condition-0')
    expect(within(row).getByText(/scans all history/i)).toBeInTheDocument()
  })

  it('renders a not-rooted tree cost warning against the condition row that names it', async () => {
    // A second shape, one level deeper again: `not` never consumes a path
    // segment in the editor's addressing, so the negated behaviour leaf is
    // still `condition-0`.
    const client = fakeClient({
      segment: vi.fn(async () => ({
        ...SEGMENT,
        filter: { kind: 'not', child: everBehaviour } as FilterNode,
      })),
    })
    renderBuilder(client, SEGMENT.id)
    const row = await screen.findByTestId('condition-0')
    expect(within(row).getByText(/scans all history/i)).toBeInTheDocument()
  })

  it('a group root still renders its warning against the row that names it (the control)', async () => {
    // Passes today, and must keep passing -- it is what makes the two above
    // a PATH defect rather than a warnings defect.
    const client = fakeClient({
      segment: vi.fn(async () => ({
        ...SEGMENT,
        filter: { kind: 'group', op: 'and', children: [everBehaviour] } as FilterNode,
      })),
    })
    renderBuilder(client, SEGMENT.id)
    const row = await screen.findByTestId('condition-0')
    expect(within(row).getByText(/scans all history/i)).toBeInTheDocument()
  })

  // --- The save path. Normalising on entry must not make a stored bare-leaf
  // tree silently acquire a wrapper group the operator never asked for.

  it('opening a bare-leaf-rooted segment and saving it untouched sends nothing at all', async () => {
    // `originalRoot` holds the SAME normalised tree the editor renders, so
    // there is nothing to differ and no request to make -- the stored tree
    // keeps its shape unless the operator actually edits it.
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: bareTrait })),
    })
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
    expect(client.renameSegment).not.toHaveBeenCalled()
  })

  it('editing a bare-leaf-rooted segment saves the wrapped shape the editor showed', async () => {
    // The accepted behaviour change, pinned rather than left implicit: an
    // EDITED bare-leaf root is written back wrapped in a one-child `and`,
    // which compiles identically to the bare child. This was already true
    // before the tree was normalised on entry -- every edit came back up
    // from the editor wrapped -- so what is new is only that an UNTOUCHED
    // segment now provably sends nothing (the test above).
    const client = fakeClient({
      segment: vi.fn(async () => ({ ...SEGMENT, filter: bareTrait })),
    })
    renderBuilder(client, SEGMENT.id)
    await screen.findByTestId('condition-0')
    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
    )
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    const call = client.updateSegmentTree.mock.calls[0]
    if (!call) throw new Error('updateSegmentTree was not called')
    expect(call[2]).toEqual({
      ast_version: 1,
      filter: {
        kind: 'group',
        op: 'and',
        children: [{ kind: 'not', child: bareTrait }],
      },
    })
  })
})

// --- Every fixture above mounts ONE builder against ONE segment in ONE
// project and never changes either while mounted; `renderEdit` mutates the
// client's mock BEFORE rendering. There was no test in this file where the
// load effect ran twice, which is the shape being broken here.
//
// The invariant: this screen's state must never describe a segment other
// than the one addressed by (`activeId`, `editId`) right now. Writing state
// only on a SUCCESSFUL load broke it in four places at once -- a failing
// re-fetch, a 404 after a project switch, edit -> edit, and edit -> the
// create route, which React reconciles onto the same component instance --
// and `handleSave` then combined the previous segment's tree with the id in
// the URL and the currently active project.
//
// The routes below carry NO `key`, deliberately. `AppRouter` gives its two
// `SegmentBuilder` routes distinct keys as defence in depth, but a key is
// one edit away from being removed; these tests hold the screen to the
// harder case, where the instance survives every navigation.

const PROJECTS_TWO = [
  ...PROJECTS,
  {
    id: 2,
    name: 'Beta',
    slug: 'beta',
    created_at: '',
    retention_months: 24,
    monthly_event_quota: null,
    disabled_at: null,
    deleting_at: null,
  },
]

/** The header project switcher, reduced to the one thing it does that
 * matters here -- it is reachable from every screen, including an open
 * segment editor. Takes the target project so a test can drive a ROUND TRIP
 * (away and back), which is the shape every in-flight fixture below the
 * first block used to be unable to express: the label of the "back" button
 * deliberately does not contain "switch project", so the existing queries
 * for it stay unambiguous. */
function SwitchProject(props: { to: number; label: string }) {
  const { setActiveId } = useProject()
  return (
    <button type="button" onClick={() => setActiveId(props.to)}>
      {props.label}
    </button>
  )
}

function GoTo(props: { to: string; label: string }) {
  const navigate = useNavigate()
  return (
    <button type="button" onClick={() => navigate(props.to)}>
      {props.label}
    </button>
  )
}

/** Like `renderBuilder`, but the project and the route can both change
 * while the builder stays mounted. */
function renderLiveBuilder(client: ApiClient, initialPath: string, onUnauthorized?: () => void) {
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ProjectProvider projects={PROJECTS_TWO} initialId={1}>
        <SwitchProject to={2} label="switch project" />
        <SwitchProject to={1} label="return to project 1" />
        <GoTo to={segmentEditPath(7)} label="go to segment 7" />
        <GoTo to={segmentEditPath(8)} label="go to segment 8" />
        <GoTo to={ROUTES.segmentNew} label="go to create" />
        <Routes>
          <Route
            path={ROUTES.segmentNew}
            element={<SegmentBuilder client={client} onUnauthorized={onUnauthorized} />}
          />
          <Route
            path="/segments/:id/edit"
            element={<SegmentBuilder client={client} onUnauthorized={onUnauthorized} />}
          />
          <Route path={ROUTES.segments} element={<p>segments list</p>} />
          <Route path="/segments/:id" element={<p>segment detail</p>} />
        </Routes>
      </ProjectProvider>
    </MemoryRouter>,
  )
}

describe('SegmentBuilder -- the identity its state describes', () => {
  it('a project switch whose fetch 404s leaves nothing of the previous project segment on screen', async () => {
    const client = fakeClient({
      segment: vi.fn(async (projectId: number) => {
        if (projectId !== 1) throw new ApiError(404, 'not_found')
        return SEGMENT
      }),
    })
    renderLiveBuilder(client, segmentEditPath(7))
    expect(await screen.findByTestId('condition-0')).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toHaveValue('Paying customers')

    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load this segment/i)

    // Not merely "an error is shown above it" -- the previous project's
    // segment is GONE. It was fully editable here, one click from being
    // written to the same id under a different project.
    expect(screen.queryByTestId('condition-0')).toBeNull()
    expect(screen.getByLabelText(/name/i)).toHaveValue('')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('refuses to save a segment it never loaded, even once the form has been filled in by hand', async () => {
    // The reset above already leaves an empty, unsaveable form -- so this
    // fills in a name and a condition by hand, which is two clicks away
    // after any failed load, leaving `canSave`'s completed-load term as the
    // only thing between it and a cross-project write.
    const client = fakeClient({
      segment: vi.fn(async (projectId: number) => {
        if (projectId !== 1) throw new ApiError(404, 'not_found')
        return SEGMENT
      }),
    })
    renderLiveBuilder(client, segmentEditPath(7))
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))
    await screen.findByRole('alert')

    await userEvent.type(screen.getByLabelText(/name/i), 'Anything at all')
    // FILLED in, deliberately: a freshly added condition is an incomplete
    // draft, which disables Save on its own, and this test is about the
    // completed-load term being the thing that refuses. Leaving the key
    // blank would let `loaded` be removed entirely with this still green.
    await addAFilledCondition()
    const save = screen.getByRole('button', { name: /^save$/i })
    expect(save).toBeDisabled()
    // Asserted on the REQUEST as well as the control -- a screen that
    // disables the wrong button but still fires the call would pass a
    // control-only test.
    await userEvent.click(save)
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
    expect(client.renameSegment).not.toHaveBeenCalled()
    expect(client.createSegment).not.toHaveBeenCalled()
  })

  it('edit -> edit with a failing second fetch never leaves the first segment tree on screen', async () => {
    const client = fakeClient({
      segment: vi.fn(async (_projectId: number, id: number) => {
        if (id !== 7) throw new ApiError(500, 'server_error')
        return SEGMENT
      }),
    })
    renderLiveBuilder(client, segmentEditPath(7))
    expect(await screen.findByTestId('condition-0')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /go to segment 8/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load this segment/i)
    expect(screen.queryByTestId('condition-0')).toBeNull()
    expect(screen.getByLabelText(/name/i)).toHaveValue('')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('edit -> the create route opens an empty form, never the previous segment pre-filled', async () => {
    const client = fakeClient()
    renderLiveBuilder(client, segmentEditPath(7))
    await screen.findByTestId('condition-0')

    await userEvent.click(screen.getByRole('button', { name: /go to create/i }))
    expect(await screen.findByRole('heading', { name: /create segment/i })).toBeInTheDocument()
    expect(screen.getByLabelText(/name/i)).toHaveValue('')
    expect(screen.queryByTestId('condition-0')).toBeNull()
    expect(screen.getByText(/no conditions yet/i)).toBeInTheDocument()

    const save = screen.getByRole('button', { name: /^save$/i })
    expect(save).toBeDisabled()
    await userEvent.click(save)
    expect(client.createSegment).not.toHaveBeenCalled()
  })

  it('a segment that loaded once is not saveable when a later visit to it fails to load', async () => {
    // The one shape in which the two mechanisms behind this invariant can
    // disagree, and the only one that pins the reset's own
    // `setLoadedIdentity(null)`: `loaded` compares `loadedIdentity` against
    // the CURRENT identity, so a value left standing from an earlier,
    // SUCCESSFUL load of the same identity is invisible until the operator
    // comes back to it -- 7 loads, 8 fails, 7 fails. Without the line,
    // `loadedIdentity` still reads `1:7`, `identity` reads `1:7`, and a
    // segment this screen has just failed to read reports itself loaded.
    let sevenFetches = 0
    const client = fakeClient({
      segment: vi.fn(async (_projectId: number, id: number) => {
        if (id !== 7) throw new ApiError(500, 'server_error')
        sevenFetches += 1
        if (sevenFetches > 1) throw new ApiError(500, 'server_error')
        return SEGMENT
      }),
    })
    renderLiveBuilder(client, segmentEditPath(7))
    await screen.findByTestId('condition-0')

    await userEvent.click(screen.getByRole('button', { name: /go to segment 8/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load this segment/i)

    await userEvent.click(screen.getByRole('button', { name: /go to segment 7/i }))
    await waitFor(() => expect(client.segment).toHaveBeenCalledTimes(3))
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not load this segment/i),
    )

    // Filled in by hand, as in the sibling test above -- name AND condition,
    // so every other term of `canSave` is satisfied and the completed-load
    // term is the only thing between two clicks and a write to a segment
    // whose definition was never read.
    await userEvent.type(screen.getByLabelText(/name/i), 'Anything at all')
    await addAFilledCondition()
    const save = screen.getByRole('button', { name: /^save$/i })
    expect(save).toBeDisabled()
    await userEvent.click(save)
    expect(client.updateSegmentTree).not.toHaveBeenCalled()
    expect(client.renameSegment).not.toHaveBeenCalled()
  })

  it('a count run for the previous segment is not left standing against the next one', async () => {
    // The same invariant applied to the derived state a save does not read:
    // a preview belongs to the tree that answered it, and that tree is gone.
    const client = fakeClient({
      segment: vi.fn(async (_projectId: number, id: number) => ({ ...SEGMENT, id })),
    })
    renderLiveBuilder(client, segmentEditPath(7))
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')

    await userEvent.click(screen.getByRole('button', { name: /go to segment 8/i }))
    await waitFor(() => expect(client.segment).toHaveBeenCalledTimes(2))
    await screen.findByTestId('condition-0')
    expect(screen.queryByTestId('segment-preview-count')).toBeNull()
  })
})

// --- A segment that does not exist yet has no identity to be wrong about.
// It is addressed by the ROUTE alone: `createSegment` takes the project as
// an argument at save time, so nothing composed here is bound to the
// project it was drafted under, and there is no correctness argument for
// throwing the work away when the header moves. What a switch DOES
// invalidate is the count -- that was computed under one project and
// answers a question about its people, not the new one's.
//
// The other half of this -- that the reset still fires for every EDIT-mode
// identity change, which is what closes the four doors above -- is pinned by
// the block above, not here: keying the form reset to the route alone (so it
// never fires in edit mode) fails three of its tests plus the return-visit
// one. This block is only about the case where there is no identity to be
// wrong about.

describe('SegmentBuilder -- composing a new segment across a project switch', () => {
  it('keeps a half-composed new segment when the header project changes', async () => {
    const client = fakeClient()
    renderLiveBuilder(client, ROUTES.segmentNew)
    await screen.findByTestId('group-')
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    await addAFilledCondition()
    expect(saveButton()).toBeEnabled()

    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))

    expect(screen.getByLabelText(/name/i)).toHaveValue('VIPs')
    expect(screen.getByTestId('condition-0')).toBeInTheDocument()
    expect(saveButton()).toBeEnabled()
  })

  it('drops a count computed under the project that was just switched away from', async () => {
    // The count is the half a switch genuinely invalidates. `previewSegment`
    // answers only its FIRST call so that the debounce firing later cannot
    // put a number back on screen and make this pass for the wrong reason.
    let previews = 0
    const client = fakeClient({
      previewSegment: vi.fn(() => {
        previews += 1
        return previews === 1 ? Promise.resolve(PREVIEW) : new Promise<SegmentPreview>(() => {})
      }),
    })
    renderLiveBuilder(client, ROUTES.segmentNew)
    await screen.findByTestId('group-')
    await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
    // Through the shared helper, which FILLS the condition in: Run refuses a
    // tree the server cannot parse, so a bare "Add condition" here would
    // leave nothing to count and this would pass for the wrong reason.
    await addAFilledCondition()
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    expect(await screen.findByTestId('segment-preview-count')).toHaveTextContent('42')

    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))

    expect(screen.queryByTestId('segment-preview-count')).toBeNull()
    // The work itself is still there -- this is the count going, not the
    // form going with it.
    expect(screen.getByTestId('condition-0')).toBeInTheDocument()
  })
})

// --- A save is state that has not landed yet, and the header project
// switcher is reachable for the whole time it is in flight. `PATCH
// /v1/segments/:id` decides whether to touch the filter tree by whether the
// body carries one AT ALL, so a baseline written against the wrong segment
// is not a cosmetic error: the next Save on that segment, with nothing
// changed, sends a tree and costs it the cached count snapshot the two-method
// split exists to protect.

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

/** A request the test settles by hand, so a save can be held open across a
 * project switch. */
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const TREE_BETA: FilterNode = {
  kind: 'group',
  op: 'and',
  children: [{ kind: 'trait', key: 'tier', operator: '=', value: 'free' }],
}

/** Segment 7 exists in BOTH projects, with a different name and a different
 * tree in each -- the case the id alone cannot tell apart. Every PATCH is
 * held open until the test settles it. */
function gatedSaveClient() {
  const renames: Deferred<Segment>[] = []
  const trees: Deferred<Segment>[] = []
  const client = fakeClient({
    segment: vi.fn(async (projectId: number, id: number) =>
      projectId === 1
        ? { ...SEGMENT, id, name: 'Alpha seven', filter: TREE }
        : { ...SEGMENT, id, name: 'Beta seven', filter: TREE_BETA },
    ),
    renameSegment: vi.fn(() => {
      const gate = deferred<Segment>()
      renames.push(gate)
      return gate.promise
    }),
    updateSegmentTree: vi.fn(() => {
      const gate = deferred<Segment>()
      trees.push(gate)
      return gate.promise
    }),
  })
  return { client, renames, trees }
}

/** Opens Alpha's segment 7, changes BOTH fields, saves, and switches the
 * header to Beta with both PATCHes still open. Returns with Beta's segment
 * 7 loaded and on screen. */
async function saveAlphaThenSwitchToBeta(client: ApiClient & { segment: Mock }) {
  renderLiveBuilder(client, segmentEditPath(7))
  await screen.findByTestId('condition-0')
  await userEvent.clear(screen.getByLabelText(/name/i))
  await userEvent.type(screen.getByLabelText(/name/i), 'Renamed')
  await userEvent.click(
    within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
  )
  await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
  await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled())

  await userEvent.click(screen.getByRole('button', { name: /switch project/i }))
  await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('Beta seven'))
}

describe('SegmentBuilder -- a save still in flight when the project changes', () => {
  it('does not advance the tree baseline onto the segment now on screen, so its untouched Save sends nothing', async () => {
    const { client, renames, trees } = gatedSaveClient()
    await saveAlphaThenSwitchToBeta(client)

    // The partial failure: the tree PATCH commits, the rename does not, so
    // `Promise.all` rejects and nothing navigates.
    await act(async () => {
      trees[0]?.resolve(SEGMENT)
      renames[0]?.reject(new ApiError(500, 'server_error'))
    })

    // Beta's segment 7, untouched. The promise this screen makes is that
    // this issues no request at all.
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
    expect(client.updateSegmentTree).toHaveBeenCalledTimes(1)
    expect(client.updateSegmentTree).not.toHaveBeenCalledWith(2, 7, expect.anything())
  })

  it('does not advance the name baseline onto the segment now on screen', async () => {
    const { client, renames, trees } = gatedSaveClient()
    await saveAlphaThenSwitchToBeta(client)

    // The other half of the partial failure: the rename commits, the tree
    // PATCH does not.
    await act(async () => {
      renames[0]?.resolve(SEGMENT)
      trees[0]?.reject(new ApiError(500, 'server_error'))
    })

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
    expect(client.renameSegment).toHaveBeenCalledTimes(1)
    expect(client.renameSegment).not.toHaveBeenCalledWith(2, 7, 'Beta seven')
  })

  it('does not report the failure over the segment now on screen, which was never saved', async () => {
    const { client, renames, trees } = gatedSaveClient()
    await saveAlphaThenSwitchToBeta(client)

    await act(async () => {
      trees[0]?.resolve(SEGMENT)
      renames[0]?.reject(new ApiError(500, 'server_error'))
    })

    expect(screen.queryByText(/could not save this segment/i)).toBeNull()
  })

  it('does not navigate to the detail of the segment the URL now names', async () => {
    // Both PATCHes commit -- against ALPHA's segment 7. Navigating to
    // `/segments/7` now would present BETA's segment 7 as the result of a
    // save that was never made to it.
    const { client, renames, trees } = gatedSaveClient()
    await saveAlphaThenSwitchToBeta(client)

    await act(async () => {
      renames[0]?.resolve(SEGMENT)
      trees[0]?.resolve(SEGMENT)
    })

    expect(screen.queryByText('segment detail')).toBeNull()
    expect(screen.getByLabelText(/name/i)).toHaveValue('Beta seven')
  })

  it('re-enables Save on the segment now on screen rather than waiting for the abandoned save to settle', async () => {
    // The in-flight flag belongs to the identity that issued the save. Left
    // standing, it disables Save on a segment whose own save has not even
    // been attempted -- and the abandoned request's own completion is
    // dropped, so nothing else would ever clear it.
    const { client } = gatedSaveClient()
    await saveAlphaThenSwitchToBeta(client)

    expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled()
  })

  it('does not let an abandoned save clear the in-flight flag of the save that replaced it', async () => {
    const { client, renames, trees } = gatedSaveClient()
    await saveAlphaThenSwitchToBeta(client)

    // Beta's own save, held open too.
    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
    )
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()

    await act(async () => {
      trees[0]?.resolve(SEGMENT)
      renames[0]?.reject(new ApiError(500, 'server_error'))
    })

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })
})

// --- Every fixture in the block above moves the form's address ONCE, away,
// and leaves it there. That shape cannot tell a guard that compares
// addresses apart from one that counts them, because the two only disagree
// on a ROUND TRIP: leave a form and come back to it and the address reads
// exactly as it did when the abandoned save was issued, so an equality check
// lets that save land on top of the save that replaced it. What follows is
// that round trip. `formGenerationRef` only ever increases, so a returned-to
// form is a different generation from the identical-looking one it left, and
// the case below cannot be expressed at all rather than merely going
// untested.

describe('SegmentBuilder -- a save abandoned by a round trip back to its own form', () => {
  /** Opens Alpha's segment 7, renames it, saves with the PATCH held open,
   * then leaves for Beta and comes straight back. Returns with Alpha's
   * segment 7 loaded again and save A still in flight. */
  async function saveAlphaThenLeaveAndReturn(client: ApiClient & { segment: Mock }) {
    renderLiveBuilder(client, segmentEditPath(7))
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'Renamed')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled())

    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('Beta seven'))
    await userEvent.click(screen.getByRole('button', { name: /return to project 1/i }))
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('Alpha seven'))
  }

  /** A second save, against the very same segment under the very same
   * project the abandoned one was issued for -- held open too. */
  async function saveTheSameSegmentAgain(client: ApiClient & { updateSegmentTree: Mock }) {
    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
    )
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  }

  it('a succeeding abandoned save neither clears the live save in-flight flag nor navigates off the form', async () => {
    const { client, renames, trees } = gatedSaveClient()
    await saveAlphaThenLeaveAndReturn(client)
    await saveTheSameSegmentAgain(client)

    // The abandoned save COMMITS. Its baseline advance is not even wrong --
    // it really is this segment under this project -- which is exactly why
    // nothing above can see the rest of what it does.
    await act(async () => {
      renames[0]?.resolve(SEGMENT)
    })

    // Its `.finally` must not clear the flag of the save that replaced it,
    // and its `.then` must not yank the operator to the detail route off a
    // form they are still editing.
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
    expect(screen.queryByText('segment detail')).toBeNull()
    expect(screen.getByLabelText(/name/i)).toHaveValue('Alpha seven')

    // Not stuck: the live save's own completion still lands.
    await act(async () => {
      trees[0]?.resolve(SEGMENT)
    })
    expect(await screen.findByText('segment detail')).toBeInTheDocument()
  })

  it('a failing abandoned save does not report itself over the live save that replaced it', async () => {
    const { client, renames } = gatedSaveClient()
    await saveAlphaThenLeaveAndReturn(client)
    await saveTheSameSegmentAgain(client)

    await act(async () => {
      renames[0]?.reject(new ApiError(500, 'server_error'))
    })

    expect(screen.queryByText(/could not save this segment/i)).toBeNull()
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })
})

// --- A segment that does not exist yet outlives a project switch, and so
// must the create still open against it. The two halves are individually
// defensible and compose badly: keeping the half-composed form while
// clearing the in-flight flag on the same switch hands the operator a fully
// populated form with Save re-enabled and the first `createSegment` still
// open -- two clicks, two segments, one under each project. The in-flight
// flag and the failure banner are therefore reset WITH THE FORM, not with
// the identity, and every continuation of a create is guarded by the form's
// generation to match.

/** Every `createSegment` and `updateSegmentTree` held open until the test
 * settles it, so a create can be kept in flight across a project switch or a
 * navigation to a different form. */
function gatedCreateClient() {
  const creates: Deferred<Segment>[] = []
  const trees: Deferred<Segment>[] = []
  const client = fakeClient({
    segment: vi.fn(async (_projectId: number, id: number) => ({ ...SEGMENT, id })),
    createSegment: vi.fn(() => {
      const gate = deferred<Segment>()
      creates.push(gate)
      return gate.promise
    }),
    updateSegmentTree: vi.fn(() => {
      const gate = deferred<Segment>()
      trees.push(gate)
      return gate.promise
    }),
  })
  return { client, creates, trees }
}

/** Composes a new segment and saves it, with the create held open. */
async function composeAndSaveANewSegment(client: ApiClient & { createSegment: Mock }) {
  await screen.findByTestId('group-')
  await userEvent.type(screen.getByLabelText(/name/i), 'VIPs')
  await addAFilledCondition()
  await userEvent.click(saveButton())
  await waitFor(() => expect(client.createSegment).toHaveBeenCalledTimes(1))
  expect(saveButton()).toBeDisabled()
}

describe('SegmentBuilder -- a create still in flight when the project changes', () => {
  it('keeps the half-composed segment AND keeps Save disabled, so the switch cannot produce a second copy', async () => {
    const { client, creates } = gatedCreateClient()
    renderLiveBuilder(client, ROUTES.segmentNew)
    await composeAndSaveANewSegment(client)

    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))

    // The work survives, as it must -- nothing composed here is bound to the
    // project it was drafted under.
    expect(screen.getByLabelText(/name/i)).toHaveValue('VIPs')
    expect(screen.getByTestId('condition-0')).toBeInTheDocument()

    // And the create that is still open still holds Save down. Asserted on
    // the REQUEST as well as the control: a screen that disables the wrong
    // button but still fires the call would pass a control-only test.
    const save = screen.getByRole('button', { name: /^save$/i })
    expect(save).toBeDisabled()
    await userEvent.click(save)
    expect(client.createSegment).toHaveBeenCalledTimes(1)
    expect(client.createSegment).not.toHaveBeenCalledWith(2, 'VIPs', expect.anything())

    // Not stuck either: the create settling releases it.
    await act(async () => {
      creates[0]?.resolve({ ...SEGMENT, id: 42 })
    })
    expect(await screen.findByText('segments list')).toBeInTheDocument()
  })
})

describe('SegmentBuilder -- a create abandoned by leaving the form', () => {
  /** Starts a create, then walks off to segment 7 and starts a save there,
   * with both requests held open. */
  async function startACreateThenSaveSegmentSeven(
    client: ApiClient & { createSegment: Mock; updateSegmentTree: Mock },
  ) {
    renderLiveBuilder(client, ROUTES.segmentNew)
    await composeAndSaveANewSegment(client)

    await userEvent.click(screen.getByRole('button', { name: /go to segment 7/i }))
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('Paying customers'))

    await userEvent.click(
      within(screen.getByTestId('condition-0')).getByRole('button', { name: /negate/i }),
    )
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.updateSegmentTree).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  }

  it('does not let the abandoned create clear the in-flight flag of the save that replaced it', async () => {
    const { client, creates } = gatedCreateClient()
    await startACreateThenSaveSegmentSeven(client)

    await act(async () => {
      creates[0]?.reject(new ApiError(500, 'server_error'))
    })

    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('does not report the abandoned create failure over the segment now on screen', async () => {
    const { client, creates } = gatedCreateClient()
    await startACreateThenSaveSegmentSeven(client)

    await act(async () => {
      creates[0]?.reject(new ApiError(500, 'server_error'))
    })

    // The create branch's own copy -- true of a create, and a claim about
    // the wrong thing over a segment whose save is still open.
    expect(screen.queryByText(/nothing was changed on the server/i)).toBeNull()
  })

  // THIS PIN WAS DELIBERATELY INVERTED (#122). It previously asserted the
  // navigation fired here, pinning the create continuation as unguarded so a
  // later tidy-up could not wrap it in silence. That was the right thing to
  // pin and the wrong shape to pin it in: the case it locked down is the one
  // where the navigation does harm.
  //
  // The operator is editing segment 7 when a create issued from the create
  // route lands. Firing the navigation takes them to the list and discards
  // whatever they had typed into segment 7 -- the same harm every other
  // continuation in this file is guarded against.
  //
  // The exception itself is NOT removed; see the test below, which is the
  // case it exists for and which still navigates. What is given up here is
  // the acknowledgement: this create commits with nothing on screen saying
  // so. Accepted as the lesser harm -- the segment is on the list the moment
  // they look, and the work they were typing is not recoverable once yanked.
  it('a create that lands after the operator moved to another form leaves that form alone', async () => {
    const { client, creates } = gatedCreateClient()
    renderLiveBuilder(client, ROUTES.segmentNew)
    await composeAndSaveANewSegment(client)

    await userEvent.click(screen.getByRole('button', { name: /go to segment 7/i }))
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('Paying customers'))

    await act(async () => {
      creates[0]?.resolve({ ...SEGMENT, id: 42 })
    })

    expect(screen.queryByText('segments list')).toBeNull()
    // Still on segment 7's form, with its contents intact -- which is the
    // whole point. Asserting only "did not navigate" would pass against a
    // screen that had been cleared instead.
    expect(screen.getByLabelText(/name/i)).toHaveValue('Paying customers')
  })

  // The other half, and the reason the exception is narrowed rather than
  // deleted. An operator who waits on the create form is taken to the list,
  // because that navigation is the only acknowledgement a create ever gets --
  // without it they are left looking at a form whose contents are already
  // saved.
  it('a create that lands while the operator is still on the create form navigates to the list', async () => {
    const { client, creates } = gatedCreateClient()
    renderLiveBuilder(client, ROUTES.segmentNew)
    await composeAndSaveANewSegment(client)

    await act(async () => {
      creates[0]?.resolve({ ...SEGMENT, id: 42 })
    })
    expect(await screen.findByText('segments list')).toBeInTheDocument()
  })

  // A project switch is NOT a form change on the create route: `formIdentity`
  // is 'new' whatever the project, so the generation does not bump and this
  // navigation still fires. Pinned because it is the case most likely to be
  // broken by someone "tightening" the guard to compare identities rather
  // than form identities -- which would silently swallow the acknowledgement
  // for every create made either side of a switch.
  it('a create that lands after a project switch still navigates, the form never having changed', async () => {
    const { client, creates } = gatedCreateClient()
    renderLiveBuilder(client, ROUTES.segmentNew)
    await composeAndSaveANewSegment(client)

    await userEvent.click(screen.getByRole('button', { name: 'switch project' }))

    await act(async () => {
      creates[0]?.resolve({ ...SEGMENT, id: 42 })
    })
    expect(await screen.findByText('segments list')).toBeInTheDocument()
  })
})

// --- The rest of what the in-flight work left unpinned: two writes in the
// reset that are load-bearing but invisible to every fixture above, the
// preview counter bump beside them, and the second of the two continuations
// deliberately left unguarded.

describe('SegmentBuilder -- what the reset clears, and what stays unguarded', () => {
  it('a failed save banner does not stand over the segment a project switch put on screen', async () => {
    // Same class as the guarded catch, reached with no request in flight at
    // all: the banner is a fact about the attempt that raised it, and that
    // attempt was made against a form that is gone.
    const { client, renames } = gatedSaveClient()
    renderLiveBuilder(client, segmentEditPath(7))
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'Renamed')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.renameSegment).toHaveBeenCalledTimes(1))

    await act(async () => {
      renames[0]?.reject(new ApiError(500, 'server_error'))
    })
    expect(await screen.findByText(/could not save this segment/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('Beta seven'))

    expect(screen.queryByText(/could not save this segment/i)).toBeNull()
  })

  it('a failed load banner does not stand over the segment that loads next', async () => {
    const client = fakeClient({
      segment: vi.fn(async (_projectId: number, id: number) => {
        if (id !== 7) throw new ApiError(500, 'server_error')
        return SEGMENT
      }),
    })
    renderLiveBuilder(client, segmentEditPath(8))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not load this segment/i)

    await userEvent.click(screen.getByRole('button', { name: /go to segment 7/i }))
    await screen.findByTestId('condition-0')

    expect(screen.queryByText(/could not load this segment/i)).toBeNull()
  })

  it('a count still in flight for the project just left never lands on the segment now on screen', async () => {
    // The existing sibling test settles its preview BEFORE the switch, so
    // the reset's own `setPreviewResult(null)` is enough to pass it. This
    // one holds the request open across the switch, which is the only shape
    // that reaches the counter bump: without it the abandoned response is
    // applied, putting Alpha's count under Beta's segment.
    const gate = deferred<SegmentPreview>()
    const client = fakeClient({
      segment: vi.fn(async (projectId: number, id: number) =>
        projectId === 1
          ? { ...SEGMENT, id, name: 'Alpha seven', filter: TREE }
          : { ...SEGMENT, id, name: 'Beta seven', filter: TREE_BETA },
      ),
      previewSegment: vi.fn(() => gate.promise),
    })
    renderLiveBuilder(client, segmentEditPath(7))
    await screen.findByTestId('condition-0')
    await userEvent.click(screen.getByRole('button', { name: /^run$/i }))
    await waitFor(() => expect(client.previewSegment).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('Beta seven'))

    await act(async () => {
      gate.resolve(PREVIEW)
    })
    expect(screen.queryByTestId('segment-preview-count')).toBeNull()
  })

  // The ONLY continuation now deliberately left unguarded, pinned so a later
  // tidy-up cannot wrap it in silence: a 401 reports a DEAD SESSION, which is
  // true whichever segment is on screen. Dropped, it would leave the operator
  // typing into a form whose every request will 401.
  //
  // It was the second of two until #122 narrowed the create navigation. That
  // change prompted re-checking this one rather than assuming it: the
  // distinction that survives is between a fact about the SESSION, which must
  // reach the operator wherever they are, and a fact about a FORM, which must
  // not outlive the form it is about. This is the former, and this test is on
  // an EDIT route, where the form generation genuinely does bump -- so it
  // pins unguardedness rather than passing because nothing changed.
  it('a 401 from a save abandoned by a project switch still reports the dead session', async () => {
    const onUnauthorized = vi.fn()
    const { client, renames } = gatedSaveClient()
    renderLiveBuilder(client, segmentEditPath(7), onUnauthorized)
    await screen.findByTestId('condition-0')
    await userEvent.clear(screen.getByLabelText(/name/i))
    await userEvent.type(screen.getByLabelText(/name/i), 'Renamed')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(client.renameSegment).toHaveBeenCalledTimes(1))

    await userEvent.click(screen.getByRole('button', { name: /switch project/i }))
    await waitFor(() => expect(screen.getByLabelText(/name/i)).toHaveValue('Beta seven'))

    await act(async () => {
      renames[0]?.reject(new ApiError(401, 'unauthorized'))
    })

    expect(onUnauthorized).toHaveBeenCalled()
  })
})
